import { COMMAND_KINDS, type CommandKind } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { PRIVILEGED, authorize, roleOf, type IdentityPolicy, type Role } from "../../apps/switch-gate/src/policy/authorize.js";

// Roles are resolved only for messages that passed admission (tests/unit/admission.test.ts):
// agents, delegated, platform and unaddressed messages never get here.

const MAINT = "@switch-mattermost-a8ed6700-fe65-4f22-8931-26fd3f197762-puneet:localhost";
const REP = "@switch-mattermost-a8ed6700-fe65-4f22-8931-26fd3f197762-reporter:localhost";
const policy: IdentityPolicy = { maintainers: new Set([MAINT]), reporters: new Set([REP]), privilegedEnabled: true };
const ROLES: Role[] = ["maintainer", "reporter", "outsider"];

describe("roleOf: exact participant ids only", () => {
  it("resolves maintainer, reporter and outsider from the configured lists", () => {
    expect(roleOf(MAINT, policy)).toBe("maintainer");
    expect(roleOf(REP, policy)).toBe("reporter");
    expect(roleOf("@switch-mattermost-a8ed6700-fe65-4f22-8931-26fd3f197762-someone:localhost", policy)).toBe("outsider");
  });

  it("does not fold case, trim, or match prefixes or suffixes", () => {
    for (const near of [MAINT.toUpperCase(), ` ${MAINT}`, `${MAINT} `, MAINT.slice(0, -1), `${MAINT}x`, MAINT.replace("puneet", "puneet-1a2b3c4d")]) {
      expect(roleOf(near, policy), near).toBe("outsider");
    }
  });

  it("a sender on both lists is a maintainer", () => {
    expect(roleOf(MAINT, { ...policy, reporters: new Set([MAINT]) })).toBe("maintainer");
  });

  it("D20: unlisted senders are outsiders, never reporters", () => {
    expect(roleOf("@switch-agent-random:localhost", policy)).toBe("outsider");
  });
});

const EXPECTED: Record<CommandKind, Role[]> = {
  help: ["maintainer", "reporter", "outsider"], whoami: ["maintainer", "reporter", "outsider"],
  report: ["maintainer", "reporter"], status: ["maintainer", "reporter"], audit: ["maintainer", "reporter"],
  verify: ["maintainer"], approve: ["maintainer"], reject: ["maintainer"], merge: ["maintainer"], retask: ["maintainer"],
};

describe("authorize: 10 commands x 3 roles", () => {
  it("matches the specified matrix exactly when privileged commands are enabled", () => {
    expect(COMMAND_KINDS).toHaveLength(10);
    for (const kind of COMMAND_KINDS) {
      for (const role of ROLES) {
        const d = authorize(kind, role, policy);
        expect(d.ok, `${kind}/${role}`).toBe(EXPECTED[kind].includes(role));
        if (!d.ok) expect(d.code).toBe("NOT_AUTHORIZED");
      }
    }
  });

  it("outsider report is refused (D20)", () => {
    expect(authorize("report", roleOf("@x:localhost", policy), policy)).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
  });
});

describe("authorize: privileged commands are off unless explicitly enabled", () => {
  it("refuses every privileged command for every role while the flag is false", () => {
    for (const kind of PRIVILEGED) {
      expect(authorize(kind, "maintainer", { privilegedEnabled: false })).toMatchObject({ ok: false, code: "PRIVILEGED_DISABLED" });
      expect(authorize(kind, "reporter", { privilegedEnabled: false })).toMatchObject({ ok: false });
      expect(authorize(kind, "outsider", { privilegedEnabled: false })).toMatchObject({ ok: false });
    }
  });

  it("treats anything but the boolean true as disabled", () => {
    for (const flag of [undefined, null, "true", 1] as unknown[]) {
      expect(authorize("merge", "maintainer", { privilegedEnabled: flag as boolean }), String(flag)).toMatchObject({ ok: false, code: "PRIVILEGED_DISABLED" });
    }
  });

  it("leaves ordinary commands available while privileged ones are disabled", () => {
    const off = { privilegedEnabled: false };
    for (const kind of ["help", "whoami", "report", "status", "audit"] as CommandKind[]) {
      expect(authorize(kind, "maintainer", off).ok, kind).toBe(true);
    }
    expect(authorize("help", "outsider", off).ok).toBe(true);
  });

  it("the privileged set is exactly the state-changing commands", () => {
    expect([...PRIVILEGED].sort()).toEqual(["approve", "merge", "reject", "retask", "verify"]);
  });
});
