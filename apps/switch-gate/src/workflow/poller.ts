import { displaySha, type CaseState } from "@loopback/contracts";
import { append } from "../audit/index.js";
import { transitionInTx } from "../cases/service.js";
import { formatReason } from "../chat/reasons.js";
import type { PullDetails } from "../github/client.js";
import { kvGet, kvSet, listCasesInStates, recordCiEvidence, recordCommit, type CaseRecord, getCase } from "../persistence/repos.js";
import type { VerificationWorkflow, WorkflowDeps } from "./verification.js";

/** States whose PR the poller watches. Merge-path states are owned by the merge executor. */
const WATCHED: readonly CaseState[] = [
  "FixInProgress", "PRCreated", "Verifying", "VerificationFailed", "AwaitingApproval", "ReadyToMerge", "Stale", "Blocked",
];
const STALE_ON_HEAD_CHANGE: ReadonlySet<CaseState> = new Set(["PRCreated", "Verifying", "AwaitingApproval", "ReadyToMerge"]);
const PR_CLOSED_SOURCES: ReadonlySet<CaseState> = new Set(["PRCreated", "Verifying", "VerificationFailed", "AwaitingApproval", "ReadyToMerge", "Stale"]);

export interface PollerLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Reads GitHub for every active case (implementation §10.8). GitHub is the source
 * of truth: the poller never trusts agent claims about PRs, heads or CI.
 */
export class Poller {
  private running = false;

  constructor(private readonly d: WorkflowDeps, private readonly wf: VerificationWorkflow, private readonly log: PollerLog) {}

  private async announce(c: CaseRecord, text: string): Promise<void> {
    await this.d.chat.post(c.roomId, c.threadId === null ? `[${c.id}] ${text}` : text, c.threadId);
  }

  /** One pass over all watched cases. Overlapping ticks are skipped (single-flight). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const c of listCasesInStates(this.d.db, WATCHED)) {
        try {
          await this.d.locks.with(c.id, () => this.pollCase(c.id));
        } catch (e) {
          this.log.warn({ caseId: c.id, err: e instanceof Error ? e.name : "unknown" }, "poll failed; will retry next tick");
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Requires the case lock. */
  async pollCase(caseId: string): Promise<void> {
    const c = getCase(this.d.db, caseId);
    if (!c) return;
    if (c.state === "FixInProgress") return this.discover(c);
    if (c.prNumber === null || c.headSha === null) return;
    const pr = await this.d.github.getPull(c.prNumber);

    if (pr.merged) return this.mergedOutside(c, pr);
    if (pr.state === "closed") {
      if (!PR_CLOSED_SOURCES.has(c.state)) return;
      this.d.db.transaction(() => transitionInTx(this.d.db, {
        caseId: c.id, to: "Blocked", actorId: "system", trigger: "poller", reason: "PR_CLOSED", targetSha: c.headSha,
      }, this.d.now()))();
      return this.announce(c, formatReason("PR_CLOSED", { caseId: c.id }));
    }
    if (pr.headSha !== c.headSha) return this.headChanged(c, pr);

    await this.collectCi(c, pr.headSha);
    if (c.state === "Stale") await this.wf.requestVerificationLocked(c.id, "system", false);
    if (c.state === "Verifying") await this.wf.progressLocked(c.id);
  }

  private async discover(c: CaseRecord): Promise<void> {
    const pr = await this.d.github.findOpenPullByBranch(c.branch ?? `loopback/${c.id}`);
    if (!pr) return;
    if (pr.baseRef !== this.d.baseBranch || pr.headRepo !== this.d.repo) {
      const key = `warned:${c.id}:${pr.number}:${pr.baseRef}`;
      if (kvGet(this.d.db, key) === undefined) {
        this.d.db.transaction(() => {
          kvSet(this.d.db, key, "1");
          append(this.d.db, {
            caseId: c.id, actorId: "system", type: "merge.blocked", targetSha: pr.headSha,
            reasonCode: pr.baseRef !== this.d.baseBranch ? "WRONG_BASE" : "IDENTITY_MISMATCH",
            payload: { pr: pr.number, baseRef: pr.baseRef, headRepo: pr.headRepo },
          }, this.d.now());
        })();
        await this.announce(c, `PR #${pr.number} was ignored: it must target ${this.d.baseBranch} from ${this.d.repo}.`);
      }
      return;
    }
    this.d.db.transaction(() => {
      recordCommit(this.d.db, c.id, pr.headSha, pr.baseSha, this.d.now());
      transitionInTx(this.d.db, {
        caseId: c.id, to: "PRCreated", actorId: "system", trigger: "poller", reason: null, auditType: "pr.created",
        targetSha: pr.headSha, updates: { prNumber: pr.number, headSha: pr.headSha }, payload: { pr: pr.number },
      }, this.d.now());
    })();
    await this.announce(c, `PR #${pr.number} found on GitHub at ${displaySha(pr.headSha)}. Requesting independent verification.`);
    await this.wf.requestVerificationLocked(c.id, "system", false);
  }

  private async headChanged(c: CaseRecord, pr: PullDetails): Promise<void> {
    const { db, now } = this.d;
    if (STALE_ON_HEAD_CHANGE.has(c.state) || c.state === "Stale") {
      db.transaction(() => {
        recordCommit(db, c.id, pr.headSha, pr.baseSha, now());
        if (c.state === "Stale") {
          append(db, { caseId: c.id, actorId: "system", type: "commit.changed", targetSha: pr.headSha, payload: { previous: c.headSha } }, now());
          db.prepare("UPDATE cases SET head_sha = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'Stale'").run(pr.headSha, now().toISOString(), c.id);
        } else {
          transitionInTx(db, {
            caseId: c.id, to: "Stale", actorId: "system", trigger: "poller", reason: "HEAD_MOVED", auditType: "commit.changed",
            targetSha: pr.headSha, updates: { headSha: pr.headSha }, payload: { previous: c.headSha },
          }, now());
        }
      })();
      await this.announce(c,
        `New commit detected: ${displaySha(pr.headSha)} (was ${displaySha(c.headSha!)}). Previous approval and verification no longer apply. Re-verifying.`);
      await this.wf.requestVerificationLocked(c.id, "system", false);
      return;
    }
    // VerificationFailed / Blocked: record and audit only; a maintainer retask continues (D14).
    const fresh = db.transaction(() => {
      const added = recordCommit(db, c.id, pr.headSha, pr.baseSha, now());
      if (added) append(db, { caseId: c.id, actorId: "system", type: "commit.changed", targetSha: pr.headSha, payload: { previous: c.headSha, state: c.state } }, now());
      return added;
    })();
    if (fresh) await this.announce(c, `New commit ${displaySha(pr.headSha)} recorded while ${c.state}. A maintainer must retask ${c.id} to continue.`);
  }

  private async mergedOutside(c: CaseRecord, pr: PullDetails): Promise<void> {
    const key = `violation:${c.id}:${pr.number}`;
    if (kvGet(this.d.db, key) !== undefined) return;
    this.d.db.transaction(() => {
      kvSet(this.d.db, key, "1");
      append(this.d.db, {
        caseId: c.id, actorId: "system", type: "policy.violation", targetSha: pr.headSha,
        payload: { pr: pr.number, mergeCommitSha: pr.mergeCommitSha, state: c.state, detail: "PR merged outside Loopback" },
      }, this.d.now());
    })();
    await this.announce(c, `ALERT: PR #${pr.number} was merged outside Loopback while ${c.id} was ${c.state}. Recorded as a policy violation.`);
  }

  private async collectCi(c: CaseRecord, headSha: string): Promise<void> {
    const runs = await this.d.github.listCheckRuns(headSha);
    for (const name of this.d.requiredChecks) {
      const source = this.d.checkSources.get(name);
      for (const r of runs.filter((x) => x.name === name && x.appSlug === source && x.headSha === headSha)) {
        const added = recordCiEvidence(this.d.db, {
          caseId: c.id, headSha, checkName: name, checkRunId: r.id, appSlug: r.appSlug, status: r.status, conclusion: r.conclusion, htmlUrl: r.htmlUrl,
        }, this.d.now());
        if (added && r.status === "completed") {
          append(this.d.db, { caseId: c.id, actorId: "system", type: "ci.observed", targetSha: headSha, payload: { check: name, conclusion: r.conclusion, runId: r.id } }, this.d.now());
        }
      }
    }
  }
}
