import type { AuditEventType, CaseState, ReasonCode } from "@loopback/contracts";
import { append } from "../audit/index.js";
import type { Db } from "../persistence/db.js";
import { getCase, kvGet, kvSet, markProcessed, type CaseRecord } from "../persistence/repos.js";
import { assertTransition, type TransitionTrigger } from "./machine.js";

export class CaseNotFound extends Error {
  constructor(id: string) {
    super(`case ${id} not found`);
    this.name = "CaseNotFound";
  }
}

export class ConcurrentModification extends Error {
  constructor(id: string) {
    super(`case ${id} was modified concurrently`);
    this.name = "ConcurrentModification";
  }
}

export interface TransitionRequest {
  readonly caseId: string;
  readonly to: CaseState;
  readonly actorId: string;
  readonly trigger: TransitionTrigger;
  readonly reason: ReasonCode | null;
  /** If set, the transition fails unless the case is still at this version. */
  readonly expectedVersion?: number;
  readonly auditType?: AuditEventType;
  readonly targetSha?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly updates?: { readonly prNumber?: number; readonly headSha?: string; readonly branch?: string };
}

/**
 * Change a case's state. In ONE transaction: optimistic version check, guard
 * check, state update and audit append. Callers announce to chat only after this
 * returns, so state is always persisted before it is announced (invariant 10).
 */
export function transition(db: Db, req: TransitionRequest, now: Date = new Date()): CaseRecord {
  return db.transaction(() => transitionInTx(db, req, now))();
}

/** Same as transition(), for callers already inside a transaction. */
export function transitionInTx(db: Db, req: TransitionRequest, now: Date): CaseRecord {
  const current = getCase(db, req.caseId);
  if (!current) throw new CaseNotFound(req.caseId);
  if (req.expectedVersion !== undefined && req.expectedVersion !== current.version) {
    throw new ConcurrentModification(req.caseId);
  }
  assertTransition(current.state, req.to, req.reason, req.trigger, {
    hasPrAndHead: current.prNumber !== null && current.headSha !== null,
  });
  const ts = now.toISOString();
  const u = req.updates ?? {};
  const info = db
    .prepare(
      `UPDATE cases SET state = ?, version = version + 1, blocked_reason = ?, state_entered_at = ?, updated_at = ?,
         pr_number = COALESCE(?, pr_number), head_sha = COALESCE(?, head_sha), branch = COALESCE(?, branch)
       WHERE id = ? AND version = ?`,
    )
    .run(req.to, req.to === "Blocked" ? req.reason : null, ts, ts, u.prNumber ?? null, u.headSha ?? null, u.branch ?? null, req.caseId, current.version);
  if (info.changes !== 1) throw new ConcurrentModification(req.caseId);
  append(db, {
    caseId: req.caseId,
    actorId: req.actorId,
    type: req.auditType ?? "case.state_changed",
    targetSha: req.targetSha ?? u.headSha ?? current.headSha,
    reasonCode: req.reason,
    payload: { from: current.state, to: req.to, trigger: req.trigger, ...(req.payload ?? {}) },
  }, now);
  return getCase(db, req.caseId)!;
}

export interface NewCase {
  readonly reporterId: string;
  readonly roomId: string;
  readonly threadId: string | null;
  readonly repo: string;
  readonly reportText: string;
  readonly sourceEventId: string;
}

export function formatCaseId(n: number): string {
  return `LB-${String(n).padStart(3, "0")}`;
}

/**
 * Create a case in Reported, allocating the next id and recording the source
 * event in the same transaction, so a redelivered report cannot create a second case.
 * Returns undefined if the source event was already processed.
 */
export function createCase(db: Db, input: NewCase, now: Date = new Date()): CaseRecord | undefined {
  return db.transaction(() => {
    if (!markProcessed(db, input.sourceEventId, now)) return undefined;
    const next = Number(kvGet(db, "next_case") ?? "1");
    if (!Number.isSafeInteger(next) || next < 1) throw new Error("corrupt case counter");
    const id = formatCaseId(next);
    kvSet(db, "next_case", String(next + 1));
    const ts = now.toISOString();
    db.prepare(
      `INSERT INTO cases (id, state, version, reporter_id, room_id, thread_id, repo, report_text, branch, state_entered_at, created_at, updated_at)
       VALUES (?, 'Reported', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.reporterId, input.roomId, input.threadId, input.repo, input.reportText, `loopback/${id}`, ts, ts, ts);
    append(db, {
      caseId: id,
      actorId: input.reporterId,
      type: "case.created",
      payload: { report: input.reportText, sourceEventId: input.sourceEventId },
    }, now);
    return getCase(db, id)!;
  })();
}
