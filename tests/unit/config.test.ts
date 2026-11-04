import { describe, expect, it } from "vitest";
import {
  ConfigError,
  assertPrivateKeyFile,
  loadGitHubConfig,
  loadIdentityConfig,
  loadRuntimeConfig,
  loadSwitchConfig,
} from "../../apps/switch-gate/src/config.js";

const SECRET = "sk-super-secret-value-123456";

const switchEnv = {
  SWITCH_BRIDGE_URL: "http://localhost:8080",
  SWITCH_AGENT_ID: "agent-1",
  SWITCH_AGENT_API_KEY: SECRET,
  SWITCH_ROOM_ID: "room-1",
  SWITCH_SELF_ID: "@switch-agent-gate:loopback",
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
  it("loads a complete group and leaves privileged commands disabled without a verified sender kind", () => {
    const c = loadSwitchConfig(switchEnv);
    expect(c.roomId).toBe("room-1");
    expect(c.humanSenderKind).toBeNull();
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

  it("rejects identical fixer and verifier ids", () => {
    const issues = issuesOf(() =>
      loadIdentityConfig({ ...identityEnv, LOOPBACK_VERIFIER_ID: identityEnv.LOOPBACK_FIXER_ID }),
    );
    expect(issues.map((i) => i.variable)).toContain("LOOPBACK_VERIFIER_ID");
  });
});

describe("GitHub group", () => {
  it("parses checks and sources", () => {
    const c = loadGitHubConfig(githubEnv, { checkKeyFile: false });
    expect(c.owner).toBe("acme");
    expect(c.checkSources.get("test")).toBe("github-actions");
    expect(c.gateStatusContext).toBe("loopback/gate");
  });

  it("requires a source for every required check", () => {
    const issues = issuesOf(() =>
      loadGitHubConfig({ ...githubEnv, REQUIRED_CHECKS: "test,lint" }, { checkKeyFile: false }),
    );
    expect(issues.map((i) => i.variable)).toContain("CHECK_SOURCES");
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
