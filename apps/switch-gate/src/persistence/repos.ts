import { randomUUID } from "node:crypto";
import { CaseState, type ReasonCode } from "@loopback/contracts";
import { z } from "zod";
import type { Db } from "./db.js";

// Typed data access. Rows are validated with Zod at this boundary so a corrupted
// or hand-edited database cannot silently feed bad values into policy decisions.

const Sha = z.string().length(40).nullable();

const CaseRowSchema = z.object({
  id: z.string(),
  state: CaseState,
  version: z.number().int(),
  reporter_id: z.string(),
  room_id: z.string(),
  thread_id: z.string().nullable(),
  repo: z.string(),
  report_text: z.string(),
  branch: z.string().nullable(),
  pr_number: z.number().int().nullable(),
  head_sha: Sha,
  blocked_reason: z.string().nullable(),
  state_entered_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface CaseRecord {
  readonly id: string;
  readonly state: CaseState;
  readonly version: number;
  readonly reporterId: string;
  readonly roomId: string;
  readonly threadId: string | null;
  readonly repo: string;
  readonly reportText: string;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly headSha: string | null;
  readonly blockedReason: ReasonCode | null;
  readonly stateEnteredAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toCase(raw: unknown): CaseRecord {
  const r = CaseRowSchema.parse(raw);
  return {
    id: r.id, state: r.state, version: r.version, reporterId: r.reporter_id, roomId: r.room_id,
    threadId: r.thread_id, repo: r.repo, reportText: r.report_text, branch: r.branch, prNumber: r.pr_number,
    headSha: r.head_sha, blockedReason: r.blocked_reason as ReasonCode | null, stateEnteredAt: r.state_entered_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getCase(db: Db, id: string): CaseRecord | undefined {
  const raw = db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
  return raw === undefined ? undefined : toCase(raw);
}

export function listCasesInStates(db: Db, states: readonly CaseState[]): CaseRecord[] {
  if (states.length === 0) return [];
  const rows = db.prepare(`SELECT * FROM cases WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY id`).all(...states);
  return rows.map(toCase);
}

export function listOpenCases(db: Db): CaseRecord[] {
  return db.prepare("SELECT * FROM cases WHERE state <> 'Merged' ORDER BY id").all().map(toCase);
}

// --- kv -----------------------------------------------------------------------

export function kvGet(db: Db, k: string): string | undefined {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return row?.v;
}

export function kvSet(db: Db, k: string, v: string): void {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

// --- processed events -----------------------------------------------------------

export function isProcessed(db: Db, eventId: string): boolean {
  return db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(eventId) !== undefined;
}

/** Returns false when the event was already recorded. */
export function markProcessed(db: Db, eventId: string, now: Date): boolean {
  return db.prepare("INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)").run(eventId, now.toISOString()).changes === 1;
}

// --- commits and CI evidence ---------------------------------------------------------

export function recordCommit(db: Db, caseId: string, headSha: string, baseSha: string, now: Date): boolean {
  return db
    .prepare("INSERT OR IGNORE INTO case_commits (case_id, head_sha, base_sha, observed_at) VALUES (?, ?, ?, ?)")
    .run(caseId, headSha, baseSha, now.toISOString()).changes === 1;
}

export interface CiEvidenceInput {
  readonly caseId: string;
  readonly headSha: string;
  readonly checkName: string;
  readonly checkRunId: number;
  readonly appSlug: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
}

/**
 * Record or update a check run. A run keeps its id while it moves from queued to
 * completed, so the row is updated when its status or conclusion changes.
 * Returns true when the row was inserted or changed.
 */
export function recordCiEvidence(db: Db, e: CiEvidenceInput, now: Date): boolean {
  return db
    .prepare(
      `INSERT INTO ci_evidence (id, case_id, head_sha, check_name, check_run_id, app_slug, status, conclusion, html_url, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (case_id, head_sha, check_name, check_run_id) DO UPDATE
         SET status = excluded.status, conclusion = excluded.conclusion, observed_at = excluded.observed_at
         WHERE ci_evidence.status IS NOT excluded.status OR ci_evidence.conclusion IS NOT excluded.conclusion`,
    )
    .run(randomUUID(), e.caseId, e.headSha, e.checkName, e.checkRunId, e.appSlug, e.status, e.conclusion, e.htmlUrl, now.toISOString())
    .changes === 1;
}

export function latestCi(db: Db, caseId: string, headSha: string, checkName: string): { status: string; conclusion: string | null } | undefined {
  return db
    .prepare("SELECT status, conclusion FROM ci_evidence WHERE case_id = ? AND head_sha = ? AND check_name = ? ORDER BY check_run_id DESC, observed_at DESC LIMIT 1")
    .get(caseId, headSha, checkName) as { status: string; conclusion: string | null } | undefined;
}

// --- verification runs -----------------------------------------------------------

export type RunStatus = "requested" | "pass" | "fail" | "invalid" | "timeout";

export interface VerificationRun {
  readonly seq: number;
  readonly id: string;
  readonly caseId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly status: RunStatus;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

const RunRow = z.object({
  seq: z.number().int(), id: z.string(), case_id: z.string(), repo: z.string(), pr_number: z.number().int(),
  head_sha: z.string().length(40), status: z.enum(["requested", "pass", "fail", "invalid", "timeout"]),
  requested_at: z.string(), completed_at: z.string().nullable(),
});
const toRun = (raw: unknown): VerificationRun => {
  const r = RunRow.parse(raw);
  return { seq: r.seq, id: r.id, caseId: r.case_id, repo: r.repo, prNumber: r.pr_number, headSha: r.head_sha, status: r.status, requestedAt: r.requested_at, completedAt: r.completed_at };
};

export function insertRun(db: Db, caseId: string, repo: string, prNumber: number, headSha: string, now: Date): VerificationRun {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO verification_runs (id, case_id, repo, pr_number, head_sha, status, requested_at) VALUES (?, ?, ?, ?, ?, 'requested', ?)",
  ).run(id, caseId, repo, prNumber, headSha, now.toISOString());
  return toRun(db.prepare("SELECT * FROM verification_runs WHERE id = ?").get(id));
}

export function listRuns(db: Db, caseId: string): VerificationRun[] {
  return db.prepare("SELECT * FROM verification_runs WHERE case_id = ? ORDER BY seq").all(caseId).map(toRun);
}

export function getRun(db: Db, id: string): VerificationRun | undefined {
  const raw = db.prepare("SELECT * FROM verification_runs WHERE id = ?").get(id);
  return raw === undefined ? undefined : toRun(raw);
}

export function latestRunForHead(db: Db, caseId: string, headSha: string): VerificationRun | undefined {
  const raw = db.prepare("SELECT * FROM verification_runs WHERE case_id = ? AND head_sha = ? ORDER BY seq DESC LIMIT 1").get(caseId, headSha);
  return raw === undefined ? undefined : toRun(raw);
}

/** Complete a run that is still 'requested'. Returns false if it was already completed. */
export function completeRun(db: Db, id: string, status: Exclude<RunStatus, "requested">, reportJson: string | null, now: Date): boolean {
  return db
    .prepare("UPDATE verification_runs SET status = ?, report_json = ?, completed_at = ? WHERE id = ? AND status = 'requested'")
    .run(status, reportJson, now.toISOString(), id).changes === 1;
}

export function listExpiredRuns(db: Db, olderThan: Date): VerificationRun[] {
  return db.prepare("SELECT * FROM verification_runs WHERE status = 'requested' AND requested_at < ? ORDER BY seq").all(olderThan.toISOString()).map(toRun);
}

// --- approvals --------------------------------------------------------------

export interface ApprovalInput {
  readonly caseId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly approverId: string;
  readonly headSha: string;
  readonly decision: "approve" | "reject";
  readonly sourceEventId: string;
  readonly reason: string | null;
}

export interface ApprovalRecord extends ApprovalInput {
  readonly createdAt: string;
}

/** Inserts an approval; returns "duplicate" when this approver already decided on this SHA. */
export function insertApproval(db: Db, a: ApprovalInput, now: Date): "inserted" | "duplicate" {
  try {
    db.prepare(
      `INSERT INTO approvals (id, case_id, repo, pr_number, approver_id, head_sha, decision, source_event_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), a.caseId, a.repo, a.prNumber, a.approverId, a.headSha, a.decision, a.sourceEventId, a.reason, now.toISOString());
    return "inserted";
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return "duplicate";
    throw e;
  }
}

export function listApprovals(db: Db, caseId: string): ApprovalRecord[] {
  const rows = db.prepare("SELECT * FROM approvals WHERE case_id = ? ORDER BY created_at").all(caseId) as {
    case_id: string; repo: string; pr_number: number; approver_id: string; head_sha: string;
    decision: "approve" | "reject"; source_event_id: string; reason: string | null; created_at: string;
  }[];
  return rows.map((r) => ({
    caseId: r.case_id, repo: r.repo, prNumber: r.pr_number, approverId: r.approver_id, headSha: r.head_sha,
    decision: r.decision, sourceEventId: r.source_event_id, reason: r.reason, createdAt: r.created_at,
  }));
}

// --- merge operations --------------------------------------------------------

export type MergeOpStatus = "started" | "succeeded" | "failed" | "unknown";

export interface MergeOp {
  readonly id: string;
  readonly caseId: string;
  readonly headSha: string;
  readonly attempt: number;
  readonly status: MergeOpStatus;
  readonly githubMergeSha: string | null;
  readonly startedAt: string;
}

const OpRow = z.object({
  id: z.string(), case_id: z.string(), head_sha: z.string().length(40), attempt: z.number().int(),
  status: z.enum(["started", "succeeded", "failed", "unknown"]), github_merge_sha: z.string().nullable(), started_at: z.string(),
});
const toOp = (raw: unknown): MergeOp => {
  const r = OpRow.parse(raw);
  return { id: r.id, caseId: r.case_id, headSha: r.head_sha, attempt: r.attempt, status: r.status, githubMergeSha: r.github_merge_sha, startedAt: r.started_at };
};

export function listMergeOps(db: Db, caseId: string, headSha?: string): MergeOp[] {
  const rows = headSha === undefined
    ? db.prepare("SELECT * FROM merge_operations WHERE case_id = ? ORDER BY started_at, attempt").all(caseId)
    : db.prepare("SELECT * FROM merge_operations WHERE case_id = ? AND head_sha = ? ORDER BY attempt").all(caseId, headSha);
  return rows.map(toOp);
}

export function listUnfinishedMergeOps(db: Db): MergeOp[] {
  return db.prepare("SELECT * FROM merge_operations WHERE status IN ('started','unknown') ORDER BY started_at").all().map(toOp);
}

export function insertMergeOp(db: Db, caseId: string, headSha: string, attempt: number, now: Date): MergeOp {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO merge_operations (id, case_id, head_sha, attempt, idempotency_key, status, started_at) VALUES (?, ?, ?, ?, ?, 'started', ?)",
  ).run(id, caseId, headSha, attempt, `${caseId}:${headSha}:${attempt}`, now.toISOString());
  return toOp(db.prepare("SELECT * FROM merge_operations WHERE id = ?").get(id));
}

export function finishMergeOp(db: Db, id: string, status: Exclude<MergeOpStatus, "started">, mergeSha: string | null, error: string | null, now: Date): void {
  db.prepare("UPDATE merge_operations SET status = ?, github_merge_sha = ?, error = ?, finished_at = ? WHERE id = ?")
    .run(status, mergeSha, error === null ? null : error.slice(0, 500), now.toISOString(), id);
}
