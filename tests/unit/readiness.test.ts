import { describe, expect, it } from "vitest";
import { evaluateMerge, type CaseEvidence, type LiveSnapshot, type MergePolicy } from "../../apps/switch-gate/src/policy/evaluate.js";
import { explainReadiness } from "../../apps/switch-gate/src/policy/readiness.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const M = "@maintainer:x";

const policy: MergePolicy = {
  baseBranch: "main", requiredChecks: ["test"], checkSources: new Map([["test", "github-actions"]]),
  requiredCheckIntegrations: new Map([["test", 1], ["loopback/gate", 100]]), gateStatusContext: "loopback/gate", maintainers: new Set([M]), quorum: 1,
};
const evidence: CaseEvidence = {
  caseId: "LB-001", repo: "o/r", prNumber: 7, caseHeadSha: HEAD,
  verificationRuns: [{ seq: 1, headSha: HEAD, status: "pass", repository: "o/r", prNumber: 7 }],
  approvals: [{ headSha: HEAD, approverId: M, decision: "approve", repo: "o/r", prNumber: 7 }],
};
const pr = { state: "open", draft: false, merged: false, mergeable: true, headSha: HEAD, baseRef: "main", headRef: "loopback/LB-001", headRepo: "o/r" } as const;
const check = { id: 1, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: HEAD };
const protection = {
  requiredStatusChecks: [{ context: "test", integrationId: 1 }, { context: "loopback/gate", integrationId: 100 }],
  requiresPullRequest: true, requiresUpToDate: true, blocksForcePush: true, restrictsDeletion: true,
};
const live: LiveSnapshot = { repo: "o/r", prNumber: 7, pr, checks: [check], baseProtection: protection, changedFiles: ["src/a.js"], changedFilesHeadSha: HEAD };
const run = (over: object) => ({ seq: 1, headSha: HEAD, status: "pass" as const, repository: "o/r", prNumber: 7, ...over });
const vote = (over: object) => ({ headSha: HEAD, approverId: M, decision: "approve" as const, repo: "o/r", prNumber: 7, ...over });

const mark = (r: ReturnType<typeof explainReadiness>, label: string) => r.items.find((i) => i.label.startsWith(label))?.mark;

describe("explainReadiness", () => {
  it("is ready when everything holds, with every line passing", () => {
    const r = explainReadiness(evidence, live, policy);
    expect(r.ready).toBe(true);
    expect(r.items.every((i) => i.mark === "pass")).toBe(true);
  });

  // Each of these must stop a merge. `why` must never disagree with the policy that decides it.
  const variants = [
    ["PR unreadable", evidence, { ...live, pr: undefined }, policy],
    ["checks unreadable", evidence, { ...live, checks: undefined }, policy],
    ["rules unreadable", evidence, { ...live, baseProtection: undefined }, policy],
    ["files unreadable", evidence, { ...live, changedFiles: undefined }, policy],
    ["files read at another commit", evidence, { ...live, changedFilesHeadSha: OLD }, policy],
    ["draft", evidence, { ...live, pr: { ...pr, draft: true } }, policy],
    ["closed", evidence, { ...live, pr: { ...pr, state: "closed" } }, policy],
    ["already merged", evidence, { ...live, pr: { ...pr, merged: true } }, policy],
    ["conflicts", evidence, { ...live, pr: { ...pr, mergeable: false } }, policy],
    ["mergeability unknown", evidence, { ...live, pr: { ...pr, mergeable: null } }, policy],
    ["wrong base", evidence, { ...live, pr: { ...pr, baseRef: "dev" } }, policy],
    ["fork head", evidence, { ...live, pr: { ...pr, headRepo: "x/r" } }, policy],
    ["head moved", evidence, { ...live, pr: { ...pr, headSha: OLD }, changedFilesHeadSha: OLD }, policy],
    ["other repository", evidence, { ...live, repo: "x/y" }, policy],
    ["CI missing", evidence, { ...live, checks: [] }, policy],
    ["CI from the wrong source", evidence, { ...live, checks: [{ ...check, appSlug: "impostor" }] }, policy],
    ["CI running", evidence, { ...live, checks: [{ ...check, status: "in_progress", conclusion: null }] }, policy],
    ["CI failed", evidence, { ...live, checks: [{ ...check, conclusion: "failure" }] }, policy],
    ["a later CI run failed", evidence, { ...live, checks: [check, { ...check, id: 2, conclusion: "failure" }] }, policy],
    ["protected file", evidence, { ...live, changedFiles: [".github/workflows/ci.yml"] }, policy],
    ["rules: no PR required", evidence, { ...live, baseProtection: { ...protection, requiresPullRequest: false } }, policy],
    ["rules: gate status from the wrong source", evidence, { ...live, baseProtection: { ...protection, requiredStatusChecks: [{ context: "test", integrationId: 1 }, { context: "loopback/gate", integrationId: 999 }] } }, policy],
    ["no verification", { ...evidence, verificationRuns: [] }, live, policy],
    ["verification of an older commit", { ...evidence, verificationRuns: [run({ headSha: OLD })] }, live, policy],
    ["verification running", { ...evidence, verificationRuns: [run({ status: "requested" })] }, live, policy],
    ["a later verification failed", { ...evidence, verificationRuns: [run({}), run({ seq: 2, status: "fail" })] }, live, policy],
    ["verification timed out", { ...evidence, verificationRuns: [run({ status: "timeout" })] }, live, policy],
    ["verification for another PR", { ...evidence, verificationRuns: [run({ prNumber: 8 })] }, live, policy],
    ["no approval", { ...evidence, approvals: [] }, live, policy],
    ["approval of an older commit", { ...evidence, approvals: [vote({ headSha: OLD })] }, live, policy],
    ["approval from a non-maintainer", { ...evidence, approvals: [vote({ approverId: "@x:x" })] }, live, policy],
    ["rejected", { ...evidence, approvals: [vote({}), vote({ decision: "reject" })] }, live, policy],
    ["quorum of two", evidence, live, { ...policy, quorum: 2 }],
    ["malformed policy", evidence, live, { ...policy, requiredCheckIntegrations: new Map() }],
    ["no maintainers", evidence, live, { ...policy, maintainers: new Set() }],
  ] as [string, CaseEvidence, LiveSnapshot, MergePolicy][];

  it.each(variants)("%s: not ready, and at least one line says why", (_name, ev, snapshot, p) => {
    expect(evaluateMerge(ev, snapshot, p).action).not.toBe("merge");
    const r = explainReadiness(ev, snapshot, p);
    expect(r.ready).toBe(false);
    expect(r.items.some((i) => i.mark !== "pass")).toBe(true);
  });

  it("marks each requirement, rather than stopping at the first problem", () => {
    const r = explainReadiness({ ...evidence, verificationRuns: [], approvals: [] }, { ...live, checks: [] }, policy);
    expect(mark(r, "CI test")).toBe("wait");
    expect(mark(r, "Verifier")).toBe("wait");
    expect(mark(r, "Maintainer approval")).toBe("wait");
    expect(mark(r, "Pull request")).toBe("pass");
  });

  it("says plainly that an approval of an older commit does not count", () => {
    const r = explainReadiness({ ...evidence, approvals: [vote({ headSha: OLD })] }, live, policy);
    expect(mark(r, "Maintainer approval")).toBe("fail");
    expect(r.items.find((i) => i.label === "Maintainer approval")?.detail).toMatch(/older commit/);
  });

  it("gives a refusal with no other cause its own line", () => {
    const r = explainReadiness(evidence, { ...live, baseProtection: { ...protection, blocksForcePush: false } }, policy);
    expect(r.items.at(-1)).toMatchObject({ label: "Gate policy", mark: "fail" });
    expect(r.items.at(-1)?.detail).toContain("BASE_UNPROTECTED");
  });
});
