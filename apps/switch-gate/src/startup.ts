import { assertIdentityConsistency, type IdentityConfig, type SwitchConfig } from "./config.js";
import { assertAdmissionPolicy } from "./policy/admission.js";
import { verifyAddressingPolicy, type PolicyCheck } from "./switch/policy-check.js";

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
  assertAdmissionPolicy({
    selfId: cfg.switch.selfId, fixerId: cfg.identity.fixerId, verifierId: cfg.identity.verifierId, gateMention: cfg.switch.gateMention,
  });
  return verifyAddressingPolicy(
    { bridgeUrl: cfg.switch.bridgeUrl, agentId: cfg.switch.agentId, apiKey: cfg.switch.apiKey, fetch: fetchImpl },
    { roomId: cfg.switch.roomId, userIds: cfg.switch.policyUserIds, agentIds: cfg.switch.policyAgentIds },
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
