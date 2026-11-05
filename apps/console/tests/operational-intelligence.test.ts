import { describe, expect, it } from "vitest";
import { reasonGuidance, reasonLabel } from "../src/lib/labels.ts";

describe("Operational intelligence & actionable guidance", () => {
  it("provides actionable operator guidance for critical blocked and failure reasons", () => {
    const reasons = [
      "FIXER_TIMEOUT",
      "VERIFICATION_TIMEOUT",
      "HEAD_MOVED",
      "CI_FAILED",
      "CI_MISSING",
      "CI_PENDING",
      "PROTECTED_PATH_CHANGED",
      "NOT_REPRODUCED",
      "TRIAGE_DECLINED",
      "BASE_COMMIT_MISMATCH",
      "VERIFICATION_FAILED",
      "VERIFIER_SIGNATURE_INVALID",
      "APPROVAL_MISSING",
      "APPROVAL_SHA_MISMATCH",
      "MERGE_DISABLED",
      "GATE_HALTED",
      "RATE_LIMITED",
      "NOT_MERGEABLE",
    ] as const;

    for (const code of reasons) {
      const guidance = reasonGuidance(code);
      expect(guidance, `Expected guidance for ${code}`).toBeTruthy();
      expect(typeof guidance).toBe("string");
      expect(guidance!.length).toBeGreaterThan(15);
    }
  });

  it("falls back to null for unknown or non-blocked reason codes without inventing data", () => {
    expect(reasonGuidance("UNKNOWN_REASON_CODE_XYZ")).toBeNull();
    expect(reasonGuidance("")).toBeNull();
  });

  it("labels reasons faithfully without throwing", () => {
    expect(reasonLabel("FIXER_TIMEOUT")).toBe("The fixer timed out");
    expect(reasonLabel("UNKNOWN_CUSTOM_CODE")).toBe("UNKNOWN_CUSTOM_CODE");
  });
});

