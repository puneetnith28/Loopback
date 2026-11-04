import { createGate, type Gate } from "./app.js";
import { ConfigError, loadGitHubConfig, loadIdentityConfig, loadRuntimeConfig, loadSwitchConfig } from "./config.js";
import { createLogger } from "./observability/logger.js";
import { SwitchChat } from "./switch/chat.js";
import { SwitchConnection, type OpenSocket, type SocketLike, type StopReason } from "./switch/connection.js";
import { StoredConnectionError, sqliteConnectionStore } from "./switch/store.js";

// Entry point (`npm run gate`). Startup order: validate config -> open and migrate the
// database -> reconcile interrupted merges -> start polling -> connect to Switch.
//
// Exit codes: 0 clean shutdown, 1 configuration or startup error, 3 the Switch
// connection stopped for good (taken over, refused, room lost, retries exhausted).
// Exit code 3 needs an operator: restarting automatically after a takeover would be
// refused by the fenced reattach anyway, and must not be "fixed" by clearing state.

const log = createLogger(process.env.LOG_LEVEL ?? "info");
const CLIENT_VERSION = "0.1.0";
const EXIT_SWITCH_STOPPED = 3;

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

  // The chat transport needs the connection and the connection hands messages to the
  // router, so the router is bound once the gate exists.
  let gate: Gate | null = null;
  let resolveStopped: (r: StopReason) => void = () => undefined;
  const stopped = new Promise<StopReason>((resolve) => { resolveStopped = resolve; });

  let connection: SwitchConnection | null = null;
  const chat = new SwitchChat({
    bridgeUrl: cfg.switch.bridgeUrl, agentId: cfg.switch.agentId, apiKey: cfg.switch.apiKey,
    roomId: cfg.switch.roomId, fetch: globalThis.fetch,
    connection: {
      get connection() { return connection?.connection ?? null; },
      get stopped() { return connection?.stopped ?? false; },
      takenOver: (detail) => { connection?.takenOver(detail); },
    },
  });

  try {
    gate = createGate(cfg, chat, log);
    connection = new SwitchConnection({
      bridgeUrl: cfg.switch.bridgeUrl, agentId: cfg.switch.agentId, apiKey: cfg.switch.apiKey,
      roomId: cfg.switch.roomId, clientVersion: CLIENT_VERSION, openSocket, fetch: globalThis.fetch,
      store: sqliteConnectionStore(gate.db),
      onMessage: async (msg) => {
        if (msg.sender === cfg.switch.selfId) return; // the gate's own messages echo back
        await gate?.router.handle(msg);
      },
      onStop: resolveStopped,
      log: { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) },
    });
    await gate.start();
    connection.start();
  } catch (e) {
    // Only messages written by the gate itself are logged verbatim; others are named, not quoted.
    const known = e instanceof StoredConnectionError || e instanceof ConfigError;
    log.fatal({ op: "startup", err: e instanceof Error ? e.name : "unknown" }, known ? e.message : "startup failed");
    gate?.stop();
    return 1;
  }

  const shutdown = () => { void connection?.stop(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const reason = await stopped;
  // Let a handler that is already running finish before the database closes.
  await connection.drained();
  gate.stop();
  if (reason.code === "stopped") return 0;
  log.fatal({ op: "switch.stop", code: reason.code }, `Switch connection stopped for good: ${reason.detail}. Operator action required.`);
  return EXIT_SWITCH_STOPPED;
}

process.exitCode = await main();
