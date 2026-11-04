import { describe, expect, it } from "vitest";
import {
  evaluateMerge,
  isProtectedPath,
  type CaseEvidence,
  type LiveSnapshot,
  type MergePolicy,
} from "../../apps/switch-gate/src/policy/evaluate.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const MAINT = "@switch-user-maint:x";
const MAINT2 = "@switch-user-maint2:x";

const policy: MergePolicy = {
  baseBranch: "main",
  requiredChecks: ["test"],
  checkSources: new Map([["test", "github-actions"]]),
  requiredCheckIntegrations: new Map([["test", 15368], ["loopback/gate", 5598944]]),
  gateStatusContext: "loopback/gate",
  maintainers: new Set([MAINT, MAINT2]),
  quorum: 1,
};

function live(over: Partial<LiveSnapshot> = {}, pr: Partial<NonNullable<LiveSnapshot["pr"]>> = {}): LiveSnapshot {
  const headSha = pr.headSha ?? A;
  return {
    changedFilesHeadSha: headSha,
    repo: "o/r",
    prNumber: 42,
    pr: { state: "open", draft: false, merged: false, mergeable: true, headSha: A, baseRef: "main", headRef: "loopback/LB-001", headRepo: "o/r", ...pr },
    checks: [{ id: 10, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: A }],
    baseProtection: {
      requiredStatusChecks: [
        { context: "test", integrationId: 15368 },
        { context: "loopback/gate", integrationId: 5598944 },
      ],
      requiresPullRequest: true,
      requiresUpToDate: true,
      blocksForcePush: true,
      restrictsDeletion: true,
    },
    changedFiles: ["slugify.js", "test/slugify.js"],
    ...over,
  };
}

function evidence(over: Partial<CaseEvidence> = {}): CaseEvidence {
  return {
    caseId: "LB-001", repo: "o/r", prNumber: 42, caseHeadSha: A,
    verificationRuns: [{ seq: 1, headSha: A, status: "pass", repository: "o/r", prNumber: 42 }],
    approvals: [{ headSha: A, approverId: MAINT, decision: "approve", repo: "o/r", prNumber: 42 }],
    ...over,
  };
}

const code = (ev: CaseEvidence, l: LiveSnapshot, p: MergePolicy = policy) => {
  const d = evaluateMerge(ev, l, p);
  return d.action === "merge" ? "MERGE" : `${d.action}:${d.code}`;
};

describe("evaluateMerge: §16.2 acceptance rows", () => {
  it("merges when all evidence matches head", () => {
    const d = evaluateMerge(evidence(), live(), policy);
    expect(d).toMatchObject({ action: "merge", headSha: A });
  });
  it("blocks without approval", () => expect(code(evidence({ approvals: [] }), live())).toBe("block:APPROVAL_MISSING"));
  it("blocks without verifier", () => expect(code(evidence({ verificationRuns: [] }), live())).toBe("block:VERIFICATION_MISSING"));
  it("ci states (table)", () => {
    const run = (status: string, conclusion: string | null) =>
      live({ checks: [{ id: 1, name: "test", appSlug: "github-actions", status, conclusion, headSha: A }] });
    expect(code(evidence(), run("in_progress", null))).toBe("block:CI_PENDING");
    expect(code(evidence(), run("queued", null))).toBe("block:CI_PENDING");
    for (const c of ["failure", "cancelled", "timed_out", "neutral", "skipped", "action_required"]) {
      expect(code(evidence(), run("completed", c)), c).toBe("block:CI_FAILED");
    }
    expect(code(evidence(), live({ checks: [] }))).toBe("block:CI_MISSING");
  });
  it("pr states", () => {
    expect(code(evidence(), live({}, { state: "closed" }))).toBe("block:PR_CLOSED");
    expect(code(evidence(), live({}, { draft: true }))).toBe("block:PR_DRAFT");
    expect(code(evidence(), live({}, { merged: true }))).toBe("block:ALREADY_MERGED");
    expect(code(evidence(), live({}, { mergeable: false }))).toBe("block:NOT_MERGEABLE");
  });
  it("undefined snapshot blocks", () => {
    expect(code(evidence(), live({ pr: undefined }))).toBe("block:GITHUB_UNAVAILABLE");
    expect(code(evidence(), live({ checks: undefined }))).toBe("block:GITHUB_UNAVAILABLE");
    expect(code(evidence(), live({ baseProtection: undefined }))).toBe("block:GITHUB_UNAVAILABLE");
    expect(code(evidence(), live({ changedFiles: undefined }))).toBe("block:GITHUB_UNAVAILABLE");
  });
  it("stale approval: head changed after approval", () => {
    const l = live({ checks: [{ id: 2, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: B }] }, { headSha: B });
    const ev = evidence({ caseHeadSha: B, verificationRuns: [{ seq: 2, headSha: B, status: "pass", repository: "o/r", prNumber: 42 }] });
    expect(code(ev, l)).toBe("stale:APPROVAL_STALE");
  });
  it("head moved beyond the recorded case head is stale", () => {
    expect(code(evidence(), live({}, { headSha: B }))).toBe("stale:HEAD_MOVED");
  });
  it("ci bound to sha: CI passes for A, fails for B", () => {
    const checks = [
      { id: 1, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: A },
      { id: 2, name: "test", appSlug: "github-actions", status: "completed", conclusion: "failure", headSha: B },
    ];
    const ev = evidence({ caseHeadSha: B, verificationRuns: [{ seq: 1, headSha: B, status: "pass", repository: "o/r", prNumber: 42 }],
      approvals: [{ headSha: B, approverId: MAINT, decision: "approve", repo: "o/r", prNumber: 42 }] });
    expect(code(ev, live({ checks }, { headSha: B }))).toBe("block:CI_FAILED");
    // and a success for A alone does not count for B
    expect(code(ev, live({ checks: [checks[0]!] }, { headSha: B }))).toBe("block:CI_MISSING");
  });
  it("verifier stale: verifier passed A while PR at B", () => {
    const ev = evidence({ caseHeadSha: B });
    const l = live({ checks: [{ id: 2, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: B }] }, { headSha: B });
    expect(code(ev, l)).toBe("stale:VERIFICATION_STALE");
  });
});

describe("evaluateMerge: decisions and amendments", () => {
  it("identity mismatches block", () => {
    expect(code(evidence(), live({ prNumber: 43 }))).toBe("block:IDENTITY_MISMATCH");
    expect(code(evidence(), live({ repo: "o/other" }))).toBe("block:IDENTITY_MISMATCH");
    expect(code(evidence(), live({}, { headRepo: "attacker/r" }))).toBe("block:IDENTITY_MISMATCH");
    expect(code(evidence(), live({}, { headRepo: null }))).toBe("block:IDENTITY_MISMATCH");
  });
  it("D15: mergeable null blocks as MERGEABILITY_UNKNOWN", () => {
    expect(code(evidence(), live({}, { mergeable: null }))).toBe("block:MERGEABILITY_UNKNOWN");
  });
  it("D12/D17: exact base branch and required protection", () => {
    expect(code(evidence(), live({}, { baseRef: "demo/20261105-0000000000000000" }))).toBe("block:WRONG_BASE");
    const prot = live().baseProtection!;
    for (const broken of [
      { ...prot, requiresPullRequest: false },
      { ...prot, requiresUpToDate: false },
      { ...prot, blocksForcePush: false },
      { ...prot, restrictsDeletion: false },
    ]) {
      expect(code(evidence(), live({ baseProtection: broken }))).toBe("block:BASE_UNPROTECTED");
    }
  });

  describe("runtime status check source validation mutations", () => {
    const prot = live().baseProtection!;

    it("fails closed with CHECK_SOURCE_MISMATCH when a required context has no ruleset entry (item B.5)", () => {
      // test context exists in policy but has no entry in ruleset
      const missingTest = {
        ...prot,
        requiredStatusChecks: [
          { context: "loopback/gate", integrationId: 5598944 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: missingTest }))).toBe("block:CHECK_SOURCE_MISMATCH");

      // gate context exists in policy but has no entry in ruleset
      const missingGate = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 15368 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: missingGate }))).toBe("block:CHECK_SOURCE_MISMATCH");

      // empty ruleset entries
      expect(code(evidence(), live({ baseProtection: { ...prot, requiredStatusChecks: [] } }))).toBe("block:CHECK_SOURCE_MISMATCH");
    });

    it("mutation: accepting a null source fails closed (CHECK_SOURCE_MISMATCH)", () => {
      // test check has null integration ID (e.g. unpinned or unverified GitHub Action)
      const nullCheckSource = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: null },
          { context: "loopback/gate", integrationId: 5598944 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: nullCheckSource }))).toBe("block:CHECK_SOURCE_MISMATCH");

      // loopback/gate has null integration ID
      const nullGateSource = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 15368 },
          { context: "loopback/gate", integrationId: null },
        ],
      };
      expect(code(evidence(), live({ baseProtection: nullGateSource }))).toBe("block:CHECK_SOURCE_MISMATCH");
    });

    it("mutation: ignoring an integration ID fails closed (CHECK_SOURCE_MISMATCH)", () => {
      // test check has unexpected / mismatched integration ID
      const wrongCheckSource = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 99999 },
          { context: "loopback/gate", integrationId: 5598944 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: wrongCheckSource }))).toBe("block:CHECK_SOURCE_MISMATCH");

      // loopback/gate has unexpected / mismatched integration ID
      const wrongGateSource = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 15368 },
          { context: "loopback/gate", integrationId: 99999 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: wrongGateSource }))).toBe("block:CHECK_SOURCE_MISMATCH");
    });

    it("conflicting duplicate sources fail closed (CHECK_SOURCE_MISMATCH)", () => {
      const conflicting = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 15368 },
          { context: "test", integrationId: 99999 },
          { context: "loopback/gate", integrationId: 5598944 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: conflicting }))).toBe("block:CHECK_SOURCE_MISMATCH");

      const conflictWithNull = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 15368 },
          { context: "test", integrationId: null },
          { context: "loopback/gate", integrationId: 5598944 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: conflictWithNull }))).toBe("block:CHECK_SOURCE_MISMATCH");
    });

    it("identical duplicate sources are accepted", () => {
      const duplicateIdentical = {
        ...prot,
        requiredStatusChecks: [
          { context: "test", integrationId: 15368 },
          { context: "test", integrationId: 15368 },
          { context: "loopback/gate", integrationId: 5598944 },
        ],
      };
      expect(code(evidence(), live({ baseProtection: duplicateIdentical }))).toBe("MERGE");
    });

    it("policy with missing or invalid integration ID fails closed (CONFIG_INCOMPLETE)", () => {
      expect(code(evidence(), live(), { ...policy, requiredCheckIntegrations: new Map([["loopback/gate", 5598944]]) })).toBe("block:CONFIG_INCOMPLETE");
      expect(code(evidence(), live(), { ...policy, requiredCheckIntegrations: new Map([["test", 0], ["loopback/gate", 5598944]]) })).toBe("block:CONFIG_INCOMPLETE");
      expect(code(evidence(), live(), { ...policy, requiredCheckIntegrations: new Map([["test", -1], ["loopback/gate", 5598944]]) })).toBe("block:CONFIG_INCOMPLETE");
    });
  });
  it("D19: protected path changes block", () => {
    for (const f of [".github/workflows/ci.yml", "package.json", "package-lock.json", ".mocharc.yml", "vitest.config.ts", "sub/package.json", ".npmrc"]) {
      expect(code(evidence(), live({ changedFiles: ["slugify.js", f] })), f).toBe("block:PROTECTED_PATH_CHANGED");
    }
  });
  it("D13: unordered runs resolve by id; ambiguous ids fail closed", () => {
    const run = (id: number, conclusion: string) => ({ id, name: "test", appSlug: "github-actions", status: "completed", conclusion, headSha: A });
    expect(code(evidence(), live({ checks: [run(30, "success"), run(10, "failure"), run(20, "failure")] }))).toBe("MERGE");
    expect(code(evidence(), live({ checks: [run(30, "failure"), run(40, "success"), run(35, "failure")] }))).toBe("MERGE");
    expect(code(evidence(), live({ checks: [run(50, "failure"), run(40, "success")] }))).toBe("block:CI_FAILED");
    expect(code(evidence(), live({ checks: [run(7, "success"), run(7, "failure")] }))).toBe("block:CI_MISSING");
    expect(code(evidence(), live({ checks: [run(0, "success")] }))).toBe("block:CI_MISSING");
  });
  it("ignores CI from the wrong app slug", () => {
    const l = live({ checks: [{ id: 1, name: "test", appSlug: "evil-app", status: "completed", conclusion: "success", headSha: A }] });
    expect(code(evidence(), l)).toBe("block:CI_MISSING");
  });
  it("M-b: only the latest verification run for the live head counts", () => {
    const runs = (latest: "requested" | "fail" | "invalid" | "timeout" | "superseded") => [
      { seq: 1, headSha: A, status: "pass" as const, repository: "o/r", prNumber: 42 },
      { seq: 2, headSha: A, status: latest, repository: "o/r", prNumber: 42 },
    ];
    expect(code(evidence({ verificationRuns: runs("requested") }), live())).toBe("block:VERIFICATION_PENDING");
    expect(code(evidence({ verificationRuns: runs("fail") }), live())).toBe("block:VERIFICATION_FAILED");
    expect(code(evidence({ verificationRuns: runs("invalid") }), live())).toBe("block:VERIFICATION_INVALID");
    expect(code(evidence({ verificationRuns: runs("timeout") }), live())).toBe("block:VERIFICATION_TIMEOUT");
    // D28: a superseded run never counts, even if it is the latest for the live head.
    expect(code(evidence({ verificationRuns: runs("superseded") }), live())).toBe("block:VERIFICATION_STALE");
    // order of the array does not matter; seq does
    expect(code(evidence({ verificationRuns: [...runs("fail")].reverse() }), live())).toBe("block:VERIFICATION_FAILED");
  });
  it("verifier evidence for another PR blocks", () => {
    const ev = evidence({ verificationRuns: [{ seq: 1, headSha: A, status: "pass", repository: "o/r", prNumber: 41 }] });
    expect(code(ev, live())).toBe("block:VERIFICATION_IDENTITY");
  });
  it("D11: approvals for another PR or repo never count", () => {
    const other = [
      { headSha: A, approverId: MAINT, decision: "approve" as const, repo: "o/r", prNumber: 41 },
      { headSha: A, approverId: MAINT, decision: "approve" as const, repo: "x/r", prNumber: 42 },
    ];
    expect(code(evidence({ approvals: other }), live())).toBe("block:APPROVAL_MISSING");
  });
  it("non-maintainer approvals are ignored; a maintainer rejection blocks", () => {
    expect(code(evidence({ approvals: [{ headSha: A, approverId: "@x:y", decision: "approve", repo: "o/r", prNumber: 42 }] }), live()))
      .toBe("block:APPROVAL_MISSING");
    const withReject = [...evidence().approvals, { headSha: A, approverId: MAINT2, decision: "reject" as const, repo: "o/r", prNumber: 42 }];
    expect(code(evidence({ approvals: withReject }), live())).toBe("block:REJECTED");
  });
  it("quorum 1 vs 2", () => {
    const two = { ...policy, quorum: 2 };
    expect(code(evidence(), live(), two)).toBe("block:APPROVAL_MISSING");
    const both = [...evidence().approvals, { headSha: A, approverId: MAINT2, decision: "approve" as const, repo: "o/r", prNumber: 42 }];
    expect(code(evidence({ approvals: both }), live(), two)).toBe("MERGE");
  });
  it("precedence: a moved head beats CI state; unavailable beats everything", () => {
    const l = live({ checks: [] }, { headSha: B });
    expect(code(evidence(), l)).toBe("stale:HEAD_MOVED");
    expect(code(evidence({ approvals: [], verificationRuns: [] }), live({ pr: undefined }))).toBe("block:GITHUB_UNAVAILABLE");
  });
  it("merge decision only in the all-evidence-matches case", () => {
    const d = evaluateMerge(evidence(), live(), policy);
    expect(d.action).toBe("merge");
  });
});

describe("isProtectedPath", () => {
  it("allows ordinary source and test files", () => {
    for (const f of ["slugify.js", "test/slugify.js", "lib/index.ts", "README.md", "config.json"]) {
      expect(isProtectedPath(f), f).toBe(false);
    }
  });
  it("review fix: normalises ./, backslashes and case, and covers more config files", () => {
    for (const f of [
      "././.github/workflows/ci.yml", ".github", ".GITHUB/workflows/x.yml", ".github\\workflows\\ci.yml",
      "Package.json", "CODEOWNERS", "docs/CODEOWNERS", "babel.config.js", "jest.config.json", ".c8rc.json",
      ".yarnrc.yml", ".husky/pre-commit", ".gitattributes", ".gitmodules", "bun.lockb",
    ]) {
      expect(isProtectedPath(f), f).toBe(true);
    }
  });
});

describe("review fixes: malformed policy and evidence fail closed", () => {
  it("quorum 0, negative or NaN never allows a merge", () => {
    for (const quorum of [0, -1, Number.NaN, 1.5]) {
      expect(code(evidence({ approvals: [] }), live(), { ...policy, quorum }), String(quorum)).toBe("block:CONFIG_INCOMPLETE");
    }
  });
  it("empty required checks, gate context or maintainers never skip CI or approval", () => {
    expect(code(evidence(), live(), { ...policy, requiredChecks: [] })).toBe("block:CONFIG_INCOMPLETE");
    expect(code(evidence(), live(), { ...policy, requiredChecks: [" "] })).toBe("block:CONFIG_INCOMPLETE");
    expect(code(evidence(), live(), { ...policy, gateStatusContext: "" })).toBe("block:CONFIG_INCOMPLETE");
    expect(code(evidence(), live(), { ...policy, maintainers: new Set() })).toBe("block:CONFIG_INCOMPLETE");
    expect(code(evidence(), live(), { ...policy, checkSources: new Map([["test", ""]]) })).toBe("block:CI_MISSING");
  });
  it("changed files must be read at the live head", () => {
    expect(code(evidence(), live({ changedFilesHeadSha: B }))).toBe("block:GITHUB_UNAVAILABLE");
    expect(code(evidence(), live({ changedFilesHeadSha: undefined }))).toBe("block:GITHUB_UNAVAILABLE");
  });
  it("heads must be full SHAs; empty or short heads never match", () => {
    const ev = evidence({ caseHeadSha: "", verificationRuns: [{ seq: 1, headSha: "", status: "pass", repository: "o/r", prNumber: 42 }],
      approvals: [{ headSha: "", approverId: MAINT, decision: "approve", repo: "o/r", prNumber: 42 }] });
    const l = live({ checks: [{ id: 1, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: "" }], changedFilesHeadSha: "" }, { headSha: "" });
    expect(code(ev, l)).toBe("block:IDENTITY_MISMATCH");
    expect(code(evidence({ caseHeadSha: A.toUpperCase() }), live())).toBe("block:IDENTITY_MISMATCH");
  });
  it("verification runs with a tied latest seq fail closed", () => {
    const tied = [
      { seq: 5, headSha: A, status: "pass" as const, repository: "o/r", prNumber: 42 },
      { seq: 5, headSha: A, status: "fail" as const, repository: "o/r", prNumber: 42 },
    ];
    expect(code(evidence({ verificationRuns: tied }), live())).toBe("block:VERIFICATION_PENDING");
    expect(code(evidence({ verificationRuns: [...tied].reverse() }), live())).toBe("block:VERIFICATION_PENDING");
  });
});
