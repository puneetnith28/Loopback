import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { issueCapability, type RunContext } from "../../apps/switch-gate/src/agents/capability.js";
import { verifyReportSignature } from "../../apps/switch-gate/src/agents/signature.js";
import { reportDigest, type LivePull } from "../../apps/switch-gate/src/signer/policy.js";
import { FileReplayStore } from "../../apps/switch-gate/src/signer/replay.js";
import { createSignerServer, type SignerServer } from "../../apps/switch-gate/src/signer/server.js";

// D29: the signer's HTTP boundary, over a real socket and a real replay directory.

const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: the replay store relies on POSIX file modes; the signer runs only in its Linux container.
const issuer = generateKeyPairSync("ed25519");
const signing = generateKeyPairSync("ed25519");
const TOKEN = "t".repeat(64);
const SHA = "a".repeat(40);
const now = new Date();
const ctx = (runId = "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c"): RunContext => ({ runId, caseId: "LB-001", repository: "o/r", pullRequest: 42, headSha: SHA });
const report = (c: RunContext, over: Record<string, unknown> = {}) => ({ type: "verifier", ...c, verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "checked", ...over });
const body = (c = ctx(), over: Record<string, unknown> = {}) => {
  const r = report(c, over);
  return { capability: issueCapability(c, issuer.privateKey, now, 10 * 60_000), report: r, reportDigest: reportDigest(r) };
};

let dir = "";
let server: SignerServer | undefined;
let pull: LivePull = { state: "open", headSha: SHA };
const logs: string[] = [];

async function start(opts: { maxPerMinute?: number } = {}): Promise<string> {
  server = createSignerServer({
    clientToken: TOKEN,
    policy: {
      issuerPublicKey: issuer.publicKey, signingKey: signing.privateKey, allowedRepository: "o/r", now: () => new Date(),
      livePull: () => Promise.resolve(pull), replay: new FileReplayStore(dir),
    },
    log: (line) => logs.push(JSON.stringify(line)),
    maxPerMinute: opts.maxPerMinute ?? 100,
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "loopback-signer-")); chmodSync(dir, 0o700); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(async () => {
  if (server) await new Promise<void>((ok) => server!.close(() => ok()));
  server = undefined;
  pull = { state: "open", headSha: SHA };
  for (const f of readdirSync(dir)) rmSync(join(dir, f));
  logs.length = 0;
});

describe.skipIf(ON_WINDOWS)("signer HTTP boundary", () => {
  it("signs a valid request once; the signature verifies; the run is recorded owner-only", async () => {
    const url = await start();
    const b = body();
    const res = await post(url, b);
    expect(res.status).toBe(200);
    const json = await res.json() as { signature: string; reportDigest: string };
    expect(json.reportDigest).toBe(b.reportDigest);
    expect(verifyReportSignature({ ...b.report, signature: json.signature }, signing.publicKey)).toEqual({ ok: true });
    const marker = join(dir, ctx().runId);
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(readFileSync(marker, "utf8")).toContain(b.reportDigest);
  });

  it.each([
    ["no Authorization header", { authorization: "" }],
    ["a wrong token", { authorization: `Bearer ${"x".repeat(64)}` }],
    ["a token prefix", { authorization: `Bearer ${TOKEN.slice(0, 63)}` }],
    ["another scheme", { authorization: `Basic ${TOKEN}` }],
  ])("refuses %s with 401 before reading the request", async (_n, headers) => {
    const url = await start();
    const res = await post(url, body(), headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a replay with 409, also across a server restart (the replay record is durable)", async () => {
    let url = await start();
    expect((await post(url, body())).status).toBe(200);
    expect((await post(url, body())).status).toBe(409);
    await new Promise<void>((ok) => server!.close(() => ok()));
    url = await start();
    const res = await post(url, body(ctx(), { verdict: "fail" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "REPLAYED" });
  });

  it("signs exactly one of many concurrent requests for the same run", async () => {
    const url = await start();
    const variants = Array.from({ length: 8 }, (_, i) => body(ctx(), { summary: `variant ${i}` }));
    const statuses = await Promise.all(variants.map(async (b) => (await post(url, b)).status));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
  });

  it("refuses a stale head with 409 and does not consume the run", async () => {
    const url = await start();
    pull = { state: "open", headSha: "b".repeat(40) };
    expect((await post(url, body())).status).toBe(409);
    pull = { state: "open", headSha: SHA };
    expect((await post(url, body())).status).toBe(200);
  });

  it.each([
    ["GET", "/v1/sign", 405],
    ["POST", "/v1/other", 404],
    ["PUT", "/v1/sign", 405],
  ])("answers %s %s with %i", async (method, path, status) => {
    const url = await start();
    const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(status);
  });

  it("refuses a non-JSON content type (415), invalid JSON (400) and an oversized body (413)", async () => {
    const url = await start();
    expect((await post(url, body(), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(url, "{not json")).status).toBe(400);
    expect((await post(url, JSON.stringify({ pad: "x".repeat(70_000) }))).status).toBe(413);
  });

  it("rate-limits authenticated requests (429)", async () => {
    const url = await start({ maxPerMinute: 2 });
    const statuses: number[] = [];
    for (const i of [0, 1, 2]) statuses.push((await post(url, body(ctx(), { summary: `r${i}` }))).status);
    expect(statuses[2]).toBe(429);
  });

  it("health check needs no token and reveals nothing", async () => {
    const url = await start();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("never logs the client token, the signature or the report text", async () => {
    const url = await start();
    const b = body(ctx(), { summary: "SENTINEL-SUMMARY" });
    const res = await post(url, b);
    const { signature } = await res.json() as { signature: string };
    await post(url, body(), { authorization: "Bearer wrong" });
    const all = logs.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(signature);
    expect(all).not.toContain("SENTINEL-SUMMARY");
    expect(all).toContain(b.reportDigest); // the digest is the audit link
  });
});

describe.skipIf(ON_WINDOWS)("FileReplayStore", () => {
  it("claims a run once, rejects path-shaped run ids, and creates owner-only files", () => {
    const store = new FileReplayStore(dir);
    expect(store.claim("6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", "sha256:x")).toBe(true);
    expect(store.claim("6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", "sha256:y")).toBe(false);
    expect(() => store.claim("../escape", "sha256:x")).toThrow();
    expect(() => store.claim("6F1C2B3A-0D4E-4F5A-8B6C-7D8E9F0A1B2C/..", "sha256:x")).toThrow();
    expect(readdirSync(dir)).toEqual(["6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c"]);
  });

  it("refuses a state directory others can write", () => {
    const loose = mkdtempSync(join(tmpdir(), "loopback-loose-"));
    try {
      chmodSync(loose, 0o777);
      expect(() => new FileReplayStore(loose)).toThrow(/writable by others/);
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });
});
