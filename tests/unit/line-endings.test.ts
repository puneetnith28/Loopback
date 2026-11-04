import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Cross-platform contributors: the repository stores LF, and .gitattributes keeps LF on every
// checkout, so shell scripts and Node modules work from Windows/WSL2 checkouts unchanged.

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });

describe("line-ending policy (.gitattributes)", () => {
  it("every tracked text file is stored with LF line endings", () => {
    const bad = git(["ls-files", "--eol"]).split("\n").filter(Boolean)
      .filter((l) => !l.startsWith("i/lf") && !l.startsWith("i/none") && !l.startsWith("i/-text"));
    expect(bad).toEqual([]);
  });

  it("forces LF on checkout for shell scripts, Node modules and sources, and binary for keys and databases", () => {
    const attrs = git(["check-attr", "text", "eol", "--", "scripts/verify-isolation.sh", "scripts/sign-verifier-report.mjs", "apps/switch-gate/src/main.ts", "x.pem", "x.db"]);
    for (const f of ["scripts/verify-isolation.sh", "scripts/sign-verifier-report.mjs", "apps/switch-gate/src/main.ts"]) {
      expect(attrs).toContain(`${f}: text: set`);
      expect(attrs).toContain(`${f}: eol: lf`);
    }
    expect(attrs).toContain("x.pem: text: unset");
    expect(attrs).toContain("x.db: text: unset");
  });
});
