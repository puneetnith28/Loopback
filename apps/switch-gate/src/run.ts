import type { Logger } from "pino";
import { createGate, type Gate, type GateConfig } from "./app.js";
import { ConfigError, loadGitHubConfig, loadIdentityConfig, loadRuntimeConfig, loadSwitchConfig, type Env } from "./config.js";
import type { GitHubClient } from "./github/client.js";
import { startHealthServer } from "./observability/health.js";
import { policyExpectationOf, preflight, readinessChecks, watchPolicy } from "./startup.js";
import type { OpenSocket, StopReason } from "./switch/connection.js";
import { discoverOperations } from "./switch/ops.js";
import { verifyAddressingPolicy } from "./switch/policy-check.js";
import { Rooms } from "./switch/rooms.js";
import { StoredConnectionError } from "./switch/store.js";

// The gate's lifecycle (`npm run gate` via main.ts). Startup order: install signal handlers
// -> validate config -> confirm the Switch addressing policy -> discover the required Switch
// operations -> open and migrate the database -> reconcile interrupted merges and open cases
// -> start polling -> connect to both rooms (one connection each, D26) -> serve /healthz and
// /readyz on 127.0.0.1.
//
// Exit codes: 0 clean shutdown (also when a signal arrives during startup), 1 configuration
// or startup error, 3 a Switch connection stopped for good (taken over, refused, room lost,
// retries exhausted), 4 the gate's Switch addressing policy is not the expected one, 5 a
// required Switch operation is missing. Exit code 3 needs an operator: restarting
// automatically after a takeover would be refused by the fenced reattach anyway, and must
// not be "fixed" by clearing state.

export const CLIENT_VERSION = "0.1.0";
export const EXIT_OK = 0;
export const EXIT_STARTUP = 1;
export const EXIT_SWITCH_STOPPED = 3;
export const EXIT_POLICY_MISMATCH = 4;
export const EXIT_OPERATIONS_MISSING = 5;
const POLICY_RECHECK_MS = 60_000;
const POLICY_MAX_UNREADABLE = 3;
/** A shutdown that has not finished by then is reported, and main.ts exits (step 9.7). */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export type Signal = "SIGTERM" | "SIGINT";
const SIGNALS: readonly Signal[] = ["SIGTERM", "SIGINT"];

/** What the lifecycle needs from its process; main.ts passes `process` and the real I/O. */
export interface RunDeps {
  readonly env: Env;
  readonly fetch: typeof fetch;
  readonly openSocket: OpenSocket;
  readonly log: Logger;
  readonly signals: {
    on(signal: Signal, listener: () => void): unknown;
    off(signal: Signal, listener: () => void): unknown;
  };
  /** Called once if shutdown has not completed within `shutdownTimeoutMs`. */
  readonly onShutdownTimeout?: () => void;
  readonly shutdownTimeoutMs?: number;
  /** Tests only: a fake GitHub reader in place of the App-authenticated client. */
  readonly github?: GitHubClient;
}

/** Run one step of cleanup; a failure is logged and never stops the remaining steps. */
async function attempt(log: Logger, op: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error({ op, err: e instanceof Error ? e.name : "unknown" }, "shutdown step failed; continuing");
  }
}

export async function runGate(d: RunDeps): Promise<number> {
  const { log } = d;

  // Signal handlers come first, so a signal during any startup stage (preflight, migration,
  // reconciliation) is honoured at the next stage boundary instead of killing the process
  // mid-write. A second signal changes nothing; a shutdown that hangs is reported.
  let shuttingDown = false;
  let stopRooms: () => void = () => undefined;
  let timeout: NodeJS.Timeout | undefined;
  const onSignal = (signal: Signal) => {
    if (shuttingDown) {
      log.warn({ op: "shutdown", signal }, "already shutting down");
      return;
    }
    shuttingDown = true;
    log.info({ op: "shutdown", signal }, "shutting down");
    timeout = setTimeout(() => {
      log.fatal({ op: "shutdown", timeoutMs: d.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS }, "shutdown did not finish in time");
      d.onShutdownTimeout?.();
    }, d.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    timeout.unref(); // never the reason the process stays alive
    stopRooms();
  };
  const listeners = SIGNALS.map((s) => [s, () => onSignal(s)] as const);
  for (const [s, fn] of listeners) d.signals.on(s, fn);
  try {
    return await lifecycle();
  } finally {
    for (const [s, fn] of listeners) d.signals.off(s, fn);
    if (timeout !== undefined) clearTimeout(timeout);
  }

  async function lifecycle(): Promise<number> {
    let cfg: GateConfig;
    try {
      cfg = {
        runtime: loadRuntimeConfig(d.env), switch: loadSwitchConfig(d.env),
        identity: loadIdentityConfig(d.env), github: loadGitHubConfig(d.env),
      };
    } catch (e) {
      log.fatal({ op: "config" }, e instanceof ConfigError ? e.message : "configuration could not be loaded");
      return EXIT_STARTUP;
    }

    // `addressed === true` is trusted only while Switch enforces the expected policy, so
    // nothing starts (no database work, no polling, no connection) until it is confirmed.
    let policy: Awaited<ReturnType<typeof preflight>>;
    try {
      policy = await preflight(cfg, d.fetch);
    } catch (e) {
      log.fatal({ op: "config" }, e instanceof ConfigError ? e.message : "identity configuration is invalid");
      return EXIT_STARTUP;
    }
    if (!policy.ok) {
      log.fatal({ op: "switch.policy", result: "mismatch" }, `Refusing to start: the gate's Switch addressing policy is not the expected one (${policy.reason}).`);
      return EXIT_POLICY_MISMATCH;
    }
    log.info({ op: "switch.policy", result: "ok" }, "Switch addressing policy matches the expected restrictive policy");

    const sw = cfg.switch;
    const switchHttp = { bridgeUrl: sw.bridgeUrl, agentId: sw.agentId, apiKey: sw.apiKey, fetch: d.fetch };

    // Step 3.6: refuse to start without the operations the gate depends on.
    const ops = await discoverOperations(switchHttp);
    if (!ops.ok) {
      log.fatal({ op: "switch.ops", missing: ops.missing }, `Refusing to start: ${ops.reason}.`);
      return EXIT_OPERATIONS_MISSING;
    }
    if (shuttingDown) return EXIT_OK; // nothing opened yet

    const rooms = new Rooms({
      ...switchHttp, selfId: sw.selfId, clientVersion: CLIENT_VERSION, openSocket: d.openSocket,
      rooms: [{ name: "maintainers", roomId: sw.roomId }, { name: "intake", roomId: sw.intakeRoomId }],
      maintainerRoomId: sw.roomId, gateMention: sw.gateMention,
      agentIds: new Set([cfg.identity.fixerId, cfg.identity.verifierId]),
      log: { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) },
    });

    let gate: Gate | null = null;
    let resolveStopped: (r: StopReason) => void = () => undefined;
    const stopped = new Promise<StopReason>((resolve) => { resolveStopped = resolve; });
    let policyWatch: { stop(): void } | undefined;
    let health: Awaited<ReturnType<typeof startHealthServer>> | undefined;

    /** Tear down whatever exists, in dependency order; every step runs even if one fails. */
    const teardown = async () => {
      await attempt(log, "shutdown.policy", () => policyWatch?.stop());
      await attempt(log, "shutdown.health", () => health?.close());
      await attempt(log, "shutdown.rooms", () => rooms.stop());
      // Let handlers that are already running finish before the database closes.
      await attempt(log, "shutdown.handlers", () => rooms.drained());
      await attempt(log, "shutdown.background", () => gate?.drain());
      await attempt(log, "shutdown.database", () => gate?.stop());
    };

    try {
      gate = createGate(cfg, rooms.chat, log, d.github ? { github: d.github } : {});
      const g = gate;
      rooms.bind({
        db: g.db,
        handle: (msg) => g.router.handle(msg),
        reconcile: () => g.reconcileNow(),
        onStop: (reason) => {
          // A failed policy check halts privileged work at its next write boundary, before
          // anything else runs. A graceful stop does not: in-flight work finishes normally.
          if (reason.code === "policy_mismatch") g.halt.halt(reason.detail);
          resolveStopped(reason);
        },
      });
      stopRooms = () => { void rooms.stop(); };
      await g.start();
      if (shuttingDown) {
        // A signal arrived during startup reconciliation: stop before connecting to Switch.
        await teardown();
        return EXIT_OK;
      }
      rooms.start();
      // The policy is trusted only while it stays the expected one: re-check it while running.
      policyWatch = watchPolicy({
        check: () => verifyAddressingPolicy(switchHttp, policyExpectationOf(sw)),
        intervalMs: POLICY_RECHECK_MS,
        maxUnreadable: POLICY_MAX_UNREADABLE,
        onUnreadable: (reason, n) => log.warn({ op: "switch.policy", consecutive: n }, `addressing policy check failed: ${reason}`),
        onFail: (reason) => rooms.policyMismatch(`the Switch addressing policy is no longer the expected one (${reason})`),
      });
      health = await startHealthServer({
        port: cfg.runtime.httpPort,
        live: () => g.db.prepare("SELECT 1 AS ok").get() !== undefined,
        ready: readinessChecks({
          connections: rooms.rooms.map((r) => ({
            name: r.spec.name,
            get connection() { return r.connection.connection; },
            get lastHeartbeatAt() { return r.connection.lastHeartbeatAt; },
            get stopped() { return r.connection.stopped; },
          })),
          operationsReady: () => ops.ok,
          githubRemaining: () => g.github.rateLimitRemaining(),
          halted: () => g.halt.halted,
        }),
      });
    } catch (e) {
      // Only messages written by the gate itself are logged verbatim; others are named, not quoted.
      const known = e instanceof StoredConnectionError || e instanceof ConfigError;
      log.fatal({ op: "startup", err: e instanceof Error ? e.name : "unknown" }, known ? e.message : "startup failed");
      await teardown();
      return EXIT_STARTUP;
    }

    const reason = await stopped;
    await teardown();
    if (reason.code === "stopped") return EXIT_OK;
    if (reason.code === "policy_mismatch") {
      log.fatal({ op: "switch.policy", result: "mismatch" }, reason.detail);
      return EXIT_POLICY_MISMATCH;
    }
    log.fatal({ op: "switch.stop", code: reason.code }, `Switch connection stopped for good: ${reason.detail}. Operator action required.`);
    return EXIT_SWITCH_STOPPED;
  }
}
