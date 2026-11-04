import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { append, countEvents, listRecent, redact } from "../../apps/switch-gate/src/audit/index.js";
import { migrate, openDatabase, type Db } from "../../apps/switch-gate/src/persistence/db.js";
import { insertApproval, insertMergeOp, kvGet, kvSet, recordCiEvidence } from "../../apps/switch-gate/src/persistence/repos.js";

const A = "a".repeat(40);
const NOW = new Date("2026-11-04T10:00:00Z");
let db: Db;

function seedCase(id = "LB-001", pr: number | null = 42) {
  db.prepare(
    `INSERT INTO cases (id, state, reporter_id, room_id, repo, report_text, pr_number, head_sha, state_entered_at, created_at, updated_at)
     VALUES (?, 'AwaitingApproval', 'r', 'room', 'o/r', 'text', ?, ?, 't', 't', 't')`,
  ).run(id, pr, pr === null ? null : A);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("migrations", () => {
  it("are idempotent and recorded", () => {
    expect(migrate(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_version").all()).toEqual([{ version: 1 }]);
  });
  it("enable foreign keys on every connection", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => db.prepare("INSERT INTO case_commits VALUES ('LB-999', ?, ?, 't')").run(A, A)).toThrow(/FOREIGN KEY/);
  });
});

describe("schema constraints", () => {
  beforeEach(() => seedCase());

  it("head SHAs must be 40 characters", () => {
    expect(() => db.prepare("UPDATE cases SET head_sha = 'abc' WHERE id = 'LB-001'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO case_commits VALUES ('LB-001', 'abc', ?, 't')").run(A)).toThrow(/CHECK/);
  });
  it("case ids must look like LB-nnn", () => {
    expect(() => seedCase("CASE-1")).toThrow(/CHECK/);
  });
  it("status and decision enums are enforced", () => {
    expect(() => db.prepare("INSERT INTO verification_runs (id, case_id, repo, pr_number, head_sha, status, requested_at) VALUES ('v', 'LB-001', 'o/r', 42, ?, 'superseded', 't')").run(A)).toThrow(/CHECK/);
    expect(() => insertApproval(db, { caseId: "LB-001", repo: "o/r", prNumber: 42, approverId: "m", headSha: A, decision: "maybe" as "approve", sourceEventId: "e", reason: null }, NOW)).toThrow(/CHECK/);
  });
  it("one decision per approver per SHA; source events unique", () => {
    const a = { caseId: "LB-001", repo: "o/r", prNumber: 42, approverId: "m", headSha: A, decision: "approve" as const, sourceEventId: "e1", reason: null };
    expect(insertApproval(db, a, NOW)).toBe("inserted");
    expect(insertApproval(db, { ...a, sourceEventId: "e2" }, NOW)).toBe("duplicate");
    expect(insertApproval(db, { ...a, approverId: "m2" }, NOW)).toBe("duplicate"); // same source event
  });
  it("D11: an approval for another PR or repository is rejected by the trigger", () => {
    const a = { caseId: "LB-001", repo: "o/r", prNumber: 41, approverId: "m", headSha: A, decision: "approve" as const, sourceEventId: "e1", reason: null };
    expect(() => insertApproval(db, a, NOW)).toThrow(/does not match the case/);
    expect(() => insertApproval(db, { ...a, prNumber: 42, repo: "x/r" }, NOW)).toThrow(/does not match the case/);
  });
  it("approvals are immutable", () => {
    insertApproval(db, { caseId: "LB-001", repo: "o/r", prNumber: 42, approverId: "m", headSha: A, decision: "approve", sourceEventId: "e1", reason: null }, NOW);
    expect(() => db.prepare("UPDATE approvals SET decision = 'reject'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM approvals").run()).toThrow(/immutable/);
  });
  it("D15: merge attempts are unique per case, SHA and attempt, with a consistent key", () => {
    insertMergeOp(db, "LB-001", A, 1, NOW);
    expect(() => insertMergeOp(db, "LB-001", A, 1, NOW)).toThrow(/UNIQUE/);
    expect(() => insertMergeOp(db, "LB-001", A, 0, NOW)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO merge_operations (id, case_id, head_sha, attempt, idempotency_key, status, started_at) VALUES ('x', 'LB-001', ?, 2, 'wrong', 'started', 't')").run(A)).toThrow(/CHECK/);
    expect(insertMergeOp(db, "LB-001", A, 2, NOW).attempt).toBe(2);
  });
  it("CI evidence is idempotent", () => {
    const e = { caseId: "LB-001", headSha: A, checkName: "test", checkRunId: 7, appSlug: "github-actions", status: "completed", conclusion: "success", htmlUrl: "u" };
    expect(recordCiEvidence(db, e, NOW)).toBe(true);
    expect(recordCiEvidence(db, e, NOW)).toBe(false);
  });
  it("kv upserts", () => {
    kvSet(db, "k", "1");
    kvSet(db, "k", "2");
    expect(kvGet(db, "k")).toBe("2");
  });
});

describe("audit log", () => {
  it("is append-only", () => {
    append(db, { caseId: null, actorId: "system", type: "command.refused" }, NOW);
    expect(() => db.prepare("UPDATE audit_events SET actor_id = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });
  it("redacts secrets recursively and truncates untrusted text", () => {
    const r = redact({ token: "t", nested: { apiKey: "k", Authorization: "Bearer x", ok: "fine" }, list: [{ password: "p" }], text: "y".repeat(500) }) as Record<string, unknown>;
    expect(r.token).toBe("[redacted]");
    expect(r.nested).toEqual({ apiKey: "[redacted]", Authorization: "[redacted]", ok: "fine" });
    expect(r.list).toEqual([{ password: "[redacted]" }]);
    expect((r.text as string).length).toBeLessThan(250);
  });
  it("stores redacted payloads and lists newest first", () => {
    seedCase();
    append(db, { caseId: "LB-001", actorId: "a", type: "case.created", payload: { secret: "s" } }, NOW);
    append(db, { caseId: "LB-001", actorId: "b", type: "pr.created", targetSha: A }, NOW);
    const rows = listRecent(db, "LB-001");
    expect(rows.map((r) => r.type)).toEqual(["pr.created", "case.created"]);
    expect(rows[1]!.payload).toEqual({ secret: "[redacted]" });
    expect(countEvents(db, "LB-001", "pr.created", A)).toBe(1);
  });
});
