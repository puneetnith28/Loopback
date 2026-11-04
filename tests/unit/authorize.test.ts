import { COMMAND_KINDS, type CommandKind } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { PRIVILEGED, authorize, roleOf, type IdentityPolicy, type Role } from "../../apps/switch-gate/src/policy/authorize.js";

const MAINT = "@switch-user-maint:x";
const REP = "@switch-user-rep:x";
const FIXER = "@switch-agent-fixer:x";
const OUT = "@switch-user-outsider:x";
const policy: IdentityPolicy = {
  maintainers: new Set([MAINT]),
  reporters: new Set([REP]),
  agentSenders: new Set([FIXER, "@switch-agent-verifier:x"]),
  humanSenderKind: "member",
};
const human = (sender: string) => ({ sender, senderKind: "member", onBehalfOf: null });

describe("roleOf", () => {
  it("resolves the four roles from opaque ids", () => {
    expect(roleOf(human(MAINT), policy)).toBe("maintainer");
    expect(roleOf(human(REP), policy)).toBe("reporter");
    expect(roleOf(human(OUT), policy)).toBe("outsider");
    expect(roleOf(human(FIXER), policy)).toBe("agent");
  });

  it("D16: owner-attributed agent messages carrying the maintainer's id are agents", () => {
    expect(roleOf({ sender: MAINT, senderKind: "member", onBehalfOf: MAINT }, policy)).toBe("agent");
    expect(roleOf({ sender: MAINT, senderKind: "agent", onBehalfOf: null }, policy)).toBe("agent");
    expect(roleOf({ sender: MAINT, senderKind: null, onBehalfOf: null }, policy)).toBe("agent");
  });

  it("D20: unlisted senders are outsiders, never reporters", () => {
    expect(roleOf(human("@switch-user-random:x"), policy)).toBe("outsider");
  });
});

const EXPECTED: Record<CommandKind, Role[]> = {
  help: ["maintainer", "reporter", "outsider"], whoami: ["maintainer", "reporter", "outsider"],
  report: ["maintainer", "reporter"], status: ["maintainer", "reporter"], audit: ["maintainer", "reporter"],
  verify: ["maintainer"], approve: ["maintainer"], reject: ["maintainer"], merge: ["maintainer"], retask: ["maintainer"],
};

describe("authorize: 10 commands x 4 roles", () => {
  it("matches the specified matrix exactly", () => {
    expect(COMMAND_KINDS).toHaveLength(10);
    for (const kind of COMMAND_KINDS) {
      for (const role of ["maintainer", "reporter", "agent", "outsider"] as Role[]) {
        const d = authorize(kind, role, policy);
        expect(d.ok, `${kind}/${role}`).toBe(EXPECTED[kind].includes(role));
        if (!d.ok) expect(d.code).toBe("NOT_AUTHORIZED");
      }
    }
  });

  it("agents can never run privileged commands", () => {
    for (const kind of PRIVILEGED) expect(authorize(kind, "agent", policy).ok).toBe(false);
  });

  it("owner-attributed agent message attempting approve or merge is refused (D16)", () => {
    const role = roleOf({ sender: MAINT, senderKind: "member", onBehalfOf: MAINT }, policy);
    expect(authorize("approve", role, policy)).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
    expect(authorize("merge", role, policy)).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
  });

  it("outsider report is refused (D20)", () => {
    expect(authorize("report", roleOf(human(OUT), policy), policy)).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
  });

  it("until the human sender kind is verified, nobody gets more than outsider rights (D16/Q3)", () => {
    const unverified = { ...policy, humanSenderKind: null };
    for (const sender of [MAINT, REP, OUT]) {
      const role = roleOf(human(sender), unverified);
      expect(role, sender).toBe("outsider");
      expect(authorize("whoami", role, unverified).ok).toBe(true);
      expect(authorize("help", role, unverified).ok).toBe(true);
      for (const kind of ["report", "status", "audit", ...PRIVILEGED] as CommandKind[]) {
        expect(authorize(kind, role, unverified).ok, `${sender}/${kind}`).toBe(false);
      }
    }
    // agents stay agents regardless
    expect(roleOf(human(FIXER), unverified)).toBe("agent");
    expect(roleOf({ sender: MAINT, senderKind: "member", onBehalfOf: MAINT }, unverified)).toBe("agent");
  });

  it("defence in depth: authorize refuses privileged commands while attribution is unverified", () => {
    for (const kind of PRIVILEGED) {
      expect(authorize(kind, "maintainer", { humanSenderKind: null })).toMatchObject({ ok: false, code: "PRIVILEGED_DISABLED" });
    }
  });
});
