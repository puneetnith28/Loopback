import { createGate, type Gate } from "./app.js";
import { ConfigError, loadGitHubConfig, loadIdentityConfig, loadRuntimeConfig, loadSwitchConfig } from "./config.js";
import { startHealthServer } from "./observability/health.js";
import { createLogger } from "./observability/logger.js";
import type { OpenSocket, SocketLike, StopReason } from "./switch/connection.js";
import { discoverOperations } from "./switch/ops.js";
import { policyExpectationOf, preflight, readinessChecks, watchPolicy } from "./startup.js";
import { verifyAddressingPolicy } from "./switch/policy-check.js";
import { Rooms } from "./switch/rooms.js";
import { StoredConnectionError } from "./switch/store.js";

// Entry point (`npm run gate`). Startup order: validate config -> confirm the Switch
// addressing policy -> discover the required Switch operations -> open and migrate the
// database -> reconcile interrupted merges and open cases -> start polling -> connect to
// both rooms (one connection each, D26) -> serve /healthz and /readyz on 127.0.0.1.
//
// Exit codes: 0 clean shutdown, 1 configuration or startup error, 3 a Switch connection
// stopped for good (taken over, refused, room lost, retries exhausted), 4 the gate's
// Switch addressing policy is not the expected one, 5 a required Switch operation is
// missing. Exit code 3 needs an operator: restarting automatically after a takeover
// would be refused by the fenced reattach anyway, and must not be "fixed" by clearing state.

const log = createLogger(process.env.LOG_LEVEL ?? "info");
const CLIENT_VERSION = "0.1.0";
const EXIT_SWITCH_STOPPED = 3;
const EXIT_POLICY_MISMATCH = 4;
const EXIT_OPERATIONS_MISSING = 5;
const POLICY_RECHECK_MS = 60_000;
const POLICY_MAX_UNREADABLE = 3;

/** Node's global WebSocket (undici) accepts request headers as a non-standard init option. */
const openSocket: OpenSocket = (url, headers) => {
  const WS = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => SocketLike;
  return new WS(url, { headers: { ...headers } });
};

function loadConfig() {
  return {
    runtime: loadRuntimeConfig(process.env),
    switch: loadSwitchConfig(process.env),
    identity: loadIdentityConfig(process.env),
    github: loadGitHubConfig(process.env),
  };
}

async function main(): Promise<number> {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (e) {
    log.fatal({ op: "config" }, e instanceof ConfigError ? e.message : "configuration could not be loaded");
    return 1;
  }

  // `addressed === true` is trusted only while Switch enforces the expected policy, so
  // nothing starts (no database work, no polling, no connection) until it is confirmed.
  let policy: Awaited<ReturnType<typeof preflight>>;
  try {
    policy = await preflight(cfg, globalThis.fetch);
  } catch (e) {
    log.fatal({ op: "config" }, e instanceof ConfigError ? e.message : "identity configuration is invalid");
    return 1;
  }
  if (!policy.ok) {
    log.fatal({ op: "switch.policy", result: "mismatch" }, `Refusing to start: the gate's Switch addressing policy is not the expected one (${policy.reason}).`);
    return EXIT_POLICY_MISMATCH;
  }
  log.info({ op: "switch.policy", result: "ok" }, "Switch addressing policy matches the expected restrictive policy");

  const sw = cfg.switch;
  const switchHttp = { bridgeUrl: sw.bridgeUrl, agentId: sw.agentId, apiKey: sw.apiKey, fetch: globalThis.fetch };

  // Step 3.6: refuse to start without the operations the gate depends on.
  const ops = await discoverOperations(switchHttp);
  if (!ops.ok) {
    log.fatal({ op: "switch.ops", missing: ops.missing }, `Refusing to start: ${ops.reason}.`);
    return EXIT_OPERATIONS_MISSING;
  }

  const rooms = new Rooms({
    ...switchHttp, selfId: sw.selfId, clientVersion: CLIENT_VERSION, openSocket,
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

  try {
    gate = createGate(cfg, rooms.chat, log);
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
    await g.start();
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
    policyWatch?.stop();
    await rooms.stop().catch(() => undefined);
    await rooms.drained().catch(() => undefined);
    gate?.stop();
    return 1;
  }

  const shutdown = () => { void rooms.stop(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const reason = await stopped;
  policyWatch?.stop();
  health.close();
  // Let handlers that are already running finish before the database closes.
  await rooms.drained();
  gate.stop();
  if (reason.code === "stopped") return 0;
  if (reason.code === "policy_mismatch") {
    log.fatal({ op: "switch.policy", result: "mismatch" }, reason.detail);
    return EXIT_POLICY_MISMATCH;
  }
  log.fatal({ op: "switch.stop", code: reason.code }, `Switch connection stopped for good: ${reason.detail}. Operator action required.`);
  return EXIT_SWITCH_STOPPED;
}

process.exitCode = await main();
