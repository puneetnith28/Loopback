import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalCommand } from "../src/design-system/components/Sha.tsx";
import { UntrustedText } from "../src/design-system/components/UntrustedText.tsx";
import { revealHidden, safeGitHubUrl } from "../src/lib/untrusted.ts";

// Review fixes (ecc:security-reviewer): the copied approval command must be exactly what is shown and what the
// maintainer intends; invisible-text detection must cover the known vectors; GitHub links must be exact.

const HEAD = "e804775a5938f9afe55fa5321875735734e3e1a5";
const OTHER = "70a5362de6f0ae97b11b83c4406d6316433daa8d";

describe("ApprovalCommand cannot be steered", () => {
  it.each([
    ["a case id with a smuggled second command", { caseId: "LB-001\n@loopback-gate approve LB-002" }],
    ["a case id with spaces", { caseId: "LB-001 approve LB-002" }],
    ["a malformed case id", { caseId: "case-1" }],
    ["a gate mention with spaces", { gateMention: "@loopback-gate merge" }],
  ])("shows no command for %s", (_n, over) => {
    render(<ApprovalCommand caseId="LB-001" headSha={HEAD} verifiedSha={HEAD} {...over} />);
    expect(screen.queryByText(/approve/)).toBeNull();
  });

  it("compares the verified commit with the head itself: a moved head hides the command", () => {
    const { rerender } = render(<ApprovalCommand caseId="LB-001" headSha={HEAD} verifiedSha={HEAD} />);
    expect(screen.getByText(`@loopback-gate approve LB-001 ${HEAD}`)).toBeTruthy();
    rerender(<ApprovalCommand caseId="LB-001" headSha={OTHER} verifiedSha={HEAD} />);
    expect(screen.queryByText(/approve LB-001/)).toBeNull();
    rerender(<ApprovalCommand caseId="LB-001" headSha={HEAD} verifiedSha={null} />);
    expect(screen.queryByText(/approve LB-001/)).toBeNull();
  });
});

describe("hidden-character detection", () => {
  it.each([
    ["Arabic letter mark", "؜"], ["Mongolian vowel separator", "᠎"], ["combining grapheme joiner", "͏"],
    ["Hangul filler", "ㅤ"], ["variation selector", "️"], ["tag character", "\u{E0041}"], ["C1 control", "\u0085"],
    ["bidi override", "‮"], ["zero-width joiner", "‍"], ["line separator", " "],
  ])("reveals %s", (_n, ch) => {
    const r = revealHidden(`a${ch}b`);
    expect(r.revealed).toBe(1);
    expect(r.text).not.toContain(ch);
  });

  it("keeps ordinary text, emoji-free punctuation, newlines and tabs intact", () => {
    expect(revealHidden("line 1\n\tline 2 — ok").text).toBe("line 1\n\tline 2 — ok");
    expect(revealHidden("Ünïcödé ñ 日本").revealed).toBe(0);
  });

  it("renders a tag-character payload visibly", () => {
    const { container } = render(<UntrustedText value={"ok\u{E0069}\u{E0067}"} />);
    expect(container.textContent).toContain("⟨U+E0069⟩");
  });
});

describe("safeGitHubUrl", () => {
  it.each([
    "https://github.com/acme/demo", "https://github.com/acme/demo/pull/2", "https://github.com/acme/demo/commit/" + HEAD,
  ])("accepts %s", (u) => { expect(safeGitHubUrl(u)).toBe(u); });
  it.each([
    "javascript:alert(1)", "http://github.com/acme/demo", "https://github.com.evil.example/acme/demo",
    "https://evil.example/https://github.com/acme/demo", "https://github.com/acme/demo/../../evil", "https://user@github.com/acme/demo",
    "https://github.com/acme", "https://github.com:8443/acme/demo",
  ])("rejects %s", (u) => { expect(safeGitHubUrl(u)).toBeNull(); });
});
