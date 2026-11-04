import { describe, expect, it } from "vitest";
import {
  Approval,
  CaseId,
  Command,
  FixerReport,
  FullSha,
  InboundMessage,
  REASON_CODES,
  ShortSha,
  TRANSIENT_REASON_CODES,
  VerifierReport,
  displaySha,
  isTransient,
} from "@loopback/contracts";

const SHA = "3f9c2ab4e1d0b4c9a8f7e6d5c4b3a2918f7e6d5c";

describe("primitives", () => {
  it("accepts only full lower-case SHAs", () => {
    expect(FullSha.safeParse(SHA).success).toBe(true);
    expect(FullSha.safeParse(SHA.toUpperCase()).success).toBe(false);
    expect(FullSha.safeParse(SHA.slice(0, 39)).success).toBe(false);
    expect(FullSha.safeParse(SHA + "0").success).toBe(false);
  });
  it("short SHAs are 7–40 lower-case hex", () => {
    expect(ShortSha.safeParse("3f9c2ab").success).toBe(true);
    expect(ShortSha.safeParse("3f9c2a").success).toBe(false);
    expect(ShortSha.safeParse("3F9C2AB").success).toBe(false);
  });
  it("case ids", () => {
    expect(CaseId.safeParse("LB-001").success).toBe(true);
    expect(CaseId.safeParse("LB-1").success).toBe(false);
    expect(CaseId.safeParse("lb-001").success).toBe(false);
  });
  it("displays 12 characters", () => {
    expect(displaySha(SHA)).toHaveLength(12);
  });
});

describe("InboundMessage (D16)", () => {
  const base = {
    eventId: "m1", roomId: "r", sequence: 1, messageId: "m1", sender: "@u:x",
    senderKind: "member", onBehalfOf: null, addressed: true, body: "hi", threadId: null, timestamp: 1,
  };
  it("preserves attribution fields", () => {
    const m = InboundMessage.parse({ ...base, onBehalfOf: "@owner:x" });
    expect(m.onBehalfOf).toBe("@owner:x");
  });
  it("never defaults a missing sender kind", () => {
    const { senderKind: _omit, ...withoutKind } = base;
    expect(InboundMessage.safeParse(withoutKind).success).toBe(false);
    expect(InboundMessage.parse({ ...base, senderKind: null }).senderKind).toBeNull();
  });
});

describe("Command", () => {
  it("covers ten commands including retask", () => {
    expect(Command.safeParse({ kind: "retask", caseId: "LB-001", note: "try again" }).success).toBe(true);
    expect(Command.safeParse({ kind: "retask", caseId: "LB-001", note: "   " }).success).toBe(false);
  });
});

describe("FixerReport (D5)", () => {
  const fixed = {
    type: "fixer", status: "fixed", caseId: "LB-001", prUrl: "https://github.com/o/r/pull/42",
    headSha: SHA, branch: "loopback/LB-001", testsRun: ["npm test"], regressionTest: "t::x", limitations: [],
  };
  it("accepts a complete fixed report", () => {
    expect(FixerReport.safeParse(fixed).success).toBe(true);
  });
  it("rejects fixed without prUrl or full headSha", () => {
    const { prUrl: _p, ...noPr } = fixed;
    expect(FixerReport.safeParse(noPr).success).toBe(false);
    expect(FixerReport.safeParse({ ...fixed, headSha: SHA.slice(0, 7) }).success).toBe(false);
  });
  it("accepts not_reproduced without PR fields", () => {
    expect(FixerReport.safeParse({
      type: "fixer", status: "not_reproduced", caseId: "LB-001", testsRun: [], limitations: [], summary: "could not reproduce",
    }).success).toBe(true);
  });
  it("rejects unknown keys and non-GitHub PR URLs", () => {
    expect(FixerReport.safeParse({ ...fixed, approved: true }).success).toBe(false);
    expect(FixerReport.safeParse({ ...fixed, prUrl: "https://evil.example/pull/1" }).success).toBe(false);
  });
});

describe("VerifierReport", () => {
  const ok = {
    type: "verifier", caseId: "LB-001", repository: "o/r", pullRequest: 42, headSha: SHA, verdict: "pass",
    regressionTestFailsBeforeFix: true, findings: [], summary: "fine",
  };
  it("accepts a valid report and rejects extra keys or oversized findings", () => {
    expect(VerifierReport.safeParse(ok).success).toBe(true);
    expect(VerifierReport.safeParse({ ...ok, merge: true }).success).toBe(false);
    const many = Array.from({ length: 31 }, () => ({ severity: "info", message: "x" }));
    expect(VerifierReport.safeParse({ ...ok, findings: many }).success).toBe(false);
  });
});

describe("Approval (D11)", () => {
  it("requires repository, PR and full SHA", () => {
    const a = {
      caseId: "LB-001", repository: "o/r", pullRequest: 42, headSha: SHA, approverId: "@u:x",
      decision: "approve", sourceEventId: "m1", createdAt: new Date().toISOString(),
    };
    expect(Approval.safeParse(a).success).toBe(true);
    expect(Approval.safeParse({ ...a, headSha: "3f9c2ab" }).success).toBe(false);
  });
});

describe("reason codes (D15)", () => {
  it("transient set is exactly the approved list", () => {
    expect([...TRANSIENT_REASON_CODES].sort()).toEqual([
      "AWAITING_MERGE_COMMAND", "CI_PENDING", "GITHUB_UNAVAILABLE", "MERGEABILITY_UNKNOWN",
      "RATE_LIMITED", "VERIFICATION_PENDING",
    ]);
    for (const c of TRANSIENT_REASON_CODES) expect(REASON_CODES).toContain(c);
    expect(isTransient("REJECTED")).toBe(false);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });
});
