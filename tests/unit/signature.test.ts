import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SIGNING_CONTEXT, canonicalize, parsePublicKey, signReport, signedBytes, verifyReportSignature,
} from "../../apps/switch-gate/src/agents/signature.js";

// D28: Ed25519 report signatures. Keys are generated per test run; nothing is persisted.

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

const report = (): Record<string, unknown> => ({
  type: "verifier", runId: "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", caseId: "LB-001", repository: "o/r",
  pullRequest: 42, headSha: "a".repeat(40), verdict: "pass", regressionTestFailsBeforeFix: true,
  findings: [{ severity: "info", file: "src/x.js", message: "ok" }], summary: "checked",
});
const signed = (r: Record<string, unknown> = report()) => ({ ...r, signature: signReport(r, privateKey) });

describe("canonicalize (contract v1)", () => {
  it("is independent of object key order, recursively", () => {
    const a = { b: 1, a: { d: [1, { y: true, x: null }], c: "s" } };
    const b = { a: { c: "s", d: [1, { x: null, y: true }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":"s","d":[1,{"x":null,"y":true}]},"b":1}');
  });

  it("keeps array order and escapes strings as JSON", () => {
    expect(canonicalize([2, 1])).toBe("[2,1]");
    expect(canonicalize(['q"\né'])).toBe(JSON.stringify(['q"\né']));
  });

  it.each([
    ["NaN", Number.NaN], ["Infinity", Infinity], ["-0", -0], ["undefined", undefined],
    ["a bigint", 1n], ["a function", () => 1], ["a Date", new Date(0)], ["a nested undefined", { a: undefined }],
  ])("rejects %s", (_n, v) => {
    expect(() => canonicalize(v)).toThrow();
  });

  it("signs the context tag plus everything except the signature field", () => {
    expect(signedBytes(signed()).toString("utf8")).toBe(SIGNING_CONTEXT + canonicalize(report()));
  });
});

describe("verifyReportSignature", () => {
  it("accepts a valid signature, whatever the key order of the received report", () => {
    const r = signed();
    expect(verifyReportSignature(r, publicKey)).toEqual({ ok: true });
    const reordered = Object.fromEntries(Object.entries(r).reverse());
    expect(verifyReportSignature(reordered, publicKey)).toEqual({ ok: true });
  });

  it.each([
    ["the SHA", { headSha: "b".repeat(40) }],
    ["the run id", { runId: "00000000-0000-4000-8000-000000000000" }],
    ["the verdict", { verdict: "fail" }],
    ["the PR", { pullRequest: 43 }],
    ["the repository", { repository: "o/other" }],
    ["the case", { caseId: "LB-002" }],
    ["a finding", { findings: [] }],
    ["an added field", { extra: 1 }],
  ])("rejects a report whose %s was altered after signing", (_n, change) => {
    expect(verifyReportSignature({ ...signed(), ...change }, publicKey)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a signature made with another key", () => {
    const r = { ...report(), signature: signReport(report(), other.privateKey) };
    expect(verifyReportSignature(r, publicKey)).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports a missing signature", () => {
    expect(verifyReportSignature(report(), publicKey)).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["truncated", (s: string) => s.slice(0, 40)],
    ["unpadded", (s: string) => s.replace(/=+$/, "")],
    ["non-base64", (s: string) => `${s.slice(0, 10)}*${s.slice(11)}`],
    ["url-safe", (s: string) => `${"-".repeat(86)}==`.slice(0, s.length)],
    ["over-long", (s: string) => `AAAA${s}`],
    ["empty", () => ""],
  ])("rejects a %s signature as malformed", (_n, mangle) => {
    const r = { ...report(), signature: mangle(signReport(report(), privateKey)) };
    expect(verifyReportSignature(r, publicKey)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a non-string signature as malformed", () => {
    expect(verifyReportSignature({ ...report(), signature: 7 }, publicKey)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a well-formed but wrong signature", () => {
    expect(verifyReportSignature({ ...report(), signature: `${"A".repeat(86)}==` }, publicKey)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a report that cannot be canonicalized", () => {
    expect(verifyReportSignature({ ...signed(), pullRequest: Number.NaN }, publicKey)).toEqual({ ok: false, reason: "uncanonical" });
  });

  it("refuses a non-Ed25519 or private key for verification", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(verifyReportSignature(signed(), rsa.publicKey)).toEqual({ ok: false, reason: "unsupported_key" });
    expect(verifyReportSignature(signed(), privateKey)).toEqual({ ok: false, reason: "unsupported_key" });
  });
});

describe("parsePublicKey", () => {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");

  it("accepts a PEM SPKI key and the raw 32-byte base64 key, which verify alike", () => {
    for (const text of [pem, raw, `  ${pem}\n`]) {
      const k = parsePublicKey(text);
      expect(k.asymmetricKeyType).toBe("ed25519");
      expect(verifyReportSignature(signed(), k)).toEqual({ ok: true });
    }
  });

  it.each([
    ["an RSA key", generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["an EC key", generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["an X25519 key", generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["a private key", privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
    ["garbage PEM", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"],
    ["a short raw key", Buffer.alloc(31).toString("base64")],
    ["a long raw key", Buffer.alloc(33).toString("base64")],
    ["empty", ""],
  ])("rejects %s", (_n, text) => {
    expect(() => parsePublicKey(text)).toThrow();
  });
});

describe("signReport", () => {
  it("refuses a public key or a non-Ed25519 private key", () => {
    expect(() => signReport(report(), publicKey)).toThrow();
    expect(() => signReport(report(), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey)).toThrow();
  });
});
