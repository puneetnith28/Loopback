import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  ConfigError,
  assertIdentityConsistency,
  assertPrivateKeyFile,
  loadGitHubConfig,
  loadIdentityConfig,
  loadRuntimeConfig,
  loadSwitchConfig,
} from "../../apps/switch-gate/src/config.js";

const SECRET = "sk-super-secret-value-123456";
const POLICY_USER = "2a8934be-9a66-4944-a410-456e9e23b98c";
const POLICY_AGENT = "11111111-2222-4333-8444-555555555555";

const switchEnv = {
  SWITCH_BRIDGE_URL: "http://localhost:8080",
  SWITCH_AGENT_ID: "agent-1",
  SWITCH_AGENT_API_KEY: SECRET,
  SWITCH_ROOM_ID: "room-1",
  SWITCH_INTAKE_ROOM_ID: "room-2",
  SWITCH_SELF_ID: "@switch-agent-gate:loopback",
  SWITCH_POLICY_USER_IDS: POLICY_USER,
  SWITCH_POLICY_AGENT_IDS: POLICY_AGENT,
};
const identityEnv = {
  LOOPBACK_MAINTAINERS: "@switch-user-a1:loopback",
  LOOPBACK_REPORTERS: "@switch-user-a1:loopback,@switch-user-r2:loopback",
  LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback",
  LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
};
const githubEnv = {
  GH_REPO: "acme/slugify",
  GH_APP_ID: "123",
  GH_APP_INSTALLATION_ID: "456",
  GH_APP_PRIVATE_KEY_PATH: "/nonexistent/gate.pem",
  BASE_BRANCH: "main",
  REQUIRED_CHECKS: "test",
  CHECK_SOURCES: "test:github-actions",
  REQUIRED_CHECK_INTEGRATIONS: "test:15368",
};

function issuesOf(fn: () => unknown): { variable: string; message: string }[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return [...(e as ConfigError).issues];
  }
  throw new Error("expected ConfigError");
}

describe("Switch group", () => {
  it("loads a complete group with the expected addressing-policy ids", () => {
    const c = loadSwitchConfig(switchEnv);
    expect(c.roomId).toBe("room-1");
    expect(c.policyUserIds).toEqual(new Set([POLICY_USER]));
    expect(c.policyAgentIds).toEqual(new Set([POLICY_AGENT]));
  });

  it("requires explicit policy id lists of lower-case UUIDs (no wildcard, no participant ids)", () => {
    for (const bad of ["", "*", "@switch-mattermost-x:localhost", POLICY_USER.toUpperCase(), `${POLICY_USER},nope`]) {
      const issues = issuesOf(() => loadSwitchConfig({ ...switchEnv, SWITCH_POLICY_USER_IDS: bad }));
      expect(issues.map((i) => i.variable), bad).toContain("SWITCH_POLICY_USER_IDS");
    }
    const issues = issuesOf(() => loadSwitchConfig({ ...switchEnv, SWITCH_POLICY_AGENT_IDS: undefined }));
    expect(issues.map((i) => i.variable)).toContain("SWITCH_POLICY_AGENT_IDS");
  });

  it("ignores the retired SWITCH_HUMAN_SENDER_KIND: it can no longer grant anything", () => {
    const c = loadSwitchConfig({ ...switchEnv, SWITCH_HUMAN_SENDER_KIND: "member" });
    expect(c).not.toHaveProperty("humanSenderKind");
  });

  it("names each missing variable and never echoes a value", () => {
    const err = (() => {
      try {
        loadSwitchConfig({ ...switchEnv, SWITCH_ROOM_ID: "", SWITCH_BRIDGE_URL: "not a url " + SECRET });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("expected failure");
    })();
    expect(err.issues.map((i) => i.variable).sort()).toEqual(["SWITCH_BRIDGE_URL", "SWITCH_ROOM_ID"]);
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err.issues)).not.toContain(SECRET);
  });
});

describe("identity group", () => {
  it("parses explicit id lists", () => {
    const c = loadIdentityConfig(identityEnv);
    expect([...c.reporters]).toHaveLength(2);
    expect(c.maintainers.has("@switch-user-a1:loopback")).toBe(true);
  });

  it("rejects a wildcard reporter list (D20)", () => {
    const issues = issuesOf(() => loadIdentityConfig({ ...identityEnv, LOOPBACK_REPORTERS: "*" }));
    expect(issues[0]?.variable).toBe("LOOPBACK_REPORTERS");
  });

  it("rejects an agent id in the maintainer or reporter lists", () => {
    const issues = issuesOf(() =>
      loadIdentityConfig({ ...identityEnv, LOOPBACK_MAINTAINERS: "@switch-agent-fixer:loopback" }),
    );
    expect(issues.map((i) => i.variable)).toContain("LOOPBACK_MAINTAINERS");
    const issues2 = issuesOf(() =>
      loadIdentityConfig({ ...identityEnv, LOOPBACK_REPORTERS: "@switch-agent-verifier:loopback" }),
    );
    expect(issues2.map((i) => i.variable)).toContain("LOOPBACK_REPORTERS");
  });

  it("leaves privileged commands disabled unless LOOPBACK_PRIVILEGED_ENABLED is exactly true", () => {
    expect(loadIdentityConfig(identityEnv).privilegedEnabled).toBe(false);
    expect(loadIdentityConfig({ ...identityEnv, LOOPBACK_PRIVILEGED_ENABLED: "false" }).privilegedEnabled).toBe(false);
    expect(loadIdentityConfig({ ...identityEnv, LOOPBACK_PRIVILEGED_ENABLED: "true" }).privilegedEnabled).toBe(true);
    for (const bad of ["yes", "1", "TRUE", "on"]) {
      const issues = issuesOf(() => loadIdentityConfig({ ...identityEnv, LOOPBACK_PRIVILEGED_ENABLED: bad }));
      expect(issues.map((i) => i.variable), bad).toContain("LOOPBACK_PRIVILEGED_ENABLED");
    }
  });

  it("refuses a gate id that is also a maintainer, reporter, fixer or verifier", () => {
    const id = loadIdentityConfig(identityEnv);
    expect(() => assertIdentityConsistency({ selfId: "@switch-agent-gate:loopback", roomId: "room-1", intakeRoomId: "room-2" }, id)).not.toThrow();
    for (const [selfId, variable] of [
      ["@switch-user-a1:loopback", "LOOPBACK_MAINTAINERS"],
      ["@switch-user-r2:loopback", "LOOPBACK_REPORTERS"],
      ["@switch-agent-fixer:loopback", "SWITCH_SELF_ID"],
      ["@switch-agent-verifier:loopback", "SWITCH_SELF_ID"],
    ] as const) {
      const issues = issuesOf(() => assertIdentityConsistency({ selfId, roomId: "room-1", intakeRoomId: "room-2" }, id));
      expect(issues.map((i) => i.variable), selfId).toContain(variable);
    }
  });

  it("rejects identical fixer and verifier ids", () => {
    const issues = issuesOf(() =>
      loadIdentityConfig({ ...identityEnv, LOOPBACK_VERIFIER_ID: identityEnv.LOOPBACK_FIXER_ID }),
    );
    expect(issues.map((i) => i.variable)).toContain("LOOPBACK_VERIFIER_ID");
  });
});

describe("GitHub group", () => {
  it("parses checks, sources and ruleset integration IDs", () => {
    const c = loadGitHubConfig(githubEnv, { checkKeyFile: false });
    expect(c.owner).toBe("acme");
    expect(c.checkSources.get("test")).toBe("github-actions");
    expect(c.requiredCheckIntegrations.get("test")).toBe(15368);
    // Requirement 4: loopback/gate expected integration ID is bound to GH_APP_ID
    expect(c.requiredCheckIntegrations.get("loopback/gate")).toBe(123);
    expect(c.gateStatusContext).toBe("loopback/gate");
  });

  it("requires a source for every required check", () => {
    const issues = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECKS: "test,lint", REQUIRED_CHECK_INTEGRATIONS: "test:15368,lint:15369" }, { checkKeyFile: false }),
    );
    expect(issues.map((i) => i.variable)).toContain("CHECK_SOURCES");
  });

  it("requires an integration ID for every required check and positive IDs", () => {
    const missing = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECKS: "test,lint", CHECK_SOURCES: "test:github-actions,lint:linter" }, { checkKeyFile: false }),
    );
    expect(missing.map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");

    const zero = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:0" }, { checkKeyFile: false }),
    );
    expect(zero.map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");

    const nonInt = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:abc" }, { checkKeyFile: false }),
    );
    expect(nonInt.map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");

    const conflicting = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:15368,test:99999" }, { checkKeyFile: false }),
    );
    expect(conflicting.map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");

    // D.1: trims whitespace around context and id
    const trimmed = loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "  test  :  15368  " }, { checkKeyFile: false });
    expect(trimmed.requiredCheckIntegrations.get("test")).toBe(15368);

    // D.2: rejects empty context names and malformed IDs
    expect(issuesOf(() => loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: ":15368" }, { checkKeyFile: false })).map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");
    expect(issuesOf(() => loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:" }, { checkKeyFile: false })).map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");

    // D.3: rejects GATE_STATUS_CONTEXT in REQUIRED_CHECKS
    const gateInReq = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECKS: "test,loopback/gate" }, { checkKeyFile: false }),
    );
    expect(gateInReq.map((i) => i.variable)).toContain("REQUIRED_CHECKS");

    // D.4: explicitly supplied gate mapping equal to GH_APP_ID is accepted
    const explicitGate = loadGitHubConfig(
      { ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:15368, loopback/gate:123" },
      { checkKeyFile: false },
    );
    expect(explicitGate.requiredCheckIntegrations.get("loopback/gate")).toBe(123);

    // D.5: conflicting gate mapping is rejected
    const gateConflict = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:15368,loopback/gate:99999" }, { checkKeyFile: false }),
    );
    expect(gateConflict.map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");

    // D.6: unsafe integer IDs are rejected
    const unsafeInt = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECK_INTEGRATIONS: "test:99999999999999999999" }, { checkKeyFile: false }),
    );
    expect(unsafeInt.map((i) => i.variable)).toContain("REQUIRED_CHECK_INTEGRATIONS");
  });

  it("enforces BASE_BRANCH = demo/<DEMO_RUN_ID> and a full DEMO_RESET_SHA during demo runs (D17)", () => {
    const run = "20261105-0123456789abcdef";
    const ok = loadGitHubConfig(
      { ...githubEnv, DEMO_RUN_ID: run, BASE_BRANCH: `demo/${run}`, DEMO_RESET_SHA: "a".repeat(40) },
      { checkKeyFile: false },
    );
    expect(ok.baseBranch).toBe(`demo/${run}`);
    const wrongBase = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, DEMO_RUN_ID: run, BASE_BRANCH: "demo/other", DEMO_RESET_SHA: "a".repeat(40) }, { checkKeyFile: false }),
    );
    expect(wrongBase.map((i) => i.variable)).toContain("BASE_BRANCH");
    const noSha = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, DEMO_RUN_ID: run, BASE_BRANCH: `demo/${run}` }, { checkKeyFile: false }),
    );
    expect(noSha.map((i) => i.variable)).toContain("DEMO_RESET_SHA");
    const guessable = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, DEMO_RUN_ID: "run1", BASE_BRANCH: "demo/run1", DEMO_RESET_SHA: "a".repeat(40) }, { checkKeyFile: false }),
    );
    expect(guessable.map((i) => i.variable)).toContain("DEMO_RUN_ID");
    const demoWithoutRun = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, BASE_BRANCH: "demo/x" }, { checkKeyFile: false }),
    );
    expect(demoWithoutRun.map((i) => i.variable)).toContain("DEMO_RUN_ID");
  });

  it("checks the private key file exists", () => {
    const issues = issuesOf(() => loadGitHubConfig(githubEnv));
    expect(issues[0]?.variable).toBe("GH_APP_PRIVATE_KEY_PATH");
  });
});

describe("private key permissions", () => {
  const file = (mode: number) => () => ({ mode, isFile: () => true });
  it("accepts an owner-only file", () => {
    expect(() => assertPrivateKeyFile("k", file(0o100600))).not.toThrow();
    expect(() => assertPrivateKeyFile("k", file(0o100400))).not.toThrow();
  });
  it("rejects group- or world-readable files", () => {
    expect(() => assertPrivateKeyFile("k", file(0o100640))).toThrow(ConfigError);
    expect(() => assertPrivateKeyFile("k", file(0o100604))).toThrow(ConfigError);
  });
  it("rejects directories", () => {
    expect(() => assertPrivateKeyFile("k", () => ({ mode: 0o40700, isFile: () => false }))).toThrow(ConfigError);
  });
  const withDir = (dirMode: number) => (p: string) =>
    p === "secrets/gate.pem" ? { mode: 0o100600, isFile: () => true } : { mode: dirMode, isFile: () => false };
  it("accepts a private or read-only-shared key directory", () => {
    expect(() => assertPrivateKeyFile("secrets/gate.pem", withDir(0o40700))).not.toThrow();
    expect(() => assertPrivateKeyFile("secrets/gate.pem", withDir(0o40755))).not.toThrow();
  });
  it("rejects a key directory others can write to (the key could be swapped)", () => {
    for (const mode of [0o40770, 0o40707, 0o40777, 0o41777]) {
      expect(() => assertPrivateKeyFile("secrets/gate.pem", withDir(mode)), mode.toString(8)).toThrow(/directory must not be group- or world-writable/);
    }
  });
  it("rejects a key directory it cannot stat", () => {
    expect(() => assertPrivateKeyFile("secrets/gate.pem", (p) => {
      if (p === "secrets/gate.pem") return { mode: 0o100600, isFile: () => true };
      throw new Error("ENOENT");
    })).toThrow(/directory not found/);
  });
});

describe("D26/D28 configuration", () => {
  it("requires a distinct intake room", () => {
    expect(loadSwitchConfig(switchEnv).intakeRoomId).toBe("room-2");
    expect(issuesOf(() => loadSwitchConfig({ ...switchEnv, SWITCH_INTAKE_ROOM_ID: undefined })).map((i) => i.variable)).toContain("SWITCH_INTAKE_ROOM_ID");
    const id = loadIdentityConfig(identityEnv);
    const issues = issuesOf(() => assertIdentityConsistency({ selfId: "@switch-agent-gate:loopback", roomId: "room-1", intakeRoomId: "room-1" }, id));
    expect(issues.map((i) => i.variable)).toContain("SWITCH_INTAKE_ROOM_ID");
  });

  it("treats the verifier as advisory unless isolation is explicitly proven", () => {
    expect(loadIdentityConfig(identityEnv).verifierIsolationProven).toBe(false);
    // Turning isolation on requires the full D28 configuration (see "D28 isolated verification configuration").
    const edRaw = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
    expect(loadIdentityConfig({
      ...identityEnv, VERIFIER_ISOLATION_PROVEN: "true", VERIFIER_PUBLIC_KEY: edRaw,
      LOOPBACK_FIXER_AGENT_ID: "11111111-2222-4333-8444-555555555555", LOOPBACK_VERIFIER_AGENT_ID: "66666666-2222-4333-8444-555555555555",
    }).verifierIsolationProven).toBe(true);
    expect(issuesOf(() => loadIdentityConfig({ ...identityEnv, VERIFIER_ISOLATION_PROVEN: "true" })).map((i) => i.variable)).toContain("VERIFIER_PUBLIC_KEY");
    for (const bad of ["yes", "1", "TRUE"]) {
      expect(issuesOf(() => loadIdentityConfig({ ...identityEnv, VERIFIER_ISOLATION_PROVEN: bad })).map((i) => i.variable), bad).toContain("VERIFIER_ISOLATION_PROVEN");
    }
  });

  it("limits public reports per reporter per hour (default 3, positive integer)", () => {
    expect(loadIdentityConfig(identityEnv).intakeMaxReportsPerHour).toBe(3);
    expect(loadIdentityConfig({ ...identityEnv, INTAKE_MAX_REPORTS_PER_HOUR: "5" }).intakeMaxReportsPerHour).toBe(5);
    for (const bad of ["0", "-1", "x", "1.5"]) {
      expect(issuesOf(() => loadIdentityConfig({ ...identityEnv, INTAKE_MAX_REPORTS_PER_HOUR: bad })).map((i) => i.variable), bad).toContain("INTAKE_MAX_REPORTS_PER_HOUR");
    }
  });
});

describe("runtime group", () => {
  it("applies safe defaults: merging disabled", () => {
    const c = loadRuntimeConfig({});
    expect(c.mergeEnabled).toBe(false);
    expect(c.quorum).toBe(1);
    expect(c.transientRetryLimit).toBe(3);
  });
  it("rejects non-boolean and non-positive values", () => {
    const issues = issuesOf(() => loadRuntimeConfig({ MERGE_ENABLED: "yes", QUORUM: "0" }));
    expect(issues.map((i) => i.variable).sort()).toEqual(["MERGE_ENABLED", "QUORUM"]);
  });
});

describe("Switch URL transport security", () => {
  it("requires https unless the host is loopback (the agent API key travels on it)", () => {
    for (const ok of ["https://switch.example.com", "http://localhost:8080", "http://127.0.0.1:9000"]) {
      expect(() => loadSwitchConfig({ ...switchEnv, SWITCH_BRIDGE_URL: ok }), ok).not.toThrow();
    }
    for (const bad of ["http://switch.example.com", "javascript:alert(1)", "ftp://x", "file:///etc/passwd", "not a url"]) {
      expect(() => loadSwitchConfig({ ...switchEnv, SWITCH_BRIDGE_URL: bad }), bad).toThrow(ConfigError);
    }
  });
});

describe("step 2.5 and 2.8: secret hygiene and ignore rules", () => {
  it(".gitignore ignores runtime secrets, data, and planning documents", async () => {
    const { execFileSync } = await import("node:child_process");
    const toCheck = [".env", ".env.local", "secrets/gate.pem", "data/loopback.db", "plan.md", "implementation.md"];
    const out = execFileSync("git", ["check-ignore", ...toCheck], { encoding: "utf8" });
    const ignored = out.trim().split("\n");
    for (const file of toCheck) {
      expect(ignored).toContain(file);
    }
  });

  it(".gitignore does not ignore .env.example", async () => {
    const { execFileSync } = await import("node:child_process");
    expect(() => execFileSync("git", ["check-ignore", "-q", ".env.example"])).toThrow();
  });

  // secrets/ is local and git-ignored, so it does not exist in a fresh clone or in CI; when it
  // does exist (a configured machine), it must be private.
  // Skipped on Windows: POSIX permission bits are not meaningful there.
  it.skipIf(process.platform === "win32")("a local secrets/ directory, when present, is a directory closed to group and others", async () => {
    const { existsSync, lstatSync } = await import("node:fs");
    if (!existsSync("secrets")) return;
    const stat = lstatSync("secrets");
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
  });
});


describe("D28 isolated verification configuration", () => {
  const { publicKey: edPub, privateKey: edPriv } = generateKeyPairSync("ed25519");
  const pem = edPub.export({ type: "spki", format: "pem" }).toString();
  const raw = edPub.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
  const FIXER_AGENT = "11111111-2222-4333-8444-555555555555";
  const VERIFIER_AGENT = "66666666-2222-4333-8444-555555555555";
  const isolated = {
    ...identityEnv, VERIFIER_ISOLATION_PROVEN: "true", VERIFIER_PUBLIC_KEY: raw,
    LOOPBACK_FIXER_AGENT_ID: FIXER_AGENT, LOOPBACK_VERIFIER_AGENT_ID: VERIFIER_AGENT,
  };
  const sw = { selfId: "@switch-agent-gate:loopback", roomId: "room-1", intakeRoomId: "room-2", policyAgentIds: new Set([FIXER_AGENT, VERIFIER_AGENT]) };

  it("advisory mode needs no key or agent ids, and stays advisory", () => {
    const c = loadIdentityConfig(identityEnv);
    expect(c.verifierIsolationProven).toBe(false);
    expect(c.verifierPublicKey).toBeNull();
  });

  it("accepts a valid isolated configuration, with a raw or a PEM key", () => {
    for (const key of [raw, pem]) {
      const c = loadIdentityConfig({ ...isolated, VERIFIER_PUBLIC_KEY: key });
      expect(c.verifierIsolationProven).toBe(true);
      expect(c.verifierPublicKey?.asymmetricKeyType).toBe("ed25519");
      expect(() => assertIdentityConsistency(sw, c)).not.toThrow();
    }
  });

  it("refuses isolated mode without a public key", () => {
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, VERIFIER_PUBLIC_KEY: undefined })).map((i) => i.variable)).toContain("VERIFIER_PUBLIC_KEY");
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, VERIFIER_PUBLIC_KEY: "  " })).map((i) => i.variable)).toContain("VERIFIER_PUBLIC_KEY");
  });

  it.each([
    ["garbage", "not-a-key"],
    ["an RSA key", generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["an X25519 key", generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["a private key", edPriv.export({ type: "pkcs8", format: "pem" }).toString()],
  ])("refuses %s as VERIFIER_PUBLIC_KEY, in either mode, without echoing it", (_n, key) => {
    for (const env of [{ ...isolated, VERIFIER_PUBLIC_KEY: key }, { ...identityEnv, VERIFIER_PUBLIC_KEY: key }]) {
      try {
        loadIdentityConfig(env);
        throw new Error("expected ConfigError");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        const err = e as ConfigError;
        expect(err.issues.map((i) => i.variable)).toContain("VERIFIER_PUBLIC_KEY");
        const probe = key.trim().length > 60 ? key.trim().slice(30, 60) : key.trim();
        expect(JSON.stringify(err.issues) + err.message).not.toContain(probe);
      }
    }
  });

  it("refuses isolated mode without both agent ids, or with identical ones", () => {
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, LOOPBACK_FIXER_AGENT_ID: undefined })).map((i) => i.variable)).toContain("LOOPBACK_FIXER_AGENT_ID");
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, LOOPBACK_VERIFIER_AGENT_ID: "" })).map((i) => i.variable)).toContain("LOOPBACK_VERIFIER_AGENT_ID");
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, LOOPBACK_VERIFIER_AGENT_ID: FIXER_AGENT })).map((i) => i.variable)).toContain("LOOPBACK_VERIFIER_AGENT_ID");
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, LOOPBACK_FIXER_AGENT_ID: "not-a-uuid" })).map((i) => i.variable)).toContain("LOOPBACK_FIXER_AGENT_ID");
  });

  it("refuses identical fixer and verifier participant ids in isolated mode too", () => {
    expect(issuesOf(() => loadIdentityConfig({ ...isolated, LOOPBACK_VERIFIER_ID: identityEnv.LOOPBACK_FIXER_ID })).map((i) => i.variable)).toContain("LOOPBACK_VERIFIER_ID");
  });

  it("refuses isolated mode when an agent id is missing from SWITCH_POLICY_AGENT_IDS", () => {
    const c = loadIdentityConfig(isolated);
    for (const listed of [new Set([FIXER_AGENT]), new Set([VERIFIER_AGENT]), new Set<string>()]) {
      expect(issuesOf(() => assertIdentityConsistency({ ...sw, policyAgentIds: listed }, c)).map((i) => i.variable).length).toBeGreaterThan(0);
    }
    const withoutList = { selfId: sw.selfId, roomId: sw.roomId, intakeRoomId: sw.intakeRoomId };
    expect(issuesOf(() => assertIdentityConsistency(withoutList, c)).map((i) => i.variable)).toContain("LOOPBACK_FIXER_AGENT_ID");
  });
});
