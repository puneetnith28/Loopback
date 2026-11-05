import { CASE_STATES, TRANSIENT_REASON_CODES, ReasonCode } from "@loopback/contracts";
import {
  AGENT_ACTIVITY_TYPES, ATTENTION_STATES, TERMINAL_STATES,
  type ApprovalRecord, type AuditEvent, type CaseDetail, type CaseSummary, type CiCheck, type CommitRecord, type MergeOperation, type SummaryResponse, type VerificationRun,
} from "@loopback/console-contracts";
import Database from "better-sqlite3";
import { githubUrlOrNull, sanitize, scrubText } from "./sanitize.js";

// Read-only access to the gate's database. Each request opens and closes its own connection:
// it never pins a file that reset-demo.sh may move away (Windows refuses to move an open file)
// and never serves a replaced file from a stale handle. Opened read-only and query-only, so this
// code cannot change the gate's state even by mistake. The tables `kv` (connection ids and
// cursors) and `processed_events` are never read.

/** The gate schema this API was written against (apps/switch-gate persistence migrations). */
export const EXPECTED_SCHEMA_VERSION = 3;

export class DatabaseUnavailable extends Error {}
export class SchemaMismatch extends Error {}

type Db = Database.Database;
type Row = Record<string, unknown>;

export function withDatabase<T>(path: string, fn: (db: Db) => T): T {
  let db: Db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    throw new DatabaseUnavailable();
  }
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 2000");
    let version: unknown;
    try {
      version = db.prepare("SELECT max(version) AS v FROM schema_version").pluck().get();
    } catch {
      throw new DatabaseUnavailable();
    }
    if (version !== EXPECTED_SCHEMA_VERSION) throw new SchemaMismatch();
    return fn(db);
  } finally {
    db.close();
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? v.toString() : "");
const opt = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));

function reason(v: unknown): { blockedReason: ReasonCode | null; blockedReasonTransient: boolean | null } {
  const parsed = ReasonCode.safeParse(v);
  return parsed.success ? { blockedReason: parsed.data, blockedReasonTransient: TRANSIENT_REASON_CODES.has(parsed.data) } : { blockedReason: null, blockedReasonTransient: null };
}

function toSummary(r: Row): CaseSummary {
  const repository = str(r.repo);
  const pr = r.pr_number === null ? null : Number(r.pr_number);
  const report = scrubText(str(r.report_text));
  return {
    id: str(r.id),
    state: r.state as CaseSummary["state"],
    ...reason(r.blocked_reason),
    repository,
    pullRequest: pr,
    pullRequestUrl: pr === null ? null : `https://github.com/${repository}/pull/${pr}`,
    branch: opt(r.branch),
    headSha: opt(r.head_sha),
    reporterId: str(r.reporter_id),
    reportExcerpt: report.length > 160 ? `${report.slice(0, 160)}…` : report,
    stateEnteredAt: str(r.state_entered_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function listCases(db: Db, q: { state?: string | undefined; limit: number; cursor?: string | undefined }): { items: CaseSummary[]; nextCursor: string | null } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.state !== undefined) { where.push("state = ?"); args.push(q.state); }
  if (q.cursor !== undefined) { where.push("rowid < ?"); args.push(Number(q.cursor)); }
  const sql = `SELECT rowid AS rid, * FROM cases ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, q.limit + 1) as Row[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: page.map(toSummary), nextCursor: rows.length > q.limit && last ? str(last.rid) : null };
}

/** Returns null when the case does not exist. */
export function currentHead(db: Db, caseId: string): { head: string | null } | null {
  const r = db.prepare("SELECT head_sha FROM cases WHERE id = ?").get(caseId) as Row | undefined;
  return r === undefined ? null : { head: opt(r.head_sha) };
}

export function listCommits(db: Db, caseId: string, head: string | null): CommitRecord[] {
  return (db.prepare("SELECT * FROM case_commits WHERE case_id = ? ORDER BY observed_at DESC, head_sha").all(caseId) as Row[]).map((r) => ({
    headSha: str(r.head_sha), baseSha: str(r.base_sha), observedAt: str(r.observed_at), isCurrentHead: r.head_sha === head,
  }));
}

function parseReport(json: unknown): VerificationRun["report"] {
  if (typeof json !== "string") return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as { verdict?: unknown; regressionTestFailsBeforeFix?: unknown; summary?: unknown; findings?: unknown };
  if ((r.verdict !== "pass" && r.verdict !== "fail") || typeof r.regressionTestFailsBeforeFix !== "boolean") return null;
  const findings = Array.isArray(r.findings) ? (r.findings as { severity?: unknown; file?: unknown; message?: unknown }[]) : [];
  const severities = new Set(["info", "low", "medium", "high"]);
  return {
    verdict: r.verdict,
    regressionTestFailsBeforeFix: r.regressionTestFailsBeforeFix,
    summary: scrubText(str(r.summary)),
    findings: findings.filter((f) => severities.has(str(f.severity))).map((f) => ({
      severity: f.severity as "info" | "low" | "medium" | "high",
      file: typeof f.file === "string" ? scrubText(f.file) : null,
      message: scrubText(str(f.message)),
    })),
  };
}

/** What the gate recorded when it accepted the report: signature status and advisory label. */
function runEvidence(db: Db, runId: string): { signature: VerificationRun["signature"]; advisory: boolean | null } {
  const row = db.prepare(
    `SELECT json_extract(payload_json, '$.signature') AS signature, json_extract(payload_json, '$.advisory') AS advisory
     FROM audit_events
     WHERE event_type IN ('verification.passed', 'verification.failed', 'agent_output.invalid') AND json_extract(payload_json, '$.runId') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(runId) as Row | undefined;
  const s = row?.signature;
  return {
    signature: s === "valid" || s === "absent" || s === "unverified" || s === "invalid" ? s : null,
    advisory: row === undefined || row.advisory === null ? null : row.advisory === 1,
  };
}

function toRun(db: Db, r: Row, head: string | null): VerificationRun {
  const id = str(r.id);
  return {
    id,
    sequence: Number(r.seq),
    headSha: str(r.head_sha),
    isCurrentHead: r.head_sha === head,
    status: r.status as VerificationRun["status"],
    ...runEvidence(db, id),
    report: parseReport(r.report_json),
    requestedAt: str(r.requested_at),
    completedAt: opt(r.completed_at),
  };
}

export function listRuns(db: Db, caseId: string, head: string | null): VerificationRun[] {
  return (db.prepare("SELECT * FROM verification_runs WHERE case_id = ? ORDER BY seq DESC").all(caseId) as Row[]).map((r) => toRun(db, r, head));
}

const toCheck = (r: Row, head: string | null): CiCheck => ({
  id: str(r.id), headSha: str(r.head_sha), isCurrentHead: r.head_sha === head, name: str(r.check_name), source: str(r.app_slug),
  status: str(r.status), conclusion: opt(r.conclusion), url: githubUrlOrNull(opt(r.html_url)), observedAt: str(r.observed_at),
});

export function listChecks(db: Db, caseId: string, head: string | null): CiCheck[] {
  return (db.prepare("SELECT * FROM ci_evidence WHERE case_id = ? ORDER BY observed_at DESC, check_run_id DESC").all(caseId) as Row[]).map((r) => toCheck(r, head));
}

const toApproval = (r: Row, head: string | null): ApprovalRecord => ({
  id: str(r.id), approverId: str(r.approver_id), headSha: str(r.head_sha), isCurrentHead: r.head_sha === head,
  decision: r.decision as ApprovalRecord["decision"], reason: r.reason === null ? null : scrubText(str(r.reason)), createdAt: str(r.created_at),
});

export function listApprovals(db: Db, caseId: string, head: string | null): ApprovalRecord[] {
  return (db.prepare("SELECT * FROM approvals WHERE case_id = ? ORDER BY created_at DESC").all(caseId) as Row[]).map((r) => toApproval(r, head));
}

/** The gate's error text is deliberately not exposed: only the outcome. */
const toMerge = (r: Row): MergeOperation => ({
  id: str(r.id), headSha: str(r.head_sha), attempt: Number(r.attempt), status: r.status as MergeOperation["status"],
  mergeSha: opt(r.github_merge_sha), startedAt: str(r.started_at), finishedAt: opt(r.finished_at),
});

export function listMerges(db: Db, caseId: string): MergeOperation[] {
  return (db.prepare("SELECT * FROM merge_operations WHERE case_id = ? ORDER BY started_at DESC, attempt DESC").all(caseId) as Row[]).map(toMerge);
}

export function caseDetail(db: Db, caseId: string): CaseDetail | null {
  const r = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as Row | undefined;
  if (r === undefined) return null;
  const head = opt(r.head_sha);
  const onHead = <T extends { isCurrentHead: boolean }>(items: T[]) => items.filter((i) => i.isCurrentHead);
  // CI rows are ordered newest first, so the first row for each check name is its latest state.
  const seen = new Set<string>();
  const checks = onHead(listChecks(db, caseId, head)).filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  const latestRun = db.prepare("SELECT * FROM verification_runs WHERE case_id = ? ORDER BY seq DESC LIMIT 1").get(caseId) as Row | undefined;
  const latestMerge = db.prepare("SELECT * FROM merge_operations WHERE case_id = ? ORDER BY started_at DESC, attempt DESC LIMIT 1").get(caseId) as Row | undefined;
  return {
    ...toSummary(r),
    reportText: scrubText(str(r.report_text)),
    latestVerification: latestRun === undefined ? null : toRun(db, latestRun, head),
    checks,
    approvals: onHead(listApprovals(db, caseId, head)),
    latestMerge: latestMerge === undefined ? null : toMerge(latestMerge),
  };
}

const toAudit = (r: Row): AuditEvent => {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(str(r.payload_json));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = sanitize(parsed) as Record<string, unknown>;
  } catch { /* an unreadable payload is shown as empty, not guessed at */ }
  const reasonCode = ReasonCode.safeParse(r.reason_code);
  return {
    id: Number(r.id), caseId: opt(r.case_id), actorId: str(r.actor_id), type: r.event_type as AuditEvent["type"],
    targetSha: opt(r.target_sha), reasonCode: reasonCode.success ? reasonCode.data : null, payload, createdAt: str(r.created_at),
  };
};

export function listAudit(
  db: Db,
  q: { after?: string | undefined; before?: string | undefined; limit: number; type?: string | undefined; caseId?: string | undefined; types?: readonly string[] | undefined },
): { items: AuditEvent[]; nextCursor: string | null } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.after !== undefined) { where.push("id > ?"); args.push(Number(q.after)); }
  if (q.before !== undefined) { where.push("id < ?"); args.push(Number(q.before)); }
  if (q.type !== undefined) { where.push("event_type = ?"); args.push(q.type); }
  if (q.caseId !== undefined) { where.push("case_id = ?"); args.push(q.caseId); }
  if (q.types !== undefined) { where.push(`event_type IN (${q.types.map(() => "?").join(",")})`); args.push(...q.types); }
  const ascending = q.after !== undefined;
  const sql = `SELECT * FROM audit_events ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${ascending ? "ASC" : "DESC"} LIMIT ?`;
  const rows = db.prepare(sql).all(...args, q.limit + 1) as Row[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: page.map(toAudit), nextCursor: rows.length > q.limit && last ? str(last.id) : null };
}

export const listActivity = (db: Db, q: { after?: string | undefined; before?: string | undefined; limit: number }) => listAudit(db, { ...q, types: AGENT_ACTIVITY_TYPES });

const VERIFICATION_WINDOW_DAYS = 7;

export function summary(db: Db, now: Date): SummaryResponse {
  const counts = db.prepare("SELECT state, count(*) AS n FROM cases GROUP BY state").all() as { state: string; n: number }[];
  const byState = Object.fromEntries(CASE_STATES.map((s) => [s, 0])) as Record<string, number>;
  for (const c of counts) byState[c.state] = c.n;
  const count = (states: readonly string[]) => states.reduce((sum, s) => sum + (byState[s] ?? 0), 0);
  const total = counts.reduce((sum, c) => sum + c.n, 0);
  const last = db.prepare("SELECT created_at FROM audit_events ORDER BY id DESC LIMIT 1").pluck().get() as string | undefined;
  const since = new Date(now.getTime() - VERIFICATION_WINDOW_DAYS * 86_400_000).toISOString();
  const runs = db.prepare("SELECT status, count(*) AS n FROM verification_runs WHERE requested_at >= ? GROUP BY status").all(since) as { status: string; n: number }[];
  const runCount = (status: string) => runs.find((r) => r.status === status)?.n ?? 0;
  return {
    totalCases: total,
    byState,
    active: total - count(TERMINAL_STATES),
    needsAttention: count(ATTENTION_STATES),
    verification: {
      windowDays: VERIFICATION_WINDOW_DAYS,
      pass: runCount("pass"), fail: runCount("fail"), invalid: runCount("invalid"),
      timeout: runCount("timeout"), requested: runCount("requested"), superseded: runCount("superseded"),
    },
    lastEventAt: last ?? null,
    generatedAt: now.toISOString(),
  };
}

export function schemaVersion(db: Db): number {
  return Number(db.prepare("SELECT max(version) FROM schema_version").pluck().get());
}
