import { createLogger } from "./observability/logger.js";
import { gracefulSignals, runGate } from "./run.js";
import type { OpenSocket, SocketLike } from "./switch/connection.js";

// Entry point (`npm run gate`): the real process wiring for the lifecycle in run.ts, which
// documents the startup order and exit codes. Signal handlers are installed by runGate before
// any startup work; a shutdown that hangs past its timeout exits with code 1.

const log = createLogger(process.env.LOG_LEVEL ?? "info");

/** Node's global WebSocket (undici) accepts request headers as a non-standard init option. */
const openSocket: OpenSocket = (url, headers) => {
  const WS = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => SocketLike;
  return new WS(url, { headers: { ...headers } });
};

const code = await runGate({
  env: process.env,
  fetch: globalThis.fetch,
  openSocket,
  log,
  signals: process,
  onShutdownTimeout: () => process.exit(1),
});

process.exitCode = code;

// runGate has removed its handlers and finished its teardown. A repeated signal arriving while
// the process winds down exits with the recorded code rather than a signal death, and if some
// handle keeps the event loop alive, the process still exits after 5 s with that code.
const exitNow = () => process.exit(code);
for (const signal of gracefulSignals()) process.on(signal, exitNow);
setTimeout(exitNow, 5_000).unref();
