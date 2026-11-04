import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyReportSignature } from "../../apps/switch-gate/src/agents/signature.js";

// D28: scripts/sign-verifier-report.mjs signs with the gate's own canonicalization contract
// (it imports the built module), refuses unsafe key files, and never prints key material.
// The key here is a throwaway test key in a private temp directory, removed afterwards.

const SCRIPT = join(process.cwd(), "scripts", "sign-verifier-report.mjs");
const keys = generateKeyPairSync("ed25519");
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let dir = "";
let keyFile = "";

const report = {
  type: "verifier", runId: "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", caseId: "LB-001", repository: "o/r", pullRequest: 42,
  headSha: "a".repeat(40), verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "checked",
};
const run = (input: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir, VERIFIER_SIGNING_KEY_FILE: keyFile, ...env } });

beforeAll(() => {
  execFileSync("npx", ["tsc", "-b"], { stdio: "ignore" }); // the helper imports the built module
  dir = mkdtempSync(join(tmpdir(), "loopback-sign-"));
  chmodSync(dir, 0o700);
  keyFile = join(dir, "signing-key.pem");
  writeFileSync(keyFile, pem, { mode: 0o600 });
}, 60_000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("sign-verifier-report.mjs", () => {
  it("prints exactly one signed block that the gate verifies", () => {
    const r = run(JSON.stringify(report));
    expect(r.status).toBe(0);
    const m = /^```loopback-report\n(.*)\n```\n$/s.exec(r.stdout);
    expect(m).not.toBeNull();
    const signed = JSON.parse(m![1]!) as Record<string, unknown>;
    expect(verifyReportSignature(signed, keys.publicKey)).toEqual({ ok: true });
    expect({ ...signed, signature: undefined }).toEqual({ ...report, signature: undefined });
  });

  it("also accepts a message containing a loopback-report block", () => {
    const r = run(`@loopback-gate summary\n\`\`\`loopback-report\n${JSON.stringify(report)}\n\`\`\``);
    expect(r.status).toBe(0);
  });

  it.each([
    ["not JSON", "hello"],
    ["a fixer report", JSON.stringify({ ...report, type: "fixer" })],
    ["a short SHA", JSON.stringify({ ...report, headSha: "abc1234" })],
    ["a bad run id", JSON.stringify({ ...report, runId: "x" })],
    ["an already signed report", JSON.stringify({ ...report, signature: "x" })],
    ["empty input", ""],
  ])("refuses %s", (_n, input) => {
    const r = run(input);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("refuses an unsafe or missing key file, without printing key material", () => {
    chmodSync(keyFile, 0o644);
    const loose = run(JSON.stringify(report));
    chmodSync(keyFile, 0o600);
    const missing = run(JSON.stringify(report), { VERIFIER_SIGNING_KEY_FILE: join(dir, "absent.pem") });
    const notKey = join(dir, "not-a-key.pem");
    writeFileSync(notKey, "garbage", { mode: 0o600 });
    const garbage = run(JSON.stringify(report), { VERIFIER_SIGNING_KEY_FILE: notKey });
    for (const r of [loose, missing, garbage]) {
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain("PRIVATE KEY");
      expect(r.stderr).not.toContain(pem.split("\n")[1]!);
    }
    expect(loose.stderr).toMatch(/chmod 600/);
  });

  it("refuses a non-Ed25519 key", () => {
    const rsa = join(dir, "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const r = run(JSON.stringify(report), { VERIFIER_SIGNING_KEY_FILE: rsa });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not an Ed25519 key/);
  });
});
