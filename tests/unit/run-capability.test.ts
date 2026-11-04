import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MAX_TTL_MS, issueCapability, issueUncheckedCapabilityForTests, verifyCapability, type RunContext,
} from "../../apps/switch-gate/src/agents/capability.js";

// D29: the gate issues a signed, expiring capability for each verification run. The signer
// accepts only capabilities signed by the gate's run-issuer key, bound to one run context.

const issuer = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const T0 = new Date("2026-11-04T12:00:00.000Z");
const TTL = 30 * 60_000;
const ctx: RunContext = {
  runId: "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", caseId: "LB-001", repository: "o/r", pullRequest: 42, headSha: "a".repeat(40),
};
const at = (ms: number) => new Date(T0.getTime() + ms);
const token = () => issueCapability(ctx, issuer.privateKey, T0, TTL);
const parts = (t: string) => t.split(".") as [string, string, string];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("run capability", () => {
  it("round-trips: the verified capability carries exactly the run context", () => {
    const r = verifyCapability(token(), issuer.publicKey, at(1000));
    expect(r).toEqual({ ok: true, capability: { v: 1, ...ctx, issuedAt: T0.toISOString(), expiresAt: at(TTL).toISOString() } });
  });

  it("has the documented shape and never embeds key material", () => {
    const t = token();
    expect(t).toMatch(/^lbcap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    expect(t).not.toMatch(/PRIVATE/);
  });

  it("rejects a capability signed by any other key", () => {
    const forged = issueCapability(ctx, other.privateKey, T0, TTL);
    expect(verifyCapability(forged, issuer.publicKey, at(1000))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["the run id", { runId: "00000000-0000-4000-8000-000000000000" }],
    ["the head SHA", { headSha: "b".repeat(40) }],
    ["the PR number", { pullRequest: 43 }],
    ["the repository", { repository: "evil/r" }],
    ["the expiry", { expiresAt: at(TTL * 2).toISOString() }],
  ])("rejects a payload whose %s was changed after signing", (_n, change) => {
    const [p, payload, sig] = parts(token());
    const altered = { ...JSON.parse(Buffer.from(payload, "base64url").toString()) as object, ...change };
    expect(verifyCapability(`${p}.${b64(altered)}.${sig}`, issuer.publicKey, at(1000))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired capability and one issued in the future (beyond the clock skew)", () => {
    expect(verifyCapability(token(), issuer.publicKey, at(TTL + 1))).toEqual({ ok: false, reason: "expired" });
    expect(verifyCapability(token(), issuer.publicKey, at(-5 * 60_000))).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(verifyCapability(token(), issuer.publicKey, at(-30_000)).ok).toBe(true); // within skew
  });

  it.each([
    ["empty", () => ""],
    ["another prefix", () => token().replace(/^lbcap1/, "lbcap2")],
    ["two parts", () => parts(token()).slice(0, 2).join(".")],
    ["four parts", () => `${token()}.x`],
    ["bad base64", () => `lbcap1.!!!.${parts(token())[2]}`],
    ["a non-JSON payload", () => `lbcap1.${Buffer.from("nope").toString("base64url")}.${parts(token())[2]}`],
    ["an oversized token", () => `lbcap1.${"A".repeat(5000)}.${parts(token())[2]}`],
    ["a short signature", () => `${parts(token())[0]}.${parts(token())[1]}.AAAA`],
    ["a non-string", () => 42 as unknown as string],
  ])("rejects a malformed token: %s", (_n, t) => {
    expect(verifyCapability(t(), issuer.publicKey, at(1000))).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["an unknown version", { v: 2 }],
    ["an extra field", { admin: true }],
    ["a short SHA", { headSha: "abc" }],
    ["a non-uuid run id", { runId: "../../etc/passwd" }],
    ["a lifetime above the maximum", { expiresAt: at(CAPABILITY_MAX_TTL_MS + 1).toISOString() }],
    ["expiry before issue", { expiresAt: at(-1).toISOString() }],
  ])("rejects a correctly signed capability with %s", (_n, change) => {
    // Signed with the real issuer: the schema must hold even for the gate's own key.
    const payload = { v: 1, ...ctx, issuedAt: T0.toISOString(), expiresAt: at(TTL).toISOString(), ...change };
    const t = issueUncheckedCapabilityForTests(payload, issuer.privateKey);
    expect(verifyCapability(t, issuer.publicKey, at(1000))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses to issue with a public key, a non-Ed25519 key, or a lifetime outside (0, max]", () => {
    expect(() => issueCapability(ctx, issuer.publicKey, T0, TTL)).toThrow();
    expect(() => issueCapability(ctx, generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey, T0, TTL)).toThrow();
    expect(() => issueCapability(ctx, issuer.privateKey, T0, 0)).toThrow();
    expect(() => issueCapability(ctx, issuer.privateKey, T0, CAPABILITY_MAX_TTL_MS + 1)).toThrow();
    expect(() => issueCapability({ ...ctx, headSha: "short" }, issuer.privateKey, T0, TTL)).toThrow();
  });

  it("verification reports a non-Ed25519 or private key instead of throwing", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    expect(verifyCapability(token(), rsa, at(1000))).toEqual({ ok: false, reason: "unsupported_key" });
    expect(verifyCapability(token(), issuer.privateKey, at(1000))).toEqual({ ok: false, reason: "unsupported_key" });
  });
});
