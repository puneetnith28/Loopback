import { describe, expect, it } from "vitest";
import { evaluateMerge, type CaseEvidence, type LiveSnapshot, type MergePolicy } from "../../apps/switch-gate/src/policy/evaluate.js";
import { InvariantViolation, assertEvidenceIdentity, assertFullSha } from "../../apps/switch-gate/src/policy/invariants.js";

const A = "a".repeat(40);
const policy: MergePolicy = {
  baseBranch: "main", requiredChecks: ["test"], checkSources: new Map([["test", "github-actions"]]),
  gateStatusContext: "loopback/gate", maintainers: new Set(["@m:x"]), quorum: 1,
};
const goodLive: LiveSnapshot = {
  repo: "o/r", prNumber: 42,
  pr: { state: "open", draft: false, merged: false, mergeable: true, headSha: A, baseRef: "main", headRef: "loopback/LB-001", headRepo: "o/r" },
  checks: [{ id: 1, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: A }],
  baseProtection: { requiredStatusContexts: ["test", "loopback/gate"], requiresPullRequest: true, requiresUpToDate: true, blocksForcePush: true, restrictsDeletion: true },
  changedFiles: ["slugify.js"],
};
const goodEv: CaseEvidence = {
  caseId: "LB-001", repo: "o/r", prNumber: 42, caseHeadSha: A,
  verificationRuns: [{ seq: 1, headSha: A, status: "pass", repository: "o/r", prNumber: 42 }],
  approvals: [{ headSha: A, approverId: "@m:x", decision: "approve", repo: "o/r", prNumber: 42 }],
};

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("invariant 8: missing or broken evidence never merges", () => {
  it("the fully populated baseline merges", () => {
    expect(evaluateMerge(goodEv, goodLive, policy).action).toBe("merge");
  });

  it("2,000 randomly degraded snapshots never return merge", () => {
    const rand = rng(20261103);
    const liveKeys = ["pr", "checks", "baseProtection", "changedFiles"] as const;
    const prKeys = ["mergeable", "headSha", "baseRef", "headRepo", "state", "draft", "merged"] as const;
    for (let i = 0; i < 2000; i++) {
      const l: Record<string, unknown> = { ...goodLive, pr: { ...goodLive.pr! } };
      const ev: Record<string, unknown> = { ...goodEv };
      let degraded = 0;
      for (const k of liveKeys) if (rand() < 0.25) { l[k] = undefined; degraded++; }
      if (l.pr && rand() < 0.5) {
        const k = prKeys[Math.floor(rand() * prKeys.length)]!;
        const bad: Record<string, unknown> = { mergeable: null, headSha: "f".repeat(40), baseRef: "other", headRepo: null, state: "closed", draft: true, merged: true };
        (l.pr as Record<string, unknown>)[k] = bad[k];
        degraded++;
      }
      if (rand() < 0.3) { ev.verificationRuns = []; degraded++; }
      if (rand() < 0.3) { ev.approvals = []; degraded++; }
      if (rand() < 0.2) { l.checks = []; degraded++; }
      if (degraded === 0) { l.pr = undefined; }
      const d = evaluateMerge(ev as unknown as CaseEvidence, l as unknown as LiveSnapshot, policy);
      expect(d.action, `iteration ${i}`).not.toBe("merge");
    }
  });
});

describe("assertion helpers", () => {
  it("assertFullSha", () => {
    expect(() => assertFullSha(A, "head")).not.toThrow();
    expect(() => assertFullSha("abc1234", "head")).toThrow(InvariantViolation);
    expect(() => assertFullSha(undefined, "head")).toThrow(InvariantViolation);
  });
  it("assertEvidenceIdentity", () => {
    expect(() => assertEvidenceIdentity({ repository: "o/r", prNumber: 42 }, { repo: "o/r", prNumber: 42 })).not.toThrow();
    expect(() => assertEvidenceIdentity({ repository: "o/r", prNumber: 1 }, { repo: "o/r", prNumber: 42 })).toThrow(InvariantViolation);
    expect(() => assertEvidenceIdentity({ repository: null, prNumber: null }, { repo: "o/r", prNumber: 42 })).toThrow(InvariantViolation);
  });
});
