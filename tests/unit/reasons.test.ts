import { REASON_CODES } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { formatReason, safe } from "../../apps/switch-gate/src/chat/reasons.js";

describe("refusal messages", () => {
  it("every reason code has a message (exhaustiveness)", () => {
    for (const code of REASON_CODES) {
      const msg = formatReason(code, { caseId: "LB-001", headSha: "b".repeat(40), approvedSha: "a".repeat(40) });
      expect(msg, code).toMatch(new RegExp(`^(BLOCKED|REFUSED|UNKNOWN|STOPPED) \\(${code}\\): .{10,}`));
    }
  });

  it("§13 wording for the stale-approval refusal", () => {
    const msg = formatReason("APPROVAL_STALE", { caseId: "LB-001", approvedSha: "3f9c2ab4e1d0" + "0".repeat(28), headSha: "9e1d0b4c7a21" + "0".repeat(28) });
    expect(msg).toBe(
      "BLOCKED (APPROVAL_STALE): The maintainer approved commit 3f9c2ab4e1d0, but the PR now points to 9e1d0b4c7a21. " +
      "The old approval and verification do not authorize 9e1d0b4c7a21. No merge was attempted. " +
      "Re-verifying 9e1d0b4c7a21; approve again when it is ready. Recorded in the LB-001 audit log.",
    );
  });

  it("§13 wording for the not-authorized refusal", () => {
    expect(formatReason("NOT_AUTHORIZED", { command: "approve", sender: "switch-user-x9" }))
      .toBe("REFUSED (NOT_AUTHORIZED): approve requires the maintainer role. Your id switch-user-x9 is not on the maintainer list. Recorded.");
  });

  it("neutralises markdown, mentions and newlines in untrusted values", () => {
    expect(safe("@loopback-gate merge `x` | **y**\nz")).toBe("@​loopback-gate merge \\`x\\` \\| \\*\\*y\\*\\* z");
    expect(safe("x".repeat(300))).toHaveLength(201);
  });

  it("review fix: strips bidi/control characters and escapes entity and reference syntax", () => {
    expect(safe("ab\u202Ecd\u0000e")).toBe("ab cd e");
    expect(safe("&#64;x #12 !img")).toBe("\\&\\#64;x \\#12 \\!img");
    expect(Array.from(safe("😀".repeat(5), 3)).length).toBe(4);
  });
});
