import { createLogger } from "./observability/logger.js";
import { runGate } from "./run.js";
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

process.exitCode = await runGate({
  env: process.env,
  fetch: globalThis.fetch,
  openSocket,
  log,
  signals: process,
  onShutdownTimeout: () => process.exit(1),
});

// runGate has removed its handlers; a repeated signal arriving while the process winds down
// must not replace the exit code with a signal death. Listeners do not keep the process alive.
const ignoreLateSignal = () => undefined;
process.on("SIGTERM", ignoreLateSignal);
process.on("SIGINT", ignoreLateSignal);
