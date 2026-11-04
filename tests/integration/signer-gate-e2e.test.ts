import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportDigest } from "../../apps/switch-gate/src/signer/policy.js";
import { FileReplayStore } from "../../apps/switch-gate/src/signer/replay.js";
import { createSignerServer, type SignerServer } from "../../apps/switch-gate/src/signer/server.js";
import { getCase, listRuns } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, B, G, MAINT, REP, REPO, TEST_ISSUER_KEYS, VERIFIER, createHarness, type Harness } from "../helpers/harness.js";

// D29 end to end (in process): the gate issues a capability with each verification request; the
// verifier can obtain a signature only through the signer, which re-checks the capability, the
// binding and the live head (from the same GitHub the gate reads) and signs once per run; the gate
// then verifies the signature with the signer's public key, as before (D28 unchanged).

const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: the signer's replay store relies on POSIX file modes.
const TOKEN = "e".repeat(64);
const signer = generateKeyPairSync("ed25519");
let server: SignerServer | undefined;
let dir = "";

afterEach(async () => {
  if (server) await new Promise<void>((ok) => server!.close(() => ok()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ h: Harness; url: string }> {
  const h = createHarness({ verifierPublicKey: signer.publicKey, verificationAdvisory: false });
  dir = mkdtempSync(join(tmpdir(), "loopback-e2e-"));
  chmodSync(dir, 0o700);
  server = createSignerServer({
    clientToken: TOKEN,
    policy: {
      issuerPublicKey: TEST_ISSUER_KEYS.publicKey, signingKey: signer.privateKey, allowedRepository: REPO, now: () => h.clock.now,
      livePull: async (_repo, n) => { const p = await h.gh.getPull(n); return { state: p.state === "open" ? "open" : "closed", headSha: p.headSha }; },
      replay: new FileReplayStore(dir),
    },
    log: () => undefined, maxPerMinute: 100,
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
  h.gh.setPull(42);
  h.gh.pass(A);
  await h.poller.tick();
  return { h, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sign` };
}

const reportFor = (h: Harness, over: Record<string, unknown> = {}) => ({
  type: "verifier", runId: h.lastRunId(), caseId: "LB-001", repository: REPO, pullRequest: 42, headSha: getCase(h.db, "LB-001")!.headSha,
  verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "checked in the runner", ...over,
});

async function requestSignature(url: string, capability: string, report: Record<string, unknown>, token = TOKEN) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ capability, report, reportDigest: reportDigest(report) }),
  });
  return { status: res.status, body: await res.json() as { signature?: string; error?: string } };
}
const block = (r: Record<string, unknown>) => "Summary.\n```loopback-report\n" + JSON.stringify(r) + "\n```";

describe.skipIf(ON_WINDOWS)("D29 end to end: gate capability -> signer -> gate", () => {
  it("a report signed by the signer under the gate's capability advances the case (isolated mode)", async () => {
    const { h, url } = await setup();
    const report = reportFor(h);
    const r = await requestSignature(url, h.lastCapability(), report);
    expect(r.status).toBe(200);
    await h.say(VERIFIER, block({ ...report, signature: r.body.signature }));
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
  });

  it("the signer refuses a report for another run than the gate's capability (no signature to forge with)", async () => {
    const { h, url } = await setup();
    const r = await requestSignature(url, h.lastCapability(), reportFor(h, { runId: "00000000-0000-4000-8000-000000000000" }));
    expect(r).toEqual({ status: 403, body: { error: "CONTEXT_MISMATCH" } });
  });

  it("after the head moves, the old capability can no longer be used (STALE_HEAD), and the gate issues a new one", async () => {
    const { h, url } = await setup();
    const oldCap = h.lastCapability();
    const oldReport = reportFor(h);
    h.gh.setPull(42, { headSha: B });
    expect(await requestSignature(url, oldCap, oldReport)).toEqual({ status: 409, body: { error: "STALE_HEAD" } });
    h.gh.pass(B);
    await h.poller.tick();
    expect(h.lastCapability()).not.toBe(oldCap);
    const fresh = reportFor(h);
    expect(fresh.headSha).toBe(B);
    expect((await requestSignature(url, h.lastCapability(), fresh)).status).toBe(200);
  });

  it("a second, contradicting report for the same run cannot be signed (one signature per run)", async () => {
    const { h, url } = await setup();
    expect((await requestSignature(url, h.lastCapability(), reportFor(h, { verdict: "fail" }))).status).toBe(200);
    expect(await requestSignature(url, h.lastCapability(), reportFor(h, { verdict: "pass" }))).toEqual({ status: 409, body: { error: "REPLAYED" } });
  });

  it("without the client token nothing is signed, even with a valid capability", async () => {
    const { h, url } = await setup();
    expect((await requestSignature(url, h.lastCapability(), reportFor(h), "0".repeat(64))).status).toBe(401);
  });

  it("the gate still re-checks independently: a signer-signed report whose run was superseded is not accepted", async () => {
    const { h, url } = await setup();
    const cap = h.lastCapability();
    const report = reportFor(h);
    const r = await requestSignature(url, cap, report);
    await h.say(MAINT, `${G} verify LB-001`); // supersedes the run the signature is for
    await h.say(VERIFIER, block({ ...report, signature: r.body.signature }));
    await h.poller.tick();
    expect(listRuns(h.db, "LB-001").map((x) => x.status)).toEqual(["superseded", "requested"]);
    expect(h.state()).toBe("Verifying");
    expect(h.posts.at(-1)).toMatch(/superseded/);
  });
});
