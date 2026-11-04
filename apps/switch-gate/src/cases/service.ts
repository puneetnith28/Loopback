import { isTransient, type AuditEventType, type CaseState, type ReasonCode } from "@loopback/contracts";
import { append, countEvents } from "../audit/index.js";
import type { ChatPort } from "../chat/port.js";
import { formatReason, type ReasonContext } from "../chat/reasons.js";
import { GitHubError, HeadChanged, NotMergeable, RateLimited, type GitHubReader, type PullDetails } from "../github/client.js";
import type { Merger } from "../github/merge.js";
import type { Db } from "../persistence/db.js";
import {
  finishMergeOp, getCase, insertMergeOp, kvGet, kvSet, listApprovals, listCasesInStates, listMergeOps, listRuns,
  listUnfinishedMergeOps, markProcessed, type CaseRecord,
} from "../persistence/repos.js";
import { evaluateMerge, type CaseEvidence, type MergeDecision, type MergePolicy } from "../policy/evaluate.js";
import type { CaseLocks } from "./lock.js";
import { assertTransition, type TransitionTrigger } from "./machine.js";
import type { HaltGuard } from "./halt.js";

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

// ---------------------------------------------------------------------------
// Merge execution and reconciliation (implementation §11, decisions D9, D14, D15, D18)
// ---------------------------------------------------------------------------

export interface MergeDeps {
  readonly db: Db;
  readonly chat: ChatPort;
  readonly github: GitHubReader;
  readonly merger: Merger;
  readonly locks: CaseLocks;
  readonly now: () => Date;
  readonly policy: MergePolicy;
  readonly mergeEnabled: boolean;
  readonly configComplete: boolean;
  /** Stops privileged work at its next write boundary once the gate is halted. */
  readonly halt: HaltGuard;
  readonly transientRetryLimit: number;
  readonly mergeMaxAttempts: number;
  /** Ask the verifier again (requires the case lock). */
  readonly requestVerification: (caseId: string) => Promise<void>;
  /** D17: remember the base commit after a merge the gate confirmed (demo runs). */
  readonly onMergeConfirmed: (mergeCommitSha: string) => void;
  /** Operational log; failures that are retried later are still always recorded here. */
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
}

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/** How long an uncertain merge outcome is given to settle before "not merged" is believed. */
export const UNCERTAIN_SETTLE_MS = 60_000;

export interface MergeReply {
  readonly text: string;
  readonly caseId: string | null;
}

export class MergeExecutor {
  constructor(private readonly d: MergeDeps) {}

  private async announce(c: CaseRecord, text: string): Promise<void> {
    await this.d.chat.post(c.roomId, c.threadId === null ? `[${c.id}] ${text}` : text, c.threadId);
  }

  private audit(c: CaseRecord, actorId: string, type: AuditEventType, targetSha: string | null, reasonCode: ReasonCode | null, payload: Record<string, unknown> = {}): void {
    append(this.d.db, { caseId: c.id, actorId, type, targetSha, reasonCode, payload }, this.d.now());
  }

  private evidence(c: CaseRecord): CaseEvidence {
    return {
      caseId: c.id, repo: c.repo, prNumber: c.prNumber!, caseHeadSha: c.headSha!,
      verificationRuns: listRuns(this.d.db, c.id).map((r) => ({ seq: r.seq, headSha: r.headSha, status: r.status, repository: r.repo, prNumber: r.prNumber })),
      approvals: listApprovals(this.d.db, c.id).map((a) => ({ headSha: a.headSha, approverId: a.approverId, decision: a.decision, repo: a.repo, prNumber: a.prNumber })),
    };
  }

  private refuseNoTransition(c: CaseRecord | null, actorId: string, code: ReasonCode, ctx: ReasonContext = {}): MergeReply {
    append(this.d.db, { caseId: c?.id ?? null, actorId, type: "merge.blocked", reasonCode: code, targetSha: c?.headSha ?? null, payload: {} }, this.d.now());
    return { text: formatReason(code, { caseId: c?.id ?? "", ...ctx }), caseId: c?.id ?? null };
  }

  /** D9: never leave a success status on a commit that was not merged. */
  private async correctGateStatus(c: CaseRecord, sha: string, code: ReasonCode): Promise<void> {
    try {
      await this.d.github.setGateStatus(sha, "failure", `Loopback: not authorized (${code})`);
      this.audit(c, "system", "gate_status.corrected", sha, code);
    } catch {
      this.audit(c, "system", "gate_status.correction_failed", sha, code, { severity: "critical" });
      try {
        await this.announce(c, `ALERT: could not reset the ${this.d.policy.gateStatusContext} status on ${sha.slice(0, 12)} after an aborted merge. Do not merge ${c.id} manually; a maintainer must check the commit status.`);
      } catch {
        // The critical audit event above is the durable record; chat is best effort here.
      }
    }
  }

  private gateStatusOutstanding(c: CaseRecord, sha: string): boolean {
    return countEvents(this.d.db, c.id, "gate_status.posted", sha) > countEvents(this.d.db, c.id, "gate_status.corrected", sha);
  }

  /** Apply a non-merge policy decision from Revalidating. Requires the lock. */
  private async settle(c: CaseRecord, decision: Exclude<MergeDecision, { action: "merge" }>, actorId: string): Promise<MergeReply> {
    const { db, now } = this.d;
    if (decision.action === "stale") {
      const newHead = decision.headSha !== null && decision.headSha !== c.headSha ? decision.headSha : undefined;
      transition(db, {
        caseId: c.id, to: "Stale", actorId, trigger: "system", reason: decision.code, targetSha: decision.headSha,
        ...(newHead ? { updates: { headSha: newHead }, auditType: "commit.changed" as const } : {}),
      }, now());
      await this.d.requestVerification(c.id);
    } else {
      transition(db, { caseId: c.id, to: "Blocked", actorId, trigger: "system", reason: decision.code, targetSha: decision.headSha }, now());
    }
    return { text: formatReason(decision.code, { caseId: c.id, headSha: decision.headSha ?? c.headSha ?? undefined, approvedSha: c.headSha ?? undefined }), caseId: c.id };
  }

  /** The `merge` command. */
  async merge(actorId: string, caseId: string): Promise<MergeReply> {
    return this.d.locks.with(caseId, () => this.mergeLocked(actorId, caseId));
  }

  private async mergeLocked(actorId: string, caseId: string): Promise<MergeReply> {
    const { db, now } = this.d;
    let c = getCase(db, caseId);
    if (!c) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    if (!this.d.mergeEnabled) return this.refuseNoTransition(c, actorId, "MERGE_DISABLED");
    if (!this.d.configComplete) return this.refuseNoTransition(c, actorId, "CONFIG_INCOMPLETE");
    if (c.state === "MergeUnknown") return this.reconcileLocked(caseId);
    this.d.halt.assertRunning("merge");

    if (c.state === "ReadyToMerge") {
      c = transition(db, { caseId, to: "Revalidating", actorId, trigger: "maintainer_merge", reason: null, auditType: "merge.requested" }, now());
    } else if (c.state === "Blocked" && c.blockedReason !== null && isTransient(c.blockedReason) && c.headSha !== null) {
      const used = countEvents(db, c.id, "retry.attempted", c.headSha);
      if (used >= this.d.transientRetryLimit) return this.refuseNoTransition(c, actorId, "RETRY_LIMIT_REACHED");
      const blocked = c;
      c = db.transaction(() => {
        append(db, { caseId, actorId, type: "retry.attempted", targetSha: blocked.headSha, reasonCode: blocked.blockedReason, payload: { attempt: used + 1, limit: this.d.transientRetryLimit } }, now());
        return transitionInTx(db, { caseId, to: "Revalidating", actorId, trigger: "maintainer_merge", reason: blocked.blockedReason }, now());
      })();
    } else {
      return this.refuseNoTransition(c, actorId, "INVALID_STATE", { command: "merge", state: c.state });
    }
    if (c.prNumber === null || c.headSha === null) {
      return this.settle(c, { action: "block", code: "IDENTITY_MISMATCH", message: "case has no PR", headSha: null }, "system");
    }

    // 2–8: live snapshot + pure policy. Any failure here settles the case; nothing is posted yet.
    let decision: MergeDecision;
    try {
      const snap = await this.d.github.snapshot(c.prNumber);
      decision = evaluateMerge(this.evidence(c), snap.snapshot, this.d.policy);
    } catch (e) {
      this.d.halt.assertRunning("merge");
      const code: ReasonCode = e instanceof RateLimited ? "RATE_LIMITED" : "GITHUB_UNAVAILABLE";
      if (!(e instanceof RateLimited) && !(e instanceof GitHubError)) this.d.log?.error({ caseId, op: "revalidate", err: errName(e) }, "unexpected error during revalidation; blocked");
      return this.settle(c, { action: "block", code, message: "", headSha: c.headSha }, "system");
    }
    // Halt boundary: nothing has been written to GitHub for this attempt yet.
    this.d.halt.assertRunning("merge");
    if (decision.action !== "merge") return this.settle(c, decision, "system");
    const sha = decision.headSha;

    // D15: numbered attempts; never a second call while an earlier outcome is open.
    const attempts = listMergeOps(db, c.id, sha);
    if (attempts.some((o) => o.status === "started" || o.status === "unknown")) {
      transition(db, { caseId, to: "Stale", actorId: "system", trigger: "system", reason: "MERGE_OUTCOME_UNKNOWN" }, now());
      return { text: formatReason("MERGE_OUTCOME_UNKNOWN", { caseId }), caseId };
    }
    if (attempts.filter((o) => o.status === "failed").length >= this.d.mergeMaxAttempts) {
      return this.settle(c, { action: "block", code: "MERGE_ATTEMPTS_EXHAUSTED", message: "", headSha: sha }, "system");
    }
    const op = insertMergeOp(db, c.id, sha, attempts.length + 1, now());

    // 9: post the gate status for this SHA, then re-check the head immediately.
    // The audit entry is written BEFORE the POST, so a crash in between still leaves a
    // record that a success status may exist and must be reset (D9).
    this.audit(c, "system", "gate_status.posted", sha, null, { attempt: op.attempt });
    this.d.halt.assertRunning("merge");
    try {
      await this.d.github.setGateStatus(sha, "success", `Approved for ${sha.slice(0, 12)} by Loopback`);
    } catch {
      this.d.halt.assertRunning("merge");
      finishMergeOp(db, op.id, "failed", null, "gate status not confirmed", now());
      await this.correctGateStatus(c, sha, "GITHUB_UNAVAILABLE");
      return this.settle(c, { action: "block", code: "GITHUB_UNAVAILABLE", message: "", headSha: sha }, "system");
    }
    let again: PullDetails | undefined;
    try {
      again = await this.d.github.getPull(c.prNumber);
    } catch {
      again = undefined;
    }
    this.d.halt.assertRunning("merge");
    if (again?.headSha !== sha) {
      finishMergeOp(db, op.id, "failed", null, "head moved before merge", now());
      await this.correctGateStatus(c, sha, again ? "HEAD_MOVED" : "GITHUB_UNAVAILABLE");
      return again
        ? this.settle(c, { action: "stale", code: "HEAD_MOVED", message: "", headSha: again.headSha }, "system")
        : this.settle(c, { action: "block", code: "GITHUB_UNAVAILABLE", message: "", headSha: sha }, "system");
    }

    // 10: merge with GitHub's sha precondition. Last halt boundaries before the irreversible call.
    this.d.halt.assertRunning("merge");
    transition(db, { caseId, to: "Merging", actorId, trigger: "maintainer_merge", reason: null, targetSha: sha, payload: { attempt: op.attempt } }, now());
    // Outside the try: a halt here must not be mistaken for a merge failure.
    this.d.halt.assertRunning("merge");
    try {
      await this.d.merger(c.prNumber, sha);
    } catch (e) {
      const known = e instanceof HeadChanged || e instanceof NotMergeable;
      finishMergeOp(db, op.id, known ? "failed" : "unknown", null, e instanceof Error ? e.name : "error", now());
      transition(db, { caseId, to: "MergeUnknown", actorId: "system", trigger: "system", reason: "MERGE_OUTCOME_UNKNOWN", auditType: known ? "merge.blocked" : "merge.outcome_unknown", targetSha: sha, payload: { error: e instanceof Error ? e.name : "error" } }, now());
      if (!known) await this.announce(c, formatReason("MERGE_OUTCOME_UNKNOWN", { caseId }));
      return this.reconcileLocked(caseId);
    }
    // 11: confirm from GitHub, not from the response alone.
    finishMergeOp(db, op.id, "unknown", null, null, now());
    transition(db, { caseId, to: "MergeUnknown", actorId: "system", trigger: "system", reason: "MERGE_OUTCOME_UNKNOWN", targetSha: sha, payload: { stage: "confirming" } }, now());
    return this.reconcileLocked(caseId);
  }

  /** Reconcile a MergeUnknown case from GitHub (§15.2 as resolved by D14). Requires the lock. */
  async reconcileLocked(caseId: string): Promise<MergeReply> {
    const { db, now } = this.d;
    const c = getCase(db, caseId);
    if (!c) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    if (c.state !== "MergeUnknown" || c.prNumber === null || c.headSha === null) {
      return { text: `${caseId} is ${c.state}; nothing to reconcile.`, caseId };
    }
    let pull: PullDetails;
    try {
      pull = await this.d.github.getPull(c.prNumber);
    } catch (e) {
      // An API failure never means "not merged": stay in MergeUnknown and retry later.
      this.d.log?.warn({ caseId, op: "reconcile", err: errName(e) }, "GitHub read failed; staying MergeUnknown");
      return { text: formatReason("MERGE_OUTCOME_UNKNOWN", { caseId }), caseId };
    }
    const open = listMergeOps(db, c.id).filter((o) => o.status === "started" || o.status === "unknown");
    if (pull.merged && pull.headSha !== c.headSha) {
      this.audit(c, "system", "policy.violation", pull.headSha, null, { detail: "PR merged at a different head than the case recorded", caseHead: c.headSha });
      await this.announce(c, `ALERT: PR #${c.prNumber} was merged at ${pull.headSha.slice(0, 12)}, not the approved ${c.headSha.slice(0, 12)}. Recorded as a policy violation.`);
    }
    if (!pull.merged && open.some((o) => o.status === "unknown" && now().getTime() - Date.parse(o.startedAt) < UNCERTAIN_SETTLE_MS)) {
      // An uncertain outcome is not "not merged" until GitHub has had time to settle (D14).
      return { text: formatReason("MERGE_OUTCOME_UNKNOWN", { caseId }), caseId };
    }
    if (pull.merged) {
      db.transaction(() => {
        for (const o of open) finishMergeOp(db, o.id, "succeeded", pull.mergeCommitSha, null, now());
        transitionInTx(db, { caseId, to: "Merged", actorId: "system", trigger: "reconcile", reason: null, auditType: "merge.confirmed", targetSha: c.headSha, payload: { mergeCommitSha: pull.mergeCommitSha } }, now());
      })();
      const events = (db.prepare("SELECT count(*) AS n FROM audit_events WHERE case_id = ?").get(caseId) as { n: number }).n;
      const text = `MERGED: GitHub confirmed PR #${c.prNumber} merged as ${(pull.mergeCommitSha ?? "unknown").slice(0, 12)}. Audit: ${events} events.`;
      // The merge is recorded; follow-up work must never make it look like a failed merge.
      try {
        if (pull.mergeCommitSha) this.d.onMergeConfirmed(pull.mergeCommitSha);
        await this.announce(c, text);
      } catch (e) {
        this.d.log?.error({ caseId, op: "post-merge", err: errName(e) }, "post-merge follow-up failed; merge itself is recorded");
      }
      return { text, caseId };
    }
    // Confirmed not merged: close open attempts, reset any success status, revalidate.
    db.transaction(() => {
      for (const o of open) finishMergeOp(db, o.id, "failed", null, "confirmed not merged", now());
    })();
    if (this.gateStatusOutstanding(c, c.headSha)) await this.correctGateStatus(c, c.headSha, "MERGE_OUTCOME_UNKNOWN");
    const reval = transition(db, { caseId, to: "Revalidating", actorId: "system", trigger: "reconcile", reason: null }, now());
    let decision: MergeDecision;
    try {
      decision = evaluateMerge(this.evidence(reval), (await this.d.github.snapshot(c.prNumber)).snapshot, this.d.policy);
    } catch (e) {
      decision = { action: "block", code: e instanceof RateLimited ? "RATE_LIMITED" : "GITHUB_UNAVAILABLE", message: "", headSha: c.headSha };
    }
    // D15: reconciliation never merges; a passing revalidation waits for a fresh command.
    const settled: Exclude<MergeDecision, { action: "merge" }> = decision.action === "merge"
      ? { action: "block", code: "AWAITING_MERGE_COMMAND", message: "", headSha: decision.headSha }
      : decision;
    const reply = await this.settle(reval, settled, "system");
    await this.announce(reval, reply.text);
    return reply;
  }

  /** On startup: reconcile cases left mid-merge by a crash, before accepting commands. */
  async reconcileStartup(): Promise<void> {
    const { db } = this.d;
    const ids = new Set(listUnfinishedMergeOps(db).map((o) => o.caseId));
    for (const c of listCasesInStates(db, ["Merging", "MergeUnknown", "Revalidating"])) ids.add(c.id);
    for (const id of ids) {
      try {
        await this.d.locks.with(id, () => this.recoverLocked(id));
      } catch (e) {
        // One case failing must not stop the others; reconcileUnknown() retries it periodically.
        this.d.log?.error({ caseId: id, op: "startup-recover", err: errName(e) }, "recovery failed; will retry");
      }
    }
  }

  /**
   * Periodic, read-only recovery (never merges): MergeUnknown is reconciled from GitHub;
   * Merging/Revalidating outside an active merge (the lock is free) are recovered as at startup.
   */
  async reconcileUnknown(): Promise<void> {
    for (const c of listCasesInStates(this.d.db, ["MergeUnknown", "Merging", "Revalidating"])) {
      try {
        await this.d.locks.with(c.id, () => this.recoverLocked(c.id));
      } catch (e) {
        this.d.log?.error({ caseId: c.id, op: "reconcile", err: errName(e) }, "reconciliation failed; will retry");
      }
    }
  }

  private async recoverLocked(id: string): Promise<void> {
    const { db, now } = this.d;
    {
      {
        const c = getCase(db, id);
        if (!c) return;
        if (c.state === "Merging") {
          transition(db, { caseId: id, to: "MergeUnknown", actorId: "system", trigger: "system", reason: "MERGE_OUTCOME_UNKNOWN", auditType: "merge.outcome_unknown", payload: { cause: "restart" } }, now());
        } else if (c.state === "Revalidating") {
          // Interrupted before the merge call (Merging is entered first): no merge happened.
          // Close open attempts, reset any success status, and wait for a fresh command.
          for (const o of listMergeOps(db, id).filter((x) => x.status === "started" || x.status === "unknown")) {
            finishMergeOp(db, o.id, "failed", null, "interrupted before merge call", now());
          }
          if (c.headSha !== null && this.gateStatusOutstanding(c, c.headSha)) await this.correctGateStatus(c, c.headSha, "AWAITING_MERGE_COMMAND");
          transition(db, { caseId: id, to: "Blocked", actorId: "system", trigger: "system", reason: "AWAITING_MERGE_COMMAND", payload: { cause: "restart" } }, now());
          return;
        }
        if (getCase(db, id)?.state === "MergeUnknown") await this.reconcileLocked(id);
      }
    }
  }
}
