import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiError, ApprovalListResponse, AuditPageResponse, CaseDetail, CaseListResponse, CiListResponse, CommitListResponse, GateStatusResponse, HealthResponse, MergeListResponse, MetaResponse, SummaryResponse, VerificationListResponse,
} from "@loopback/console-contracts";
import { ConsoleConfigError, loadConsoleConfig, type ConsoleConfig } from "../../apps/console-api/src/config.js";
import { githubUrlOrNull, sanitize } from "../../apps/console-api/src/sanitize.js";
import { startConsoleServer } from "../../apps/console-api/src/server.js";
import { EXPECTED_SCHEMA_VERSION } from "../../apps/console-api/src/store.js";
import { MIGRATIONS } from "../../apps/switch-gate/src/persistence/migrations.js";
import { migrate, openDatabase } from "../../apps/switch-gate/src/persistence/db.js";
import { seedConsoleData, sha } from "../../scripts/console-seed.mjs";

// The read-only console API against a real SQLite database with the gate's real schema.

const TOKEN = "t".repeat(40);
const ORIGIN = "http://localhost:5173";

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  await new Promise<void>((r) => srv.close(() => r()));
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  return addr.port;
}

let dir = "";
let dbPath = "";
let server: Server;
let cfg: ConsoleConfig;
const logs: Record<string, unknown>[] = [];

const url = (path: string) => `http://127.0.0.1:${cfg.port}/api/v1/${path}`;
const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, method = "GET") => fetch(url(path), { method, headers });
async function ok<T extends z.ZodType>(schema: T, path: string): Promise<z.output<T>> {
  const res = await get(path);
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return schema.parse(body);
}
async function refused(res: Response, status: number, code: string): Promise<void> {
  const body = ApiError.parse(await res.json());
  expect(res.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "loopback-console-"));
  dbPath = join(dir, "gate.db");
  const db = openDatabase(dbPath);
  migrate(db);
  seedConsoleData(db);
  // A credential that should never have reached the audit log, in a key and in a value.
  db.prepare("INSERT INTO audit_events (case_id, actor_id, event_type, payload_json, created_at) VALUES ('LB-002', 'system', 'policy.violation', ?, ?)")
    .run(JSON.stringify({ apiToken: "abc", capability: "x", note: "seen ghp_0123456789abcdefghij and lbcap1.aaa.bbb here", signature: "c2lnbmF0dXJl", nested: { privateKey: "k", ok: 1 } }), "2026-11-04T13:00:00.000Z");
  db.close();
  cfg = loadConsoleConfig({ CONSOLE_DB_PATH: dbPath, CONSOLE_API_TOKEN: TOKEN, CONSOLE_API_PORT: String(await freePort()), CONSOLE_ALLOWED_ORIGIN: ORIGIN, CONSOLE_GATE_HTTP_PORT: String(await freePort()) });
  server = await startConsoleServer(cfg, { log: (l) => logs.push(l) });
});
afterAll(() => {
  server.close();
  server.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
});

describe("responses match the contract", () => {
  it("health needs no token and says nothing else", async () => {
    expect(HealthResponse.parse(await (await get("health", {})).json())).toEqual({ status: "ok" });
  });

  it("meta lists every state, event type and reason, with transience", async () => {
    const m = await ok(MetaResponse, "meta");
    expect(m.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(m.caseStates).toContain("MergeUnknown");
    expect(m.reasonCodes.find((r) => r.code === "CI_PENDING")?.transient).toBe(true);
    expect(m.reasonCodes.find((r) => r.code === "APPROVAL_STALE")?.transient).toBe(false);
  });

  it("summary counts every state, including those with no cases", async () => {
    const s = await ok(SummaryResponse, "summary");
    expect(s.totalCases).toBe(7);
    expect(s.byState.Merged).toBe(1);
    expect(s.byState.Triaged).toBe(0);
    expect(s.active).toBe(6);
    expect(s.needsAttention).toBe(3); // Stale, Blocked, MergeUnknown
    expect(s.lastEventAt).toBe("2026-11-04T13:00:00.000Z");
  });

  it("lists cases newest first, pages through them and filters by state", async () => {
    const first = await ok(CaseListResponse, "cases?limit=3");
    expect(first.items.map((c) => c.id)).toEqual(["LB-007", "LB-006", "LB-005"]);
    const second = await ok(CaseListResponse, `cases?limit=3&cursor=${first.nextCursor ?? ""}`);
    expect(second.items.map((c) => c.id)).toEqual(["LB-004", "LB-003", "LB-002"]);
    const last = await ok(CaseListResponse, `cases?limit=3&cursor=${second.nextCursor ?? ""}`);
    expect(last.items.map((c) => c.id)).toEqual(["LB-001"]);
    expect(last.nextCursor).toBeNull();
    const blocked = await ok(CaseListResponse, "cases?state=Blocked");
    expect(blocked.items.map((c) => c.id)).toEqual(["LB-004"]);
    expect(blocked.items[0]?.blockedReason).toBe("PROTECTED_PATH_CHANGED");
    expect(blocked.items[0]?.blockedReasonTransient).toBe(false);
  });

  it("a case detail tells the whole merged story", async () => {
    const c = await ok(CaseDetail, "cases/LB-001");
    expect(c.pullRequestUrl).toBe("https://github.com/puneetnith28/loopback-demo-target/pull/11");
    expect(c.latestVerification?.status).toBe("pass");
    expect(c.latestVerification?.signature).toBe("valid");
    expect(c.latestVerification?.advisory).toBe(false);
    expect(c.checks.map((k) => k.conclusion)).toEqual(["success"]);
    expect(c.approvals.map((a) => a.decision)).toEqual(["approve"]);
    expect(c.latestMerge?.status).toBe("succeeded");
  });

  it("a head change voids the old evidence on the case detail, and history keeps it", async () => {
    const c = await ok(CaseDetail, "cases/LB-003");
    expect(c.state).toBe("Stale");
    expect(c.approvals).toEqual([]);
    expect(c.checks).toEqual([]);
    expect(c.latestVerification?.isCurrentHead).toBe(false);
    const all = await ok(ApprovalListResponse, "cases/LB-003/approvals");
    expect(all.items.map((a) => a.isCurrentHead)).toEqual([false]);
    const commits = await ok(CommitListResponse, "cases/LB-003/commits");
    expect(commits.items.map((k) => [k.headSha, k.isCurrentHead])).toEqual([[sha("lb-003-new"), true], [sha("lb-003-old"), false]]);
  });

  it("advisory verification is reported as advisory", async () => {
    const runs = await ok(VerificationListResponse, "cases/LB-002/verification-runs");
    expect(runs.items[0]?.advisory).toBe(true);
    expect(runs.items[0]?.signature).toBe("absent");
    expect(runs.items[0]?.report?.findings).toEqual([{ severity: "low", file: "src/index.js", message: "A helper could be simplified." }]);
  });

  it("serves checks and merge operations, without the gate's error text", async () => {
    expect((await ok(CiListResponse, "cases/LB-001/checks")).items[0]?.url).toMatch(/^https:\/\/github\.com\//);
    const raw = await (await get("cases/LB-007/merge-operations")).text();
    expect(MergeListResponse.parse(JSON.parse(raw)).items[0]?.status).toBe("unknown");
    expect(raw).not.toContain("timeout at the GitHub API");
  });

  it("audit polls forward with after, pages back with before, and filters", async () => {
    const newest = await ok(AuditPageResponse, "audit?limit=2");
    const ids = newest.items.map((e) => e.id);
    expect(ids[0]).toBeGreaterThan(ids[1] ?? 0);
    const back = await ok(AuditPageResponse, `audit?limit=2&before=${newest.nextCursor ?? ""}`);
    expect(back.items[0]?.id).toBeLessThan(ids[1] ?? 0);
    const forward = await ok(AuditPageResponse, "audit?after=0&limit=3");
    expect(forward.items.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(forward.nextCursor).toBe("3");
    const caught = await ok(AuditPageResponse, `audit?after=${ids[0] ?? 0}`);
    expect(caught.items).toEqual([]);
    expect(caught.nextCursor).toBeNull();
    const typed = await ok(AuditPageResponse, "audit?type=merge.confirmed");
    expect(typed.items.map((e) => e.caseId)).toEqual(["LB-001"]);
    const forCase = await ok(AuditPageResponse, "cases/LB-006/audit");
    expect(forCase.items.every((e) => e.caseId === "LB-006")).toBe(true);
  });

  it("activity holds only agent events", async () => {
    const a = await ok(AuditPageResponse, "activity?limit=200");
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.items.every((e) => /^(fixer|verification)\.|^pr\.|^commit\.|^agent_output\.|^case\.retasked/.test(e.type))).toBe(true);
  });
});

describe("gate status", () => {
  it("reports an unreachable gate as such, without failing", async () => {
    expect(await ok(GateStatusResponse, "gate")).toMatchObject({ reachable: false, live: false, ready: false, failing: [] });
  });

  it("reads the gate's own health endpoints", async () => {
    const gate = createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/healthz" ? { ok: true } : { ok: false, failing: ["heartbeat:intake"] }));
    });
    await new Promise<void>((r) => gate.listen(cfg.gatePort, "127.0.0.1", r));
    try {
      expect(await ok(GateStatusResponse, "gate")).toMatchObject({ reachable: true, live: true, ready: false, failing: ["heartbeat:intake"] });
    } finally {
      await new Promise((r) => gate.close(r));
    }
  });
});

describe("access", () => {
  it.each([["no token", {}], ["wrong token", { authorization: "Bearer wrong" }], ["wrong scheme", { authorization: `Basic ${TOKEN}` }]])("refuses %s", async (_n, headers) => {
    await refused(await get("summary", headers), 401, "UNAUTHORIZED");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s is refused: the API is read-only", async (method) => {
    const res = await get("cases/LB-002", { authorization: `Bearer ${TOKEN}` }, method);
    expect(res.headers.get("allow")).toBe("GET, OPTIONS");
    await refused(res, 405, "METHOD_NOT_ALLOWED");
  });

  it("refuses another browser origin, and answers the allowed one with exact CORS headers", async () => {
    await refused(await get("summary", { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" }), 403, "FORBIDDEN");
    const res = await get("summary", { authorization: `Bearer ${TOKEN}`, origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const preflight = await fetch(url("summary"), { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
    await refused(await fetch(url("summary"), { method: "OPTIONS", headers: { origin: "https://evil.example" } }), 403, "FORBIDDEN");
  });

  it("refuses a request with a foreign Host header (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: cfg.port, path: "/api/v1/health", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("listens on the loopback interface only", () => {
    const addr = server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
  });

  it("the token never reaches the logs", () => {
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("bad requests", () => {
  it.each([
    ["limit too high", "cases?limit=9999"], ["limit not a number", "cases?limit=abc"], ["unknown state", "cases?state=Nope"],
    ["unknown parameter", "cases?admin=1"], ["bad cursor", "cases?cursor=1;DROP"], ["both directions", "audit?after=1&before=2"], ["unknown event type", "audit?type=nope"], ["query on meta", "meta?x=1"],
  ])("%s gets 400", async (_n, path) => {
    await refused(await get(path), 400, "BAD_REQUEST");
  });

  it.each([["unknown case", "cases/LB-999"], ["malformed id", "cases/DROP%20TABLE"], ["unknown endpoint", "nope"], ["sub-path of a case", "cases/LB-001/nope"]])("%s gets 404", async (_n, path) => {
    await refused(await get(path), 404, "NOT_FOUND");
  });
});

describe("what the browser can see", () => {
  it("removes credentials from audit payloads, by key and by value", async () => {
    const raw = await (await get("cases/LB-002/audit")).text();
    for (const secret of ["ghp_0123456789abcdefghij", "lbcap1.aaa.bbb", "c2lnbmF0dXJl", '"apiToken":"abc"']) expect(raw).not.toContain(secret);
    const event = AuditPageResponse.parse(JSON.parse(raw)).items.find((e) => e.type === "policy.violation");
    expect(event?.payload).toMatchObject({ apiToken: "[redacted]", capability: "[redacted]", signature: "[redacted]", nested: { privateKey: "[redacted]", ok: 1 } });
  });

  it("never serves the report's signature, the room or the connection state", async () => {
    const body = JSON.stringify(await ok(CaseDetail, "cases/LB-001"));
    expect(body).not.toContain("c2lnbmF0dXJlIGJ5dGVz");
    expect(body).not.toMatch(/room/i);
    expect(body).not.toMatch(/thread/i);
  });

  it("serves hostile report text untouched as data, labelled for plain-text rendering, and excerpts it", async () => {
    const c = await ok(CaseDetail, "cases/LB-005");
    expect(c.reportText).toContain("<img src=x onerror=alert(1)>");
    expect(c.reportExcerpt.length).toBeLessThanOrEqual(161);
    const res = await get("cases/LB-005");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("drops links that are not https GitHub links", () => {
    expect(githubUrlOrNull("https://github.com/o/r/actions/runs/1")).toBe("https://github.com/o/r/actions/runs/1");
    for (const bad of ["javascript:alert(1)", "http://github.com/x", "https://github.com.evil.example/x", 'https://github.com/"><img', null]) expect(githubUrlOrNull(bad)).toBeNull();
  });

  it("sanitize removes a whole pasted private key and other credential shapes from free text", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    // Built at runtime, so the repository's secret scan doesn't mistake this fake for a real key.
    const marker = (edge: string, kind = "") => `-----${edge} ${kind}PRIVATE ${"KEY"}-----`;
    const pem = `see ${marker("BEGIN")}\n${body}\n${marker("END")} above`;
    const unterminated = `${marker("BEGIN", "RSA ")}\n${body}`;
    expect(String(sanitize(pem))).not.toContain(body);
    expect(String(sanitize(pem))).toContain("above");
    expect(String(sanitize(unterminated))).not.toContain(body);
    const signerToken = "a1".repeat(32);
    expect(String(sanitize(`token ${signerToken} here`))).not.toContain(signerToken);
    const apiKey = `sk-${"x".repeat(40)}`;
    expect(String(sanitize(`key ${apiKey}`))).not.toContain(apiKey);
    const sha = "b".repeat(40);
    expect(String(sanitize(`commit ${sha}`))).toContain(sha);
  });

  it("sanitize limits depth and size, and keeps a signature status", () => {
    expect(sanitize({ signature: "valid" })).toEqual({ signature: "valid" });
    expect(sanitize({ signature: "AAAA" })).toEqual({ signature: "[redacted]" });
    let deep: unknown = "x";
    for (let i = 0; i < 10; i += 1) deep = { a: deep };
    expect(JSON.stringify(sanitize(deep))).toContain("[depth-limit]");
    expect(String(sanitize("y".repeat(5000))).length).toBeLessThan(2100);
  });
});

describe("it cannot change the gate's state, and copes with the database", () => {
  const snapshot = () => {
    const db = new Database(dbPath, { readonly: true });
    const r = db.prepare("SELECT (SELECT count(*) FROM cases) c, (SELECT count(*) FROM audit_events) a, (SELECT group_concat(state) FROM cases) s").get();
    db.close();
    return JSON.stringify(r);
  };

  it("reading everything changes nothing", async () => {
    const before = snapshot();
    for (const p of ["meta", "summary", "cases", "audit", "activity", "cases/LB-001", "cases/LB-001/audit", "cases/LB-001/commits"]) await ok(z.unknown(), p);
    expect(snapshot()).toBe(before);
  });

  it("the expected schema version is the gate's latest migration", () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
  });

  it("sees the gate's writes while the gate holds its connection open", async () => {
    const writer = openDatabase(dbPath);
    const before = (await ok(SummaryResponse, "summary")).totalCases;
    writer.prepare(`INSERT INTO cases (id, state, reporter_id, room_id, repo, report_text, state_entered_at, created_at, updated_at) VALUES ('LB-008', 'Reported', 'r', 'room', 'o/r', 'x', ?, ?, ?)`).run("2026-11-04T14:00:00.000Z", "2026-11-04T14:00:00.000Z", "2026-11-04T14:00:00.000Z");
    expect((await ok(SummaryResponse, "summary")).totalCases).toBe(before + 1);
    writer.prepare("DELETE FROM cases WHERE id = 'LB-008'").run();
    writer.close();
  });

  it("a missing database is 503, and recovers when it appears", async () => {
    const path = join(dir, "later.db");
    const c2 = { ...cfg, dbPath: path, port: await freePort() };
    const s2 = await startConsoleServer(c2);
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      await refused(await fetch(`http://127.0.0.1:${c2.port}/api/v1/summary`, { headers: auth }), 503, "DATABASE_UNAVAILABLE");
      expect((await fetch(`http://127.0.0.1:${c2.port}/api/v1/health`)).status).toBe(200);
      const db = openDatabase(path);
      migrate(db);
      db.close();
      expect((await fetch(`http://127.0.0.1:${c2.port}/api/v1/summary`, { headers: auth })).status).toBe(200);
    } finally {
      s2.close();
      s2.closeAllConnections();
    }
  });

  it("a database at another schema version is refused, never misread", async () => {
    const path = join(dir, "future.db");
    const db = openDatabase(path);
    migrate(db);
    db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'future', '2026-11-04')").run();
    db.close();
    const c2 = { ...cfg, dbPath: path, port: await freePort() };
    const s2 = await startConsoleServer(c2);
    try {
      await refused(await fetch(`http://127.0.0.1:${c2.port}/api/v1/summary`, { headers: { authorization: `Bearer ${TOKEN}` } }), 503, "SCHEMA_MISMATCH");
    } finally {
      s2.close();
      s2.closeAllConnections();
    }
  });
});

describe("configuration", () => {
  const good = { CONSOLE_DB_PATH: "x.db", CONSOLE_API_TOKEN: TOKEN };
  it("applies defaults", () => {
    expect(loadConsoleConfig(good)).toMatchObject({ port: 8788, gatePort: 8787, allowedOrigin: null });
  });
  it.each(["GH_APP_PRIVATE_KEY_PATH", "GH_TOKEN", "GITHUB_TOKEN", "SWITCH_AGENT_API_KEY", "LOOPBACK_RUN_ISSUER_KEY_PATH", "SIGNER_GH_TOKEN"])("refuses to start with %s in its environment", (name) => {
    expect(() => loadConsoleConfig({ ...good, [name]: "x" })).toThrow(new RegExp(name));
  });
  it.each([
    [{ CONSOLE_API_TOKEN: TOKEN }, /CONSOLE_DB_PATH/],
    [{ CONSOLE_DB_PATH: "x" }, /CONSOLE_API_TOKEN/],
    [{ ...good, CONSOLE_API_TOKEN: "short" }, /CONSOLE_API_TOKEN/],
    [{ ...good, CONSOLE_ALLOWED_ORIGIN: "*" }, /exact origin/],
    [{ ...good, CONSOLE_ALLOWED_ORIGIN: "http://localhost:5173/path" }, /origin such as/],
    [{ ...good, CONSOLE_ALLOWED_ORIGIN: "nonsense" }, /origin such as/],
    [{ ...good, CONSOLE_API_PORT: "99999" }, /port number/],
  ])("refuses %j", (env, message) => {
    expect(() => loadConsoleConfig(env)).toThrow(ConsoleConfigError);
    expect(() => loadConsoleConfig(env)).toThrow(message);
  });
});

describe("the published examples", () => {
  const SCHEMAS: Record<string, z.ZodType> = {
    meta: MetaResponse, summary: SummaryResponse, gate: GateStatusResponse, cases: CaseListResponse, "cases-page-2": CaseListResponse, "cases-blocked": CaseListResponse,
    case: CaseDetail, "case-stale": CaseDetail, "case-hostile-report": CaseDetail, commits: CommitListResponse, "verification-runs": VerificationListResponse,
    checks: CiListResponse, approvals: ApprovalListResponse, "merge-operations": MergeListResponse, "case-audit": AuditPageResponse, audit: AuditPageResponse, "audit-poll": AuditPageResponse, activity: AuditPageResponse,
    "error-unauthorized": ApiError, "error-not-found": ApiError, "error-bad-request": ApiError,
  };
  const dirPath = join(process.cwd(), "docs", "console-api-examples");

  it("every example matches its schema, and every schema has an example", () => {
    const files = readdirSync(dirPath).map((f) => f.replace(/\.json$/, "")).sort();
    expect(files).toEqual(Object.keys(SCHEMAS).sort());
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      const parsed = schema.safeParse(JSON.parse(readFileSync(join(dirPath, `${name}.json`), "utf8")));
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
