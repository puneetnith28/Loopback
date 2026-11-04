import { ConsoleConfigError, loadConsoleConfig } from "./config.js";
import { startConsoleServer } from "./server.js";

// Entry point (`npm run console-api`). A separate process from the gate, started with its own
// environment. Exit codes: 0 clean shutdown, 1 configuration or startup error.

const write = (line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(line)}\n`); };

try {
  const cfg = loadConsoleConfig(process.env);
  const server = await startConsoleServer(cfg, { log: write });
  write({ op: "listening", address: `http://127.0.0.1:${cfg.port}`, allowedOrigin: cfg.allowedOrigin });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections(); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.on(signal, stop);
} catch (e) {
  write({ op: "startup_failed", message: e instanceof ConsoleConfigError ? e.message : "could not start the console API" });
  process.exitCode = 1;
}
