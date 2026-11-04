import type { ReasonCode } from "@loopback/contracts";

// Pure merge policy (implementation §10.6, amended by D11, D12, D13, D15, D17, D19).
// No I/O: every input is a snapshot. Anything missing or ambiguous blocks.

export interface LivePull {
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  /** owner/repo of the PR head; must equal the case repository (no fork PRs). */
  readonly headRepo: string | null;
}

export interface LiveCheck {
  readonly id: number;
  readonly name: string;
  readonly appSlug: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
}

/** The branch-protection rules GitHub exposes at runtime for the base branch (D17). */
export interface BaseProtection {
  readonly requiredStatusContexts: readonly string[];
  readonly requiresPullRequest: boolean;
  readonly requiresUpToDate: boolean;
  readonly blocksForcePush: boolean;
  readonly restrictsDeletion: boolean;
}

export interface LiveSnapshot {
  readonly repo: string;
  readonly prNumber: number;
  readonly pr: LivePull | undefined;
  readonly checks: readonly LiveCheck[] | undefined;
  readonly baseProtection: BaseProtection | undefined;
  readonly changedFiles: readonly string[] | undefined;
}

export interface VerificationRunEvidence {
  /** Monotonic insertion order; the highest seq for the live head is "latest". */
  readonly seq: number;
  readonly headSha: string;
  readonly status: "requested" | "pass" | "fail" | "invalid" | "timeout";
  readonly repository: string | null;
  readonly prNumber: number | null;
}

export interface ApprovalEvidence {
  readonly headSha: string;
  readonly approverId: string;
  readonly decision: "approve" | "reject";
  readonly repo: string;
  readonly prNumber: number;
}

export interface CaseEvidence {
  readonly caseId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly caseHeadSha: string;
  readonly verificationRuns: readonly VerificationRunEvidence[];
  readonly approvals: readonly ApprovalEvidence[];
}

export interface MergePolicy {
  readonly baseBranch: string;
  readonly requiredChecks: readonly string[];
  readonly checkSources: ReadonlyMap<string, string>;
  readonly gateStatusContext: string;
  readonly maintainers: ReadonlySet<string>;
  readonly quorum: number;
}

export type MergeDecision =
  | { readonly action: "merge"; readonly headSha: string; readonly reasons: readonly string[] }
  | { readonly action: "stale"; readonly code: ReasonCode; readonly message: string; readonly headSha: string | null }
  | { readonly action: "block"; readonly code: ReasonCode; readonly message: string; readonly headSha: string | null };

/** D19: paths a fix must not touch. A change here blocks the merge. */
export function isProtectedPath(path: string): boolean {
  const p = path.replace(/^\.\/+/, "");
  return (
    p.startsWith(".github/") ||
    p === "package.json" ||
    p.endsWith("/package.json") ||
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p) ||
    /(^|\/)\.?(mocharc|nycrc|babelrc)(\.[a-z]+)?$/.test(p) ||
    /(^|\/)(vitest|jest|karma|ava|mocha)\.config\.[cm]?[jt]s$/.test(p) ||
    /(^|\/)\.npmrc$/.test(p)
  );
}

const short = (sha: string) => sha.slice(0, 12);
const block = (code: ReasonCode, message: string, headSha: string | null = null): MergeDecision =>
  ({ action: "block", code, message, headSha });
const stale = (code: ReasonCode, message: string, headSha: string | null = null): MergeDecision =>
  ({ action: "stale", code, message, headSha });

export function evaluateMerge(ev: CaseEvidence, live: LiveSnapshot, p: MergePolicy): MergeDecision {
  const { pr, checks, baseProtection, changedFiles } = live;
  if (!pr || !checks || !baseProtection || !changedFiles) {
    return block("GITHUB_UNAVAILABLE", "Could not read current PR state from GitHub.");
  }
  if (live.repo !== ev.repo || live.prNumber !== ev.prNumber) {
    return block("IDENTITY_MISMATCH", "PR identity does not match case.");
  }
  if (pr.headRepo !== ev.repo) return block("IDENTITY_MISMATCH", "PR head is not in the case repository.");
  if (pr.merged) return block("ALREADY_MERGED", "PR is already merged.");
  if (pr.state !== "open") return block("PR_CLOSED", "PR is closed.");
  if (pr.draft) return block("PR_DRAFT", "PR is a draft.");
  if (pr.mergeable === false) return block("NOT_MERGEABLE", "GitHub reports the PR is not mergeable.");
  if (pr.mergeable === null) return block("MERGEABILITY_UNKNOWN", "GitHub has not determined whether the PR is mergeable.");
  if (pr.baseRef !== p.baseBranch) return block("WRONG_BASE", `PR targets ${pr.baseRef}, not ${p.baseBranch}.`);

  const contexts = new Set(baseProtection.requiredStatusContexts);
  const missingContexts = [...p.requiredChecks, p.gateStatusContext].filter((c) => !contexts.has(c));
  if (
    missingContexts.length > 0 ||
    !baseProtection.requiresPullRequest ||
    !baseProtection.requiresUpToDate ||
    !baseProtection.blocksForcePush ||
    !baseProtection.restrictsDeletion
  ) {
    return block("BASE_UNPROTECTED", `Required protection is not active on ${p.baseBranch}.`);
  }

  const touched = changedFiles.filter(isProtectedPath);
  if (touched.length > 0) {
    return block("PROTECTED_PATH_CHANGED", `PR changes protected paths: ${touched.slice(0, 5).join(", ")}.`);
  }

  const head = pr.headSha;
  if (head !== ev.caseHeadSha) {
    return stale("HEAD_MOVED", `PR now points to ${short(head)}; case recorded ${short(ev.caseHeadSha)}.`, head);
  }

  for (const name of p.requiredChecks) {
    const source = p.checkSources.get(name);
    if (source === undefined) return block("CI_MISSING", `Required check "${name}" has no configured source.`, head);
    const runs = checks.filter((c) => c.name === name && c.appSlug === source && c.headSha === head);
    if (runs.length === 0) return block("CI_MISSING", `Required check "${name}" has no run for ${short(head)}.`, head);
    // D13: never assume API order; ids must be unique positive integers.
    const ids = runs.map((r) => r.id);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
      return block("CI_MISSING", `Cannot determine the latest "${name}" run for ${short(head)}.`, head);
    }
    const latest = [...runs].sort((a, b) => a.id - b.id).at(-1)!;
    if (latest.status !== "completed") return block("CI_PENDING", `Required check "${name}" is still running.`, head);
    if (latest.conclusion !== "success") {
      return block("CI_FAILED", `Required check "${name}" concluded ${latest.conclusion ?? "without a result"} for ${short(head)}.`, head);
    }
  }

  const forHead = ev.verificationRuns.filter((r) => r.headSha === head);
  if (forHead.length === 0) {
    return ev.verificationRuns.length > 0
      ? stale("VERIFICATION_STALE", `Verification is for an older commit, not ${short(head)}.`, head)
      : block("VERIFICATION_MISSING", "No verifier result recorded.", head);
  }
  const latestRun = [...forHead].sort((a, b) => a.seq - b.seq).at(-1)!;
  switch (latestRun.status) {
    case "requested":
      return block("VERIFICATION_PENDING", `Verification of ${short(head)} has not completed.`, head);
    case "invalid":
      return block("VERIFICATION_INVALID", "The latest verifier output was invalid.", head);
    case "timeout":
      return block("VERIFICATION_TIMEOUT", "The latest verification timed out.", head);
    case "fail":
      return block("VERIFICATION_FAILED", "Verifier verdict is fail.", head);
    case "pass":
      break;
  }
  if (latestRun.repository !== ev.repo || latestRun.prNumber !== ev.prNumber) {
    return block("VERIFICATION_IDENTITY", "Verifier evidence is for a different PR.", head);
  }

  const samePr = ev.approvals.filter((a) => a.repo === ev.repo && a.prNumber === ev.prNumber && p.maintainers.has(a.approverId));
  const current = samePr.filter((a) => a.headSha === head);
  if (current.some((a) => a.decision === "reject")) return block("REJECTED", "A maintainer rejected this revision.", head);
  const approvers = new Set(current.filter((a) => a.decision === "approve").map((a) => a.approverId));
  if (approvers.size < p.quorum) {
    const older = samePr.some((a) => a.decision === "approve" && a.headSha !== head);
    return older
      ? stale("APPROVAL_STALE", `Approval is for an older commit. The PR now points to ${short(head)}.`, head)
      : block("APPROVAL_MISSING", `Needs ${p.quorum} maintainer approval(s) for ${short(head)}; has ${approvers.size}.`, head);
  }

  return {
    action: "merge",
    headSha: head,
    reasons: ["CI ok", "verifier pass", `${approvers.size} approval(s) for ${short(head)}`],
  };
}
