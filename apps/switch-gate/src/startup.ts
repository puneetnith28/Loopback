import { assertIdentityConsistency, type IdentityConfig, type SwitchConfig } from "./config.js";
import { assertAdmissionPolicy, type AdmissionPolicy } from "./policy/admission.js";
import { verifyAddressingPolicy, type PolicyCheck, type PolicyExpectation } from "./switch/policy-check.js";

/** Admission inputs derived from validated configuration (one place, so every caller agrees). */
export function admissionPolicyOf(cfg: { readonly switch: SwitchConfig; readonly identity: IdentityConfig }): AdmissionPolicy {
  return {
    selfId: cfg.switch.selfId, fixerId: cfg.identity.fixerId, verifierId: cfg.identity.verifierId,
    gateMention: cfg.switch.gateMention, maintainerRoomId: cfg.switch.roomId, intakeRoomId: cfg.switch.intakeRoomId,
  };
}

/** The two-rule addressing policy the gate requires (D26). */
export function policyExpectationOf(sw: SwitchConfig): PolicyExpectation {
  return { maintainerRoomId: sw.roomId, intakeRoomId: sw.intakeRoomId, userIds: sw.policyUserIds, agentIds: sw.policyAgentIds };
}

/**
 * Startup preflight, run before the gate opens its database, polls GitHub or connects
 * to Switch. Order matters: local identity checks first (no network), then the live
 * Switch addressing policy, which admission relies on (`addressed === true`).
 * Throws ConfigError / Error on bad local configuration; returns the policy result.
 */
export async function preflight(
  cfg: { readonly switch: SwitchConfig; readonly identity: IdentityConfig },
  fetchImpl: typeof fetch,
): Promise<PolicyCheck> {
  assertIdentityConsistency(cfg.switch, cfg.identity);
  assertAdmissionPolicy(admissionPolicyOf(cfg));
  return verifyAddressingPolicy(
    { bridgeUrl: cfg.switch.bridgeUrl, agentId: cfg.switch.agentId, apiKey: cfg.switch.apiKey, fetch: fetchImpl },
    policyExpectationOf(cfg.switch),
  );
}

export interface PolicyWatchOptions {
  readonly check: () => Promise<PolicyCheck>;
  readonly intervalMs: number;
  /** Consecutive unreadable results tolerated before failing closed. */
  readonly maxUnreadable: number;
  /** Called once, when the policy is wrong or has been unreadable too long. */
  readonly onFail: (reason: string) => void;
  readonly onUnreadable?: (reason: string, consecutive: number) => void;
}

/**
 * Re-check the policy while the gate runs, so a policy widened after startup stops the
 * gate instead of being trusted. A policy read and found wrong fails at once; a policy
 * that cannot be read fails after `maxUnreadable` consecutive attempts.
 */
export function watchPolicy(o: PolicyWatchOptions): { stop(): void } {
  let unreadable = 0;
  let done = false;
  let running = false;
  const tick = async () => {
    if (done || running) return;
    running = true;
    try {
      const r = await o.check();
      if (done) return;
      if (r.ok) {
        unreadable = 0;
        return;
      }
      if (r.unreadable) {
        unreadable += 1;
        o.onUnreadable?.(r.reason, unreadable);
        if (unreadable < o.maxUnreadable) return;
      }
      done = true;
      clearInterval(timer);
      o.onFail(r.reason);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, o.intervalMs);
  return {
    stop() {
      done = true;
      clearInterval(timer);
    },
  };
}

/** What readiness needs to know about one room's connection. */
export interface ConnectionView {
  /** A label for the readiness report ("maintainers", "intake"); never an id. */
  readonly name: string;
  readonly connection: unknown;
  readonly lastHeartbeatAt: number | null;
  readonly stopped: boolean;
}

export interface ReadinessInputs {
  readonly connections: readonly ConnectionView[];
  /** The startup operation discovery succeeded (step 3.6). */
  readonly operationsReady: () => boolean;
  /** Core GitHub requests left for the installation. */
  readonly githubRemaining: () => Promise<number>;
  readonly halted: () => boolean;
  readonly now?: () => number;
  /** Switch pings every 2 s and lapses a connection after 6 s without a beat. */
  readonly heartbeatMaxAgeMs?: number;
  /** How long a GitHub answer is reused, so /readyz polling does not hammer the API. */
  readonly githubCacheMs?: number;
  /** How long a failed GitHub check is reused (default 5 s). */
  readonly githubFailureCacheMs?: number;
}

/** A readiness check: a name (no details) and a boolean. */
export interface ReadyCheck {
  readonly name: string;
  readonly check: () => Promise<boolean>;
}

/** Readiness for /readyz (step 9.5). Names only; failure details stay in the logs. */
export function readinessChecks(i: ReadinessInputs): ReadyCheck[] {
  const now = i.now ?? (() => Date.now());
  const maxAge = i.heartbeatMaxAgeMs ?? 6000;
  const cacheMs = i.githubCacheMs ?? 30_000;
  // A failed check is re-tried sooner, so readiness recovers quickly after a blip.
  const failureCacheMs = Math.min(cacheMs, i.githubFailureCacheMs ?? 5_000);
  let cached: { at: number; ok: boolean } | null = null;
  const checks: ReadyCheck[] = i.connections.map((c) => ({
    name: `switch-${c.name}`,
    check: () => Promise.resolve(!c.stopped && c.connection !== null && c.lastHeartbeatAt !== null && now() - c.lastHeartbeatAt <= maxAge),
  }));
  checks.push(
    { name: "switch-operations", check: () => Promise.resolve(i.operationsReady()) },
    {
      name: "github",
      check: async () => {
        if (cached !== null && now() - cached.at < (cached.ok ? cacheMs : failureCacheMs)) return cached.ok;
        let ok: boolean;
        try {
          ok = (await i.githubRemaining()) > 0;
        } catch {
          ok = false;
        }
        cached = { at: now(), ok };
        return ok;
      },
    },
    { name: "not-halted", check: () => Promise.resolve(!i.halted()) },
  );
  return checks;
}
