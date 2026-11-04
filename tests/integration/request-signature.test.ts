import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueCapability, type RunContext } from "../../apps/switch-gate/src/agents/capability.js";
import { verifyReportSignature } from "../../apps/switch-gate/src/agents/signature.js";
import { FileReplayStore } from "../../apps/switch-gate/src/signer/replay.js";
import { createSignerServer, type SignerServer } from "../../apps/switch-gate/src/signer/server.js";

// D29: scripts/request-signature.mjs is the verifier's only way to get a signature: it holds the
// client token (never the key), sends the report with the gate's capability, and prints exactly
// one signed block. Exercised against a real signer server.

const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: POSIX file modes for the token file; the client runs only in the Linux verifier container.
const SCRIPT = join(process.cwd(), "scripts", "request-signature.mjs");
const issuer = generateKeyPairSync("ed25519");
const signing = generateKeyPairSync("ed25519");
const TOKEN = "f".repeat(64);
const SHA = "a".repeat(40);
const ctx: RunContext = { runId: "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", caseId: "LB-001", repository: "o/r", pullRequest: 42, headSha: SHA };
const report = { type: "verifier", ...ctx, verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "checked" };

let dir = "";
let url = "";
let server: SignerServer;

beforeAll(async () => {
  if (ON_WINDOWS) return;
  execFileSync("npx", ["tsc", "-b"], { stdio: "ignore" }); // the client imports the built canonicalization module
  dir = mkdtempSync(join(tmpdir(), "loopback-client-"));
  chmodSync(dir, 0o700);
  const state = join(dir, "state");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(dir, "token"), TOKEN, { mode: 0o600 });
  server = createSignerServer({
    clientToken: TOKEN,
    policy: { issuerPublicKey: issuer.publicKey, signingKey: signing.privateKey, allowedRepository: "o/r", now: () => new Date(), livePull: () => Promise.resolve({ state: "open", headSha: SHA }), replay: new FileReplayStore(state) },
    log: () => undefined, maxPerMinute: 100,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sign`;
}, 120_000);
afterAll(async () => {
  if (ON_WINDOWS) return;
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], input: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, LOOPBACK_SIGNER_URL: url, LOOPBACK_SIGNER_TOKEN_FILE: join(dir, "token"), HTTPS_PROXY: "http://127.0.0.1:9", ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    child.stdin!.end(input);
  });
}

describe.skipIf(ON_WINDOWS)("request-signature.mjs", () => {
  const cap = () => issueCapability(ctx, issuer.privateKey, new Date(), 10 * 60_000);

  it("prints exactly one signed block that verifies; the signer was reached directly, not via HTTPS_PROXY", async () => {
    const r = await run(["--capability", cap()], "Summary.\n```loopback-report\n" + JSON.stringify(report) + "\n```\n");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const m = /^```loopback-report\n(.+)\n```\n$/s.exec(r.stdout);
    expect(m).not.toBeNull();
    const signed = JSON.parse(m![1]!) as Record<string, unknown>;
    expect(verifyReportSignature(signed, signing.publicKey)).toEqual({ ok: true });
    expect(signed).toMatchObject(report);
  });

  it("reports the signer's refusal code and exits 1 (a second request for the same run is a replay)", async () => {
    const r = await run(["--capability", cap()], JSON.stringify({ ...report, summary: "again" }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/REPLAYED/);
    expect(r.stdout).toBe("");
  });

  it.each([
    ["no capability argument", [], JSON.stringify(report), /--capability/],
    ["no report", ["--capability", "lbcap1.a.b"], "", /no report/],
    ["invalid JSON", ["--capability", "lbcap1.a.b"], "{", /not valid JSON/],
  ])("refuses %s", async (_n, args, input, msg) => {
    const r = await run(args, input);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(msg);
  });

  it("refuses an unsafe token file and never prints the token", async () => {
    const loose = join(dir, "loose-token");
    writeFileSync(loose, TOKEN, { mode: 0o644 });
    chmodSync(loose, 0o644);
    const r = await run(["--capability", cap()], JSON.stringify(report), { LOOPBACK_SIGNER_TOKEN_FILE: loose });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/mode 600/);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("refuses a signer URL that is not plain http to a host name (no credentials over other schemes)", async () => {
    const r = await run(["--capability", cap()], JSON.stringify(report), { LOOPBACK_SIGNER_URL: "file:///etc/passwd" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/LOOPBACK_SIGNER_URL/);
  });
});
