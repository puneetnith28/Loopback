import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTAINERS, FLAGS, REQUIRED, assessReadiness, parseEnvText, spkiOf, type ReadinessFacts } from "../../scripts/live-readiness.mjs";

// Live readiness is a read-only report: it must never call a missing prerequisite ready, and it
// must report any safety flag that is on as a problem (it never turns one on).

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
});
const missing = (f: ReadinessFacts) => assessReadiness(f).filter((i) => !i.ok).map((i) => i.text).join("\n");

describe("parseEnvText", () => {
  it("never reads an inline comment as a value: a missing setting must not look set", () => {
    const env = parseEnvText("EMPTY=\nCOMMENTED=              # who to list here\nSET=abc  # note\nHASH=a#b\n# NOT_A_SETTING=x\nCRLF=y\r\n");
    expect(env).toEqual({ EMPTY: "", COMMENTED: "", SET: "abc", HASH: "a#b", CRLF: "y" });
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
