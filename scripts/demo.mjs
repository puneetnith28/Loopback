#!/usr/bin/env node
// A rehearsal of the whole flow with no accounts: one bug from report to merge, with the attacks and
// mistakes the gate exists to stop. Run `npm run build` first.
//
//   npm run demo            the transcript, at reading speed
//   npm run demo:fast       the same, with no pauses
//   npm run demo:console    the transcript, then the evidence console's API over the same case
//
// The gate's decisions, audit log and signatures are the real code. Switch's delivery, GitHub and the
// agents are simulated, and it says so. Exit code 1 if any expected outcome did not happen.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "apps/switch-gate/dist/demo/rehearsal.js"))) {
  process.stderr.write("Nothing is built yet. Run: npm ci && npm run build\n");
  process.exit(2);
}
const { runRehearsal } = await import("../apps/switch-gate/dist/demo/rehearsal.js");

const args = new Set(process.argv.slice(2));
const dir = join(root, "data", "demo");
const dbPath = join(dir, "rehearsal.db");
mkdirSync(dir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });

const { passed, db } = await runRehearsal({
  dbPath,
  print: (line) => process.stdout.write(`${line}\n`),
  color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  ...(args.has("--fast") ? {} : { pause: () => sleep(1500) }),
});
db.close();
if (!passed) process.exit(1);

if (!args.has("--console")) {
  process.stdout.write("\nSee this case in the evidence console: npm run demo:console\n");
  process.exit(0);
}

const { startConsoleServer } = await import("../apps/console-api/dist/server.js");
const { loadConsoleConfig } = await import("../apps/console-api/dist/config.js");
// A fixed value, the same as the console mock's. It guards only this rehearsal's fake data.
const TOKEN = "loopback-console-mock-token-not-a-secret";
const cfg = loadConsoleConfig({
  CONSOLE_DB_PATH: dbPath, CONSOLE_API_TOKEN: TOKEN, CONSOLE_API_PORT: process.env.CONSOLE_API_PORT ?? "8788",
  CONSOLE_ALLOWED_ORIGIN: "http://localhost:5173", CONSOLE_GATE_HTTP_PORT: "1",
});
const server = await startConsoleServer(cfg);
process.stdout.write(`\nThe console API is serving this rehearsal's case on http://127.0.0.1:${cfg.port}/api/v1\nIn a second terminal: npm run dev --workspace apps/console\nThen open http://localhost:5173/ and choose LB-001. Ctrl+C here to stop.\n`);
const stop = () => { server.close(); server.closeAllConnections(); process.exit(0); };
for (const s of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(s, stop);
