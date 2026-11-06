#!/usr/bin/env node
// The real console API over a throwaway database of demonstration data, for frontend work without
// the gate, Switch or GitHub. Run `npm run build` first, then `npm run console-api:mock`.
//   --examples <dir>   write one example JSON file per endpoint to <dir> and exit
// A new audit event is added every 10 s, so polling has something to find.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import Database from "better-sqlite3";
import { migrate, openDatabase } from "../apps/switch-gate/dist/persistence/db.js";
import { startConsoleServer } from "../apps/console-api/dist/server.js";
import { loadConsoleConfig } from "../apps/console-api/dist/config.js";
import { recordGateSettings } from "../apps/switch-gate/dist/persistence/settings.js";
import { appendMockEvent, seedConsoleData } from "./console-seed.mjs";

// A fixed value, so the frontend's dev settings stay simple. It guards only this mock's fake data.
const MOCK_TOKEN = "loopback-console-mock-token-not-a-secret";
const dir = mkdtempSync(join(tmpdir(), "loopback-console-mock-"));
const dbPath = join(dir, "mock.db");
const db = openDatabase(dbPath);
migrate(db);
seedConsoleData(db);
// What a gate started from .env.example records: merging and privileged commands off, isolation not proven.
recordGateSettings(db, {
  repo: "puneetnith28/loopback-demo-target", baseBranch: "main", requiredChecks: ["test"], verificationMode: "advisory",
  safety: { mergeEnabled: false, privilegedEnabled: false, verifierIsolationProven: false },
  quorum: 1, gateMention: "@loopback-gate", pollIntervalMs: 30_000, verifyTimeoutMs: 1_800_000, fixTimeoutMs: 2_700_000,
});

const examplesAt = process.argv.indexOf("--examples");
const port = Number(process.env.CONSOLE_API_PORT ?? (examplesAt >= 0 ? 8799 : 8788));
const cfg = loadConsoleConfig({
  CONSOLE_DB_PATH: dbPath, CONSOLE_API_TOKEN: MOCK_TOKEN, CONSOLE_API_PORT: String(port),
  CONSOLE_ALLOWED_ORIGIN: process.env.CONSOLE_ALLOWED_ORIGIN ?? "http://localhost:5173", CONSOLE_GATE_HTTP_PORT: "1",
});
// Fixed clock in example mode, so regenerating the examples produces no diff.
const server = await startConsoleServer(cfg, examplesAt >= 0 ? { now: () => new Date("2026-11-04T12:30:00.000Z") } : {});
const cleanup = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };

if (examplesAt >= 0) {
  const out = process.argv[examplesAt + 1];
  if (!out) { process.stderr.write("usage: console-mock.mjs --examples <dir>\n"); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const fixedTimes = (body) => (body.checkedAt ? { ...body, checkedAt: "2026-11-04T12:30:00.000Z" } : body);
  const paths = {
    meta: "meta", summary: "summary", gate: "gate", "config-summary": "config/summary", cases: "cases?limit=3", "cases-page-2": "cases?limit=3&cursor=5", "cases-blocked": "cases?state=Blocked",
    case: "cases/LB-001", "case-stale": "cases/LB-003", "case-hostile-report": "cases/LB-005",
    commits: "cases/LB-003/commits", "verification-runs": "cases/LB-001/verification-runs", checks: "cases/LB-001/checks",
    approvals: "cases/LB-003/approvals", "merge-operations": "cases/LB-007/merge-operations", "case-audit": "cases/LB-001/audit", audit: "audit?limit=5", "audit-poll": "audit?after=20&limit=5", activity: "activity?limit=5",
  };
  for (const [name, path] of Object.entries(paths)) {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/${path}`, { headers: { authorization: `Bearer ${MOCK_TOKEN}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify(fixedTimes(body), null, 2)}\n`);
  }
  const fixedId = (b) => ({ error: { ...b.error, requestId: "00000000-0000-4000-8000-000000000000" } });
  const errors = { "error-unauthorized": [`http://127.0.0.1:${port}/api/v1/summary`, {}], "error-not-found": [`http://127.0.0.1:${port}/api/v1/cases/LB-999`, { authorization: `Bearer ${MOCK_TOKEN}` }], "error-bad-request": [`http://127.0.0.1:${port}/api/v1/cases?limit=9999`, { authorization: `Bearer ${MOCK_TOKEN}` }] };
  for (const [name, [url, headers]] of Object.entries(errors)) {
    const res = await globalThis.fetch(url, { headers });
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify(fixedId(await res.json()), null, 2)}\n`);
  }
  server.close();
  server.closeAllConnections();
  cleanup();
  process.stdout.write(`examples written to ${out}\n`);
} else {
  const writer = new Database(dbPath);
  const timer = setInterval(() => appendMockEvent(writer), 10_000);
  const stop = () => { clearInterval(timer); writer.close(); server.close(); server.closeAllConnections(); cleanup(); process.exit(0); };
  for (const s of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(s, stop);
  process.stdout.write(`mock console API on http://127.0.0.1:${port}/api/v1 (fake data)\n  Authorization: Bearer ${MOCK_TOKEN}\n  allowed browser origin: ${cfg.allowedOrigin}\n`);
}
