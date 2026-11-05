import { evaluateMerge, isProtectedPath, type CaseEvidence, type LiveSnapshot, type MergeDecision, type MergePolicy } from "./evaluate.js";

// The `why` checklist: every merge requirement at once, for people, where evaluateMerge stops at
// the first problem. Pure, like evaluateMerge, and always subordinate to it: `ready` is true only
// when evaluateMerge itself says merge and no line disagrees, so this can never unlock anything.

export type Mark = "pass" | "wait" | "fail";

export interface ReadinessItem {
  readonly label: string;
  readonly mark: Mark;
  /** May contain values from GitHub (branch names, file paths): escape before showing it. */
  readonly detail: string;
}

export interface Readiness {
  readonly items: readonly ReadinessItem[];
  readonly decision: MergeDecision;
  readonly ready: boolean;
}

const short = (sha: string): string => sha.slice(0, 12);
const item = (label: string, mark: Mark, detail: string): ReadinessItem => ({ label, mark, detail });

function pullItem(ev: CaseEvidence, live: LiveSnapshot, p: MergePolicy): ReadinessItem {
  const label = `Pull request #${ev.prNumber}`;
  const { pr } = live;
  if (!pr) return item(label, "fail", "could not be read from GitHub");
  if (pr.merged) return item(label, "pass", "already merged");
  if (pr.state !== "open") return item(label, "fail", "is closed");
  if (pr.draft) return item(label, "fail", "is a draft");
  if (pr.baseRef !== p.baseBranch) return item(label, "fail", `targets ${pr.baseRef}, not ${p.baseBranch}`);
  if (pr.mergeable === false) return item(label, "fail", "has conflicts GitHub cannot merge");
  if (pr.mergeable === null) return item(label, "wait", "GitHub is still working out whether it can merge");
  return item(label, "pass", `open, mergeable, targets ${pr.baseRef}`);
}

function commitItem(ev: CaseEvidence, head: string | undefined): ReadinessItem {
  if (head === undefined) return item("Commit", "fail", "the PR's head could not be read");
  return head === ev.caseHeadSha
    ? item("Commit", "pass", `${short(head)} is still the PR's head`)
    : item("Commit", "fail", `the PR moved to ${short(head)}; evidence for ${short(ev.caseHeadSha)} no longer counts`);
}

function ciItems(live: LiveSnapshot, p: MergePolicy, head: string | undefined): readonly ReadinessItem[] {
  return p.requiredChecks.map((name) => {
    const label = `CI ${name}`;
    if (head === undefined || live.checks === undefined) return item(label, "fail", "could not be read from GitHub");
    const source = p.checkSources.get(name);
    const runs = live.checks.filter((c) => c.name === name && c.appSlug === source && c.headSha === head);
    if (runs.length === 0) return item(label, "wait", `no run yet on ${short(head)}`);
    const latest = [...runs].sort((a, b) => a.id - b.id).at(-1)!;
    if (latest.status !== "completed") return item(label, "wait", `still running on ${short(head)}`);
    return latest.conclusion === "success"
      ? item(label, "pass", `passed on ${short(head)}`)
      : item(label, "fail", `concluded ${latest.conclusion ?? "without a result"} on ${short(head)}`);
  });
}

function verifierItem(ev: CaseEvidence, head: string | undefined): ReadinessItem {
  const label = "Verifier";
  if (head === undefined) return item(label, "fail", "the commit to verify is unknown");
  const forHead = ev.verificationRuns.filter((r) => r.headSha === head);
  if (forHead.length === 0) {
    return ev.verificationRuns.length > 0
      ? item(label, "wait", `only older commits were verified, not ${short(head)}`)
      : item(label, "wait", `no result yet for ${short(head)}`);
  }
  const latest = forHead.reduce((a, b) => (b.seq > a.seq ? b : a));
  switch (latest.status) {
    case "pass": return item(label, "pass", `passed ${short(head)}`);
    case "requested": return item(label, "wait", `working on ${short(head)}`);
    case "superseded": return item(label, "wait", "the latest run was replaced by a newer request");
    case "timeout": return item(label, "fail", `timed out on ${short(head)}`);
    case "invalid": return item(label, "fail", "its latest report was not valid");
    case "fail": return item(label, "fail", `failed ${short(head)}`);
  }
}

function approvalItem(ev: CaseEvidence, p: MergePolicy, head: string | undefined): ReadinessItem {
  const label = "Maintainer approval";
  if (head === undefined) return item(label, "fail", "the commit to approve is unknown");
  const samePr = ev.approvals.filter((a) => a.repo === ev.repo && a.prNumber === ev.prNumber && p.maintainers.has(a.approverId));
  const current = samePr.filter((a) => a.headSha === head);
  if (current.some((a) => a.decision === "reject")) return item(label, "fail", `a maintainer rejected ${short(head)}`);
  const count = new Set(current.filter((a) => a.decision === "approve").map((a) => a.approverId)).size;
  if (count >= p.quorum) return item(label, "pass", `${count} of ${p.quorum} for ${short(head)}`);
  return samePr.some((a) => a.decision === "approve" && a.headSha !== head)
    ? item(label, "fail", `the approval was for an older commit and does not count for ${short(head)}`)
    : item(label, "wait", `${count} of ${p.quorum} for ${short(head)}`);
}

function changedFilesItem(live: LiveSnapshot): ReadinessItem {
  const label = "Changed files";
  if (live.changedFiles === undefined) return item(label, "fail", "could not be read from GitHub");
  const touched = live.changedFiles.filter(isProtectedPath);
  return touched.length > 0
    ? item(label, "fail", `changes protected files: ${touched.slice(0, 5).join(", ")}`)
    : item(label, "pass", "no CI, dependency or test-configuration files changed");
}

/** Why a case can or cannot merge right now. Read-only, like the evidence and snapshot it takes. */
export function explainReadiness(ev: CaseEvidence, live: LiveSnapshot, p: MergePolicy): Readiness {
  const decision = evaluateMerge(ev, live, p);
  const head = live.pr?.headSha;
  const items: ReadinessItem[] = [
    pullItem(ev, live, p), commitItem(ev, head), ...ciItems(live, p, head), verifierItem(ev, head),
    approvalItem(ev, p, head), changedFilesItem(live),
  ];
  // Whatever else the policy refuses (branch rules, check sources, identity) gets a line of its own,
  // so a refusal is never hidden behind a list of passes.
  if (decision.action !== "merge" && items.every((i) => i.mark === "pass")) {
    items.push(item("Gate policy", "fail", `${decision.code}: ${decision.message}`));
  }
  return { items, decision, ready: decision.action === "merge" && items.every((i) => i.mark === "pass") };
}
