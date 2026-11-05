import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { parseEnv } from "node:util";
import { CONTAINERS, FLAGS, REQUIRED, assessReadiness, evaluateGateConfig, parseEnvFile, parseEnvText, rulesUsable, spkiOf, type ReadinessFacts } from "../../scripts/live-readiness.mjs";
import { ConfigError, assertIdentityConsistency, loadGitHubConfig, loadIdentityConfig, loadRunIssuerKey, loadRuntimeConfig, loadSwitchConfig } from "../../apps/switch-gate/src/config.js";
import { writePrivateKey } from "../helpers/private-key.js";

// Live readiness is a read-only report: it must never call a missing prerequisite ready, and it
// must report any safety flag that is on as a problem (it never turns one on).

/** Every gate rule ran (as evaluateGateConfig reports for a fully evaluated configuration). */
const ALL_RAN = { switch: true, identity: true, github: true, runtime: true, consistency: true, issuerKey: true, isolatedIdentity: true, isolatedConsistency: true };
const full = (): ReadinessFacts => ({
  env: Object.fromEntries(Object.values(REQUIRED).flat().map((n) => [n, "x"])),
  keyModes: { GH_APP_PRIVATE_KEY_PATH: 0o600, LOOPBACK_RUN_ISSUER_KEY_PATH: 0o600 },
  daemon: true, containers: [...CONTAINERS],
  credFiles: {
    "fixer.env": { mode: 0o600, names: ["GH_TOKEN", "GH_REPO"] }, "verifier.env": { mode: 0o600, names: ["GH_TOKEN", "GH_REPO"] },
    "signer.env": { mode: 0o600, names: ["SIGNER_REPOSITORY", "SIGNER_ISSUER_PUBLIC_KEY"] },
  },
  tagRuleset: true,
  signerKeyMatch: true,
  gateConfig: { available: true, issues: [], ran: ALL_RAN },
});
const missing = (f: ReadinessFacts) => assessReadiness(f).filter((i) => !i.ok).map((i) => i.text).join("\n");

describe("parseEnvText", () => {
  it("never reads an inline comment as a value: a missing setting must not look set", () => {
    const env = parseEnvText("EMPTY=\nCOMMENTED=              # who to list here\nSET=abc  # note\nHASH=a#b\n# NOT_A_SETTING=x\nCRLF=y\r\n");
    expect(env).toEqual({ EMPTY: "", COMMENTED: "", SET: "abc", HASH: "a#b", CRLF: "y" });
  });

  it("gives node --env-file no comment as a value when .env is copied from .env.example", () => {
    const parsed = parseEnv(readFileSync(join(process.cwd(), ".env.example"), "utf8"));
    expect(Object.entries(parsed).filter(([, v]) => v?.includes("#")).map(([k]) => k)).toEqual([]);
  });

  it("makes the real .env.example report the required settings it leaves empty as missing", () => {
    const example = parseEnvText(readFileSync(join(process.cwd(), ".env.example"), "utf8"));
    const text = assessReadiness({ ...full(), env: example }).filter((i) => !i.ok).map((i) => i.text).join("\n");
    for (const name of ["LOOPBACK_MAINTAINERS", "SWITCH_POLICY_USER_IDS", "VERIFIER_PUBLIC_KEY"]) expect(text).toContain(name);
  });
});

describe("assessReadiness", () => {
  it("is ready only when every prerequisite holds and every safety flag is off", () => {
    expect(assessReadiness(full()).every((i) => i.ok)).toBe(true);
  });

  it("names each missing configuration variable (never its value)", () => {
    const f = full();
    delete f.env.SWITCH_AGENT_API_KEY;
    f.env.VERIFIER_PUBLIC_KEY = "   ";
    expect(missing(f)).toMatch(/missing: SWITCH_AGENT_API_KEY/);
    expect(missing(f)).toMatch(/missing: VERIFIER_PUBLIC_KEY/);
  });

  it.each(FLAGS)("reports %s=true as a problem", (flag) => {
    const f = full();
    f.env[flag] = "true";
    expect(missing(f)).toMatch(new RegExp(`${flag}=true .*ON`));
  });

  it("flags loose or missing key files, a stopped runtime, missing containers, credential files and the tag ruleset", () => {
    const f: ReadinessFacts = { ...full(), keyModes: { GH_APP_PRIVATE_KEY_PATH: 0o644, LOOPBACK_RUN_ISSUER_KEY_PATH: null }, daemon: false, containers: ["loopback-fixer"], tagRuleset: false,
      credFiles: { "fixer.env": null, "verifier.env": { mode: 0o644, names: ["GH_TOKEN"] }, "signer.env": { mode: 0o600, names: ["SIGNER_REPOSITORY"] } } };
    const m = missing(f);
    for (const re of [/GH_APP_PRIVATE_KEY_PATH: mode 644/, /LOOPBACK_RUN_ISSUER_KEY_PATH: file not found/, /daemon not running/, /not running: loopback-verifier/, /fixer.env: absent/, /verifier.env: mode 644, missing GH_REPO/, /signer.env: mode 600, missing SIGNER_ISSUER_PUBLIC_KEY/, /tag ruleset missing/]) {
      expect(m).toMatch(re);
    }
  });

  it("requires VERIFIER_PUBLIC_KEY to be the signer's key (an old verifier-held key would bypass the signer)", () => {
    expect(missing({ ...full(), signerKeyMatch: false })).toMatch(/NOT the signer's public key/);
    expect(missing({ ...full(), signerKeyMatch: null })).toMatch(/could not compare/);
  });

  it("compares keys given as PEM or raw base64", () => {
    const k = generateKeyPairSync("ed25519").publicKey;
    const pem = k.export({ type: "spki", format: "pem" }).toString();
    const raw = k.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
    expect(spkiOf(pem)).not.toBeNull();
    expect(spkiOf(pem)).toBe(spkiOf(raw));
    expect(spkiOf("garbage!")).toBeNull();
  });

  it("an unknown tag-ruleset state is not ready", () => {
    expect(missing({ ...full(), tagRuleset: null })).toMatch(/could not check/);
  });
});

// The readiness list must be derived from the gate's real configuration loaders, not copied by
// hand: remove one variable at a time from a valid environment and see which ones a loader
// rejects. Unconditional requirements come from the default configuration; the isolated-mode
// ones from VERIFIER_ISOLATION_PROVEN=true (set only in this in-memory test env).
describe("REQUIRED matches the gate's configuration loaders", () => {
  const issuer = generateKeyPairSync("ed25519").publicKey;
  const switchEnv = {
    SWITCH_BRIDGE_URL: "http://localhost:8080", SWITCH_AGENT_ID: "agent-1", SWITCH_AGENT_API_KEY: "k".repeat(32),
    SWITCH_ROOM_ID: "room-1", SWITCH_INTAKE_ROOM_ID: "room-2", SWITCH_SELF_ID: "@switch-agent-gate:loopback",
    SWITCH_GATE_MENTION: "@loopback-gate",
    SWITCH_POLICY_USER_IDS: "11111111-2222-4333-8444-555555555555", SWITCH_POLICY_AGENT_IDS: "66666666-2222-4333-8444-555555555555",
  };
  const identityEnv = {
    LOOPBACK_MAINTAINERS: "@switch-user-a1:loopback", LOOPBACK_REPORTERS: "@switch-user-r2:loopback",
    LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback", LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
  };
  const isolatedEnv = {
    ...identityEnv, VERIFIER_ISOLATION_PROVEN: "true",
    VERIFIER_PUBLIC_KEY: issuer.export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
    LOOPBACK_FIXER_AGENT_ID: "77777777-2222-4333-8444-555555555555", LOOPBACK_VERIFIER_AGENT_ID: "88888888-2222-4333-8444-555555555555",
    LOOPBACK_RUN_ISSUER_KEY_PATH: "/srv/loopback/secrets/run-issuer.pem",
  };
  const githubEnv = {
    GH_REPO: "acme/demo", GH_APP_ID: "123", GH_APP_INSTALLATION_ID: "456", GH_APP_PRIVATE_KEY_PATH: "/nonexistent/gate.pem",
    BASE_BRANCH: "main", REQUIRED_CHECKS: "test", CHECK_SOURCES: "test:github-actions", REQUIRED_CHECK_INTEGRATIONS: "test:15368",
    DEMO_RESET_SHA: "a".repeat(40),
  };

  /** Variables whose removal makes `load` report an issue for exactly that variable. */
  function requiredBy(load: (env: Record<string, string>) => unknown, full: Record<string, string>, skip: readonly string[] = []): string[] {
    expect(() => load(full)).not.toThrow(); // the fixture itself is valid
    return Object.keys(full).filter((name) => {
      if (skip.includes(name)) return false;
      const env: Record<string, string> = { ...full };
      delete env[name];
      try {
        load(env);
        return false;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        return e.issues.some((i) => i.variable === name);
      }
    });
  }

  const unconditional = () => [
    ...requiredBy(loadSwitchConfig, switchEnv),
    ...requiredBy(loadIdentityConfig, identityEnv),
    ...requiredBy((env) => loadGitHubConfig(env, { checkKeyFile: false }), githubEnv),
  ];
  // Removing VERIFIER_ISOLATION_PROVEN itself turns isolated mode off; it is a flag, not a requirement.
  const isolatedOnly = () => requiredBy(loadIdentityConfig, isolatedEnv, ["VERIFIER_ISOLATION_PROVEN"]).filter((n) => !(n in identityEnv));
  /** Required by the live demo run itself (D17), not by the gate's loaders. */
  const LIVE_RUN_EXTRAS = ["DEMO_RESET_SHA"];
  const listed = () => Object.values(REQUIRED).flat();

  it("lists every variable the gate requires unconditionally (including LOOPBACK_REPORTERS and BASE_BRANCH)", () => {
    const needed = unconditional();
    expect(needed).toEqual(expect.arrayContaining(["LOOPBACK_REPORTERS", "BASE_BRANCH"]));
    expect(needed.filter((n) => !listed().includes(n))).toEqual([]);
  });

  it("lists every variable the gate requires for isolated verification (D28/D29)", () => {
    const needed = isolatedOnly();
    expect(needed.sort()).toEqual(["LOOPBACK_FIXER_AGENT_ID", "LOOPBACK_RUN_ISSUER_KEY_PATH", "LOOPBACK_VERIFIER_AGENT_ID", "VERIFIER_PUBLIC_KEY"]);
    expect(needed.filter((n) => !listed().includes(n))).toEqual([]);
  });

  it("requires nothing the gate does not (a defaulted variable such as SWITCH_GATE_MENTION is not a prerequisite)", () => {
    const derived = new Set([...unconditional(), ...isolatedOnly(), ...LIVE_RUN_EXTRAS]);
    expect(listed().filter((n) => !derived.has(n))).toEqual([]);
  });

  it("the runtime loader requires nothing (every runtime variable has a default); a new requirement there would fail here", () => {
    expect(() => loadRuntimeConfig({})).not.toThrow();
    const runtimeEnv = { DB_PATH: "./data/x.db", POLL_INTERVAL_MS: "10000", VERIFY_TIMEOUT_MS: "600000", FIX_TIMEOUT_MS: "2700000", TRANSIENT_RETRY_LIMIT: "3", MERGE_MAX_ATTEMPTS: "2", QUORUM: "1", LOG_LEVEL: "info", HTTP_PORT: "8787" };
    expect(requiredBy(loadRuntimeConfig, runtimeEnv)).toEqual([]);
  });

  it("never lists a safety flag as a prerequisite", () => {
    for (const flag of FLAGS) expect(listed()).not.toContain(flag);
  });

  it.each(["LOOPBACK_REPORTERS", "BASE_BRANCH"])("reports a missing %s by name", (name) => {
    const f = full();
    delete f.env[name];
    expect(missing(f)).toMatch(new RegExp(`missing: (.*, )?${name}(,|$)`, "m"));
  });
});

// Semantic validation: readiness runs the gate's OWN loaders and consistency checks (no second
// copy of the rules), so a configuration it calls ready is one the gate accepts at start-up.
describe("evaluateGateConfig: the gate's own rules", () => {
  const rules = { ConfigError, loadSwitchConfig, loadIdentityConfig, loadGitHubConfig, loadRuntimeConfig, assertIdentityConsistency, loadRunIssuerKey };
  const SECRET = "sk-SENTINEL-api-key-value-0123456789";
  let dir = "";
  let ghKey = "";
  let issuerKey = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "loopback-ready-"));
    chmodSync(dir, 0o700);
    ghKey = join(dir, "gate.pem");
    issuerKey = join(dir, "run-issuer.pem");
    writePrivateKey(ghKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    writePrivateKey(issuerKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const FIXER_AGENT = "77777777-2222-4333-8444-555555555555";
  const VERIFIER_AGENT = "88888888-2222-4333-8444-555555555555";
  const valid = (): Record<string, string> => ({
    SWITCH_BRIDGE_URL: "https://switch.example.org", SWITCH_AGENT_ID: "agent-1", SWITCH_AGENT_API_KEY: SECRET,
    SWITCH_ROOM_ID: "room-1", SWITCH_INTAKE_ROOM_ID: "room-2", SWITCH_SELF_ID: "@switch-agent-gate:loopback",
    SWITCH_POLICY_USER_IDS: "11111111-2222-4333-8444-555555555555", SWITCH_POLICY_AGENT_IDS: `${FIXER_AGENT},${VERIFIER_AGENT}`,
    LOOPBACK_MAINTAINERS: "@switch-user-a1:loopback", LOOPBACK_REPORTERS: "@switch-user-r2:loopback",
    LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback", LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
    LOOPBACK_FIXER_AGENT_ID: FIXER_AGENT, LOOPBACK_VERIFIER_AGENT_ID: VERIFIER_AGENT,
    VERIFIER_PUBLIC_KEY: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
    LOOPBACK_RUN_ISSUER_KEY_PATH: issuerKey,
    GH_REPO: "acme/demo", GH_APP_ID: "123", GH_APP_INSTALLATION_ID: "456", GH_APP_PRIVATE_KEY_PATH: ghKey,
    BASE_BRANCH: "main", REQUIRED_CHECKS: "test", CHECK_SOURCES: "test:github-actions", REQUIRED_CHECK_INTEGRATIONS: "test:15368",
    DEMO_RESET_SHA: "a".repeat(40),
    MERGE_ENABLED: "false", LOOPBACK_PRIVILEGED_ENABLED: "false",
  });
  const evalWith = (over: Record<string, string | undefined>, root = dir) => {
    const env: Record<string, string> = { ...valid() };
    for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
    return evaluateGateConfig(env, rules, { root });
  };
  const text = (r: ReturnType<typeof evaluateGateConfig>) => JSON.stringify(r);
  const vars = (r: ReturnType<typeof evaluateGateConfig>, scope: "current" | "isolated") => r.issues.filter((i) => i.scope === scope).map((i) => i.variable);

  it("accepts a valid configuration in the current mode and as an isolated-verification target", () => {
    expect(evalWith({}).issues).toEqual([]);
  });

  it("reports a missing value through the gate's rules", () => {
    expect(vars(evalWith({ LOOPBACK_REPORTERS: undefined }), "current")).toContain("LOOPBACK_REPORTERS");
  });

  it.each([
    ["an http bridge URL to a remote host (the API key would travel in clear)", { SWITCH_BRIDGE_URL: "http://switch.example.org" }, "SWITCH_BRIDGE_URL"],
    ["a malformed repository", { GH_REPO: "not a repo" }, "GH_REPO"],
    ["an invalid branch name", { BASE_BRANCH: "main branch" }, "BASE_BRANCH"],
    ["a demo branch without a demo run id", { BASE_BRANCH: "demo/x" }, "DEMO_RUN_ID"],
    ["a required check without an integration id", { REQUIRED_CHECKS: "test,lint", CHECK_SOURCES: "test:github-actions,lint:github-actions" }, "REQUIRED_CHECK_INTEGRATIONS"],
    ["a non-numeric App id", { GH_APP_ID: "abc" }, "GH_APP_ID"],
    ["a wildcard maintainer list", { LOOPBACK_MAINTAINERS: "*" }, "LOOPBACK_MAINTAINERS"],
    ["a reporter that is not a participant id (gate rule: 3-256 characters)", { LOOPBACK_REPORTERS: "ab" }, "LOOPBACK_REPORTERS"],
    ["a non-UUID policy agent list", { SWITCH_POLICY_AGENT_IDS: "fixer,verifier" }, "SWITCH_POLICY_AGENT_IDS"],
    ["a malformed verifier public key", { VERIFIER_PUBLIC_KEY: "MCowBQYDK2VwAyEAElyXiLq8ap0k9LnmWXFbGhJvFcvr8Ihf6Cec0lmbcJY=" }, "VERIFIER_PUBLIC_KEY"],
    ["a relative run-issuer key path", { LOOPBACK_RUN_ISSUER_KEY_PATH: "secrets/run-issuer.pem" }, "LOOPBACK_RUN_ISSUER_KEY_PATH"],
    ["a run-issuer key path to a missing file", { LOOPBACK_RUN_ISSUER_KEY_PATH: "/nonexistent/run-issuer.pem" }, "LOOPBACK_RUN_ISSUER_KEY_PATH"],
    ["a GitHub App key path to a missing file", { GH_APP_PRIVATE_KEY_PATH: "/nonexistent/gate.pem" }, "GH_APP_PRIVATE_KEY_PATH"],
    ["a non-boolean safety flag", { MERGE_ENABLED: "yes" }, "MERGE_ENABLED"],
  ])("reports %s", (_n, over, variable) => {
    expect(vars(evalWith(over), "current")).toContain(variable);
  });

  it("resolves a relative GitHub App key path against the repository root (where the gate runs)", () => {
    expect(vars(evalWith({ GH_APP_PRIVATE_KEY_PATH: "./gate.pem" }), "current")).not.toContain("GH_APP_PRIVATE_KEY_PATH");
    expect(vars(evalWith({ GH_APP_PRIVATE_KEY_PATH: "./gate.pem" }, "/nonexistent-root"), "current")).toContain("GH_APP_PRIVATE_KEY_PATH");
  });

  it("reports key files that others can read, and a run-issuer file that is not an Ed25519 private key", () => {
    const loose = join(dir, "loose.pem");
    writeFileSync(loose, readFileSync(ghKey), { mode: 0o644 });
    chmodSync(loose, 0o644);
    expect(vars(evalWith({ GH_APP_PRIVATE_KEY_PATH: loose }), "current")).toContain("GH_APP_PRIVATE_KEY_PATH");
    const pub = join(dir, "pub.pem");
    writeFileSync(pub, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    expect(vars(evalWith({ LOOPBACK_RUN_ISSUER_KEY_PATH: pub }), "current")).toContain("LOOPBACK_RUN_ISSUER_KEY_PATH");
  });

  it.each([
    ["the gate's own id is a maintainer", { LOOPBACK_MAINTAINERS: "@switch-agent-gate:loopback" }, "LOOPBACK_MAINTAINERS"],
    ["the gate's own id is a reporter", { LOOPBACK_REPORTERS: "@switch-agent-gate:loopback" }, "LOOPBACK_REPORTERS"],
    ["the intake room is the maintainer room", { SWITCH_INTAKE_ROOM_ID: "room-1" }, "SWITCH_INTAKE_ROOM_ID"],
    ["the gate is the fixer", { LOOPBACK_FIXER_ID: "@switch-agent-gate:loopback" }, "SWITCH_SELF_ID"],
    ["fixer and verifier are the same participant", { LOOPBACK_VERIFIER_ID: "@switch-agent-fixer:loopback" }, "LOOPBACK_VERIFIER_ID"],
    ["a maintainer is an agent", { LOOPBACK_MAINTAINERS: "@switch-agent-fixer:loopback" }, "LOOPBACK_MAINTAINERS"],
  ])("reports inconsistent identities: %s", (_n, over, variable) => {
    expect(vars(evalWith(over), "current")).toContain(variable);
  });

  it("reports, for the isolated-verification target only, agent ids missing from SWITCH_POLICY_AGENT_IDS (the flag itself stays off)", () => {
    const r = evalWith({ SWITCH_POLICY_AGENT_IDS: FIXER_AGENT });
    expect(vars(r, "current")).toEqual([]);
    expect(vars(r, "isolated")).toEqual(["LOOPBACK_VERIFIER_AGENT_ID"]);
    expect(vars(evalWith({ LOOPBACK_FIXER_AGENT_ID: undefined, LOOPBACK_VERIFIER_AGENT_ID: undefined, VERIFIER_PUBLIC_KEY: undefined, LOOPBACK_RUN_ISSUER_KEY_PATH: undefined }), "isolated").sort())
      .toEqual(["LOOPBACK_FIXER_AGENT_ID", "LOOPBACK_RUN_ISSUER_KEY_PATH", "LOOPBACK_VERIFIER_AGENT_ID", "VERIFIER_PUBLIC_KEY"]);
  });

  it("never echoes values: no API key, key path contents or private key material in the result", () => {
    const r = evalWith({ SWITCH_BRIDGE_URL: "http://switch.example.org", LOOPBACK_RUN_ISSUER_KEY_PATH: join(dir, "pub.pem"), GH_REPO: SECRET });
    expect(text(r)).not.toContain(SECRET);
    expect(text(r)).not.toMatch(/PRIVATE KEY|PUBLIC KEY/);
    expect(text(r)).not.toContain(readFileSync(issuerKey, "utf8").split("\n")[1]!);
  });

  it("an unexpected error in a loader is reported as such, never as ready", () => {
    const broken = { ...rules, loadSwitchConfig: () => { throw new TypeError("boom"); } };
    const r = evaluateGateConfig(valid(), broken, { root: dir });
    expect(r.issues).toContainEqual(expect.objectContaining({ variable: "(Switch)", message: "could not be evaluated" }));
  });

  // End to end through assessReadiness with the real rules: acceptance only when every rule ran.
  const verdict = (over: Record<string, string | undefined>) => {
    const env: Record<string, string> = { ...valid() };
    for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
    const facts = { ...full(), env, gateConfig: { available: true, ...evaluateGateConfig(env, rules, { root: dir }) } };
    const items = assessReadiness(facts);
    return {
      accepts: items.some((i) => i.ok && /accept/.test(i.text)),
      isolatedOk: items.some((i) => i.ok && /Isolated verification/.test(i.group)),
      isolatedText: items.filter((i) => /Isolated verification/.test(i.group)).map((i) => i.text).join("\n"),
    };
  };

  it("a valid configuration is accepted and has no isolated blocker (end to end)", () => {
    expect(verdict({})).toMatchObject({ accepts: true, isolatedOk: true });
  });

  it.each([
    ["an isolated-only variable is unset (agent id)", { LOOPBACK_FIXER_AGENT_ID: undefined }],
    ["the verifier public key is unset", { VERIFIER_PUBLIC_KEY: undefined }],
    ["the Switch rules reject a value (remote http bridge)", { SWITCH_BRIDGE_URL: "http://switch.example.org" }],
    ["the identity rules reject a value (wildcard maintainers)", { LOOPBACK_MAINTAINERS: "*" }],
  ])("never reports 'no additional blocker for isolated verification' when %s", (_n, over) => {
    const v = verdict(over);
    expect(v.isolatedOk).toBe(false);
  });

  it("an agent id missing from SWITCH_POLICY_AGENT_IDS is reported for the isolated target (end to end)", () => {
    const v = verdict({ SWITCH_POLICY_AGENT_IDS: FIXER_AGENT });
    expect(v.isolatedOk).toBe(false);
    expect(v.isolatedText).toMatch(/LOOPBACK_VERIFIER_AGENT_ID: must be listed in SWITCH_POLICY_AGENT_IDS/);
  });

  it("acceptance is not claimed when any rule group did not run", () => {
    expect(verdict({ LOOPBACK_MAINTAINERS: "*" }).accepts).toBe(false);
    expect(verdict({ GH_REPO: "bad" }).accepts).toBe(false);
  });

  it("does not echo secrets placed in several invalid fields", () => {
    const S = "zz-SECRET-SENTINEL-zz";
    const r = evalWith({ SWITCH_BRIDGE_URL: `http://${S}.example.org`, LOOPBACK_MAINTAINERS: `${S},*`, GH_REPO: S, BASE_BRANCH: `${S} x`, SWITCH_POLICY_AGENT_IDS: S, VERIFIER_PUBLIC_KEY: S });
    expect(r.issues.length).toBeGreaterThan(4);
    expect(JSON.stringify(r)).not.toContain(S);
  });

  it("tags each issue with the gate rule group that raised it", () => {
    const r = evalWith({ LOOPBACK_MAINTAINERS: undefined, BASE_BRANCH: "main branch" });
    expect(r.issues).toContainEqual(expect.objectContaining({ scope: "current", group: "identity", variable: "LOOPBACK_MAINTAINERS" }));
    expect(r.issues).toContainEqual(expect.objectContaining({ scope: "current", group: "GitHub", variable: "BASE_BRANCH" }));
  });
});

describe("assessReadiness: gate configuration items", () => {
  it("is ready only when the gate's rules accept the configuration; unavailable rules are not ready", () => {
    expect(missing({ ...full(), gateConfig: { available: true, issues: [], ran: ALL_RAN } })).toBe("");
    expect(missing({ ...full(), gateConfig: { available: true, issues: [] } })).toMatch(/not every configuration rule could run/);
    expect(missing({ ...full(), gateConfig: { available: false, issues: [] } })).toMatch(/cannot check.*npm run build/);
    expect(missing({ ...full(), gateConfig: { available: false, reason: "stale", issues: [] } })).toMatch(/older than its sources/);
    expect(missing({ ...full(), gateConfig: { available: true, issues: [{ scope: "current", variable: "BASE_BRANCH", message: "invalid branch name" }] } })).toMatch(/BASE_BRANCH: invalid branch name/);
    const iso = assessReadiness({ ...full(), gateConfig: { available: true, ran: ALL_RAN, issues: [{ scope: "isolated", variable: "LOOPBACK_FIXER_AGENT_ID", message: "must be listed in SWITCH_POLICY_AGENT_IDS when VERIFIER_ISOLATION_PROVEN=true" }] } })
      .filter((i) => !i.ok);
    expect(iso).toEqual([expect.objectContaining({ group: expect.stringMatching(/Isolated verification/) as unknown as string, text: expect.stringMatching(/^LOOPBACK_FIXER_AGENT_ID: must be listed/) as unknown as string })]);
  });

  it("never claims acceptance for a group whose rules stopped at a missing variable (later rules did not run)", () => {
    const f = full();
    delete f.env.LOOPBACK_MAINTAINERS;
    const items = assessReadiness({ ...f, gateConfig: { available: true, issues: [{ scope: "current", group: "identity", variable: "LOOPBACK_MAINTAINERS", message: "required" }] } });
    expect(items.some((i) => i.ok && /accepts/.test(i.text))).toBe(false);
    expect(items.filter((i) => !i.ok).map((i) => i.text).join("\n")).toMatch(/identity rules only partly checked/);
    // The isolated-verification target depends on the same identity rules: not claimed either.
    expect(items.some((i) => i.ok && /Isolated verification/.test(i.group))).toBe(false);
    expect(items.some((i) => !i.ok && /Isolated verification/.test(i.group) && /not checked yet/.test(i.text))).toBe(true);
  });

  it("does not repeat a variable already reported as missing", () => {
    const f = full();
    delete f.env.LOOPBACK_REPORTERS;
    const items = assessReadiness({ ...f, gateConfig: { available: true, issues: [{ scope: "current", variable: "LOOPBACK_REPORTERS", message: "required" }] } });
    expect(items.filter((i) => !i.ok && i.text.includes("LOOPBACK_REPORTERS"))).toHaveLength(1);
  });
});

describe("rulesUsable: a stale or incomplete gate build is never used", () => {
  const complete = { ConfigError: class extends Error {}, loadSwitchConfig() {}, loadIdentityConfig() {}, loadGitHubConfig() {}, loadRuntimeConfig() {}, assertIdentityConsistency() {}, loadRunIssuerKey() {} };
  it("accepts a complete module built after its sources", () => {
    expect(rulesUsable(complete, 2000, [1000, 1500])).toEqual({ ok: true });
  });
  it("refuses a build older than a rule source", () => {
    expect(rulesUsable(complete, 1000, [1500])).toEqual({ ok: false, reason: "stale" });
  });
  it.each(["ConfigError", "loadRunIssuerKey", "assertIdentityConsistency"])("refuses a module without %s", (name) => {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[name];
    expect(rulesUsable(partial, 2000, [1000])).toEqual({ ok: false, reason: "incomplete" });
  });
});

describe("parseEnvFile: values exactly as the gate receives them (docker --env-file)", () => {
  it("keeps inline '#' text and quotes verbatim; skips comment and blank lines", () => {
    expect(parseEnvFile("# c\n\nA=1\nB=x # note\nC=\"q\"\nD=\r\n  E=5\n")).toEqual({ A: "1", B: "x # note", C: "\"q\"", D: "", E: "5" });
  });
  it("an inline comment on an empty value is a value, and the gate rules see it", () => {
    expect(parseEnvFile("LOOPBACK_RUN_ISSUER_KEY_PATH=   # D29 key path\n").LOOPBACK_RUN_ISSUER_KEY_PATH).toBe("   # D29 key path");
  });
});
