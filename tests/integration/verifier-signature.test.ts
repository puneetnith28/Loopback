import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signReport } from "../../apps/switch-gate/src/agents/signature.js";
import { completeRun, getCase, latestRunForHead, listExpiredRuns, listRuns } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, B, FIXER, G, MAINT, REP, REPO, TEST_VERIFIER_KEYS, VERIFIER, createHarness, signTestReport, type Harness } from "../helpers/harness.js";

// D28: signed verifier evidence and explicit superseding of runs. A valid signature proves
// possession of the verifier key and report integrity; these tests do not (and cannot)
// show that the verifier executed anything.

const audits = (h: Harness, type: string) =>
  (h.db.prepare("SELECT reason_code AS reason, target_sha AS sha, payload_json AS p FROM audit_events WHERE event_type = ? ORDER BY id").all(type) as { reason: string | null; sha: string | null; p: string }[])
    .map((r) => ({ reason: r.reason, sha: r.sha, payload: JSON.parse(r.p) as Record<string, unknown> }));

async function verifying(opts: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = createHarness(opts);
  await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
  h.gh.setPull(42);
  h.gh.pass(A);
  await h.poller.tick(); // -> Verifying, run issued for A
  return h;
}

const reportFor = (h: Harness, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "verifier", runId: h.lastRunId(), caseId: "LB-001", repository: REPO, pullRequest: 42, headSha: getCase(h.db, "LB-001")!.headSha,
  verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "checked", ...over,
});
const block = (r: Record<string, unknown>) => "Summary.\n```loopback-report\n" + JSON.stringify(r) + "\n```";
const runStatus = (h: Harness) => listRuns(h.db, "LB-001").map((r) => r.status);

describe("isolated mode: signatures are required and checked before anything is recorded", () => {
  it("a valid signed report advances to AwaitingApproval, labelled isolated, with the signature audited", async () => {
    const h = await verifying();
    await h.verifierReply("pass");
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
    expect(audits(h, "verification.passed")[0]!.payload).toMatchObject({ signature: "valid", advisory: false });
    expect(h.posts.at(-1)).not.toMatch(/advisory/i);
  });

  it.each([
    ["missing", (h: Harness) => reportFor(h), "absent"],
    ["made with another key", (h: Harness) => ({ ...reportFor(h), signature: signReport(reportFor(h), generateKeyPairSync("ed25519").privateKey) }), "invalid"],
    ["malformed", (h: Harness) => ({ ...reportFor(h), signature: "not-base64!" }), "invalid"],
    ["valid but for an altered verdict", (h: Harness) => ({ ...signTestReport(reportFor(h, { verdict: "fail" })), verdict: "pass" }), "invalid"],
    ["valid but for another run id", (h: Harness) => ({ ...signTestReport(reportFor(h, { runId: "00000000-0000-4000-8000-000000000000" })), runId: h.lastRunId() }), "invalid"],
  ])("rejects a report whose signature is %s: the run stays open and nothing passes", async (_n, make, status) => {
    const h = await verifying();
    await h.say(VERIFIER, block(make(h)));
    await h.poller.tick();
    expect(runStatus(h)).toEqual(["requested"]);
    expect(h.state()).toBe("Verifying");
    expect(audits(h, "verification.passed")).toEqual([]);
    expect(audits(h, "agent_output.invalid").at(-1)).toMatchObject({ reason: "VERIFIER_SIGNATURE_INVALID", payload: { signature: status } });
    expect(h.posts.at(-1)).toMatch(/VERIFIER_SIGNATURE_INVALID/);
    // A correctly signed report for the same run still completes it afterwards.
    await h.verifierReply("pass");
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
  });

  it("fails closed when no public key is configured: every report is rejected", async () => {
    const h = await verifying({ verifierPublicKey: null });
    await h.verifierReply("pass");
    expect(runStatus(h)).toEqual(["requested"]);
    expect(audits(h, "agent_output.invalid").at(-1)).toMatchObject({ reason: "VERIFIER_SIGNATURE_INVALID", payload: { signature: "unverified" } });
  });

  it("a validly signed report sent from the fixer's (or a maintainer's) identity is not verification", async () => {
    const h = await verifying();
    await h.say(FIXER, block(signTestReport(reportFor(h))));
    await h.say(MAINT, block(signTestReport(reportFor(h))));
    await h.poller.tick();
    expect(runStatus(h)).toEqual(["requested"]);
    expect(audits(h, "verification.passed")).toEqual([]);
    expect(h.state()).toBe("Verifying");
  });

  it.each([
    ["SHA", { headSha: B }],
    ["repository", { repository: "o/other" }],
    ["PR", { pullRequest: 43 }],
  ])("a correctly signed report naming the wrong %s invalidates the run (never a pass)", async (_n, over) => {
    const h = await verifying();
    await h.verifierReply("pass", over);
    expect(runStatus(h)).toEqual(["invalid"]);
    expect(audits(h, "verification.passed")).toEqual([]);
    expect(audits(h, "agent_output.invalid").at(-1)!.payload).toMatchObject({ signature: "valid" });
  });

  it("a replayed signed report changes nothing once its run is complete", async () => {
    const h = await verifying();
    const signed = signTestReport(reportFor(h));
    await h.say(VERIFIER, block(signed));
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
    await h.say(VERIFIER, block(signed));
    expect(audits(h, "verification.passed")).toHaveLength(1);
    expect(h.posts.at(-1)).toMatch(/already completed/);
  });
});

describe("superseded runs (D28)", () => {
  it("a new request supersedes older open runs, audited", async () => {
    const h = await verifying();
    const first = h.lastRunId();
    await h.say(MAINT, `${G} verify LB-001`); // forced re-request for the same head
    const second = h.lastRunId();
    expect(second).not.toBe(first);
    expect(listRuns(h.db, "LB-001").map((r) => [r.id, r.status])).toEqual([[first, "superseded"], [second, "requested"]]);
    expect(audits(h, "verification.superseded")[0]!.payload).toEqual({ runIds: [first], by: second });
  });

  it("a report for a superseded run can never pass, even validly signed for the live head", async () => {
    const h = await verifying();
    const old = signTestReport(reportFor(h));
    await h.say(MAINT, `${G} verify LB-001`);
    await h.say(VERIFIER, block(old));
    await h.poller.tick();
    expect(runStatus(h)).toEqual(["superseded", "requested"]);
    expect(h.posts.at(-1)).toMatch(/superseded/);
    expect(audits(h, "verification.passed")).toEqual([]);
    expect(h.state()).toBe("Verifying");
  });

  it("a head change supersedes the old head's run; its late report cannot pass", async () => {
    const h = await verifying();
    const oldReport = signTestReport(reportFor(h)); // for A
    h.gh.setPull(42, { headSha: B });
    h.gh.pass(B);
    await h.poller.tick(); // -> Stale -> Verifying, new run for B
    expect(listRuns(h.db, "LB-001").map((r) => [r.headSha, r.status])).toEqual([[A, "superseded"], [B, "requested"]]);
    await h.say(VERIFIER, block(oldReport));
    await h.poller.tick();
    expect(audits(h, "verification.passed")).toEqual([]);
    expect(h.state()).toBe("Verifying");
    expect(getCase(h.db, "LB-001")!.headSha).toBe(B);
  });

  it("a superseded run cannot be completed by any path", async () => {
    const h = await verifying();
    const first = h.lastRunId();
    await h.say(MAINT, `${G} verify LB-001`);
    for (const status of ["pass", "fail", "invalid", "timeout"] as const) {
      expect(completeRun(h.db, first, status, null, h.clock.now)).toBe(false);
    }
    expect(listRuns(h.db, "LB-001")[0]!.status).toBe("superseded");
  });

  it("the timeout sweep and the poller ignore superseded runs", async () => {
    const h = await verifying();
    const first = h.lastRunId();
    await h.say(MAINT, `${G} verify LB-001`);
    await h.verifierReply("pass"); // completes the open run
    h.clock.now = new Date(h.clock.now.getTime() + 600_001);
    expect(listExpiredRuns(h.db, h.clock.now).map((r) => r.id)).not.toContain(first);
    await h.wf.sweep();
    await h.poller.tick();
    expect(listRuns(h.db, "LB-001").map((r) => r.status)).toEqual(["superseded", "pass"]);
    expect(audits(h, "verification.failed")).toEqual([]);
    expect(h.state()).toBe("AwaitingApproval");
  });

  it("head-change interleavings never leave a pass standing for a non-live head", async () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const h = await verifying();
      const signedForA = signTestReport(reportFor(h));
      const moveFirst = seed % 2 === 0;
      const steps = [
        () => { h.gh.setPull(42, { headSha: B }); h.gh.pass(B); return Promise.resolve(); },
        () => h.say(VERIFIER, block(signedForA)),
        () => h.poller.tick(),
      ];
      const order = moveFirst ? [0, 1, 2] : seed % 3 === 0 ? [1, 0, 2] : [2, 0, 1];
      await Promise.all(order.map(async (i, k) => {
        for (let y = 0; y < (seed + k) % 4; y += 1) await Promise.resolve();
        await steps[i]!();
      }));
      await h.poller.tick();
      await h.poller.tick();
      const c = getCase(h.db, "LB-001")!;
      expect(h.gh.pulls.get(42)!.headSha, `seed ${seed}`).toBe(B);
      // Approval-bearing states require a pass for the live head, which nobody produced.
      expect(c.state === "AwaitingApproval" || c.state === "ReadyToMerge", `seed ${seed}`).toBe(false);
      expect(latestRunForHead(h.db, "LB-001", B)?.status ?? "none", `seed ${seed}`).not.toBe("pass");
      if (moveFirst) expect(audits(h, "verification.passed"), `seed ${seed}`).toEqual([]);
    }
  });
});

describe("advisory mode (VERIFIER_ISOLATION_PROVEN=false)", () => {
  it("accepts an unsigned report exactly as before, labelled advisory", async () => {
    const h = await verifying({ verificationAdvisory: true, verifierPublicKey: null });
    await h.verifierReply("pass", { signature: undefined });
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
    expect(h.posts.at(-1)).toMatch(/advisory/i);
    expect(audits(h, "verification.passed")[0]!.payload).toMatchObject({ advisory: true, signature: "absent" });
  });

  it("with a key configured (D32): unsigned is rejected, a valid signature is recorded, a bad one is rejected", async () => {
    const unsigned = await verifying({ verificationAdvisory: true });
    await unsigned.verifierReply("pass", { signature: undefined });
    expect(runStatus(unsigned)).toEqual(["requested"]);
    expect(unsigned.state()).toBe("Verifying");
    expect(audits(unsigned, "verification.passed")).toEqual([]);
    expect(audits(unsigned, "agent_output.invalid").at(-1)).toMatchObject({ reason: "VERIFIER_SIGNATURE_INVALID", payload: { signature: "absent" } });

    const valid = await verifying({ verificationAdvisory: true });
    await valid.verifierReply("pass");
    expect(audits(valid, "verification.passed")[0]!.payload).toMatchObject({ signature: "valid", advisory: true });

    const bad = await verifying({ verificationAdvisory: true });
    await bad.say(VERIFIER, block({ ...reportFor(bad), signature: signReport(reportFor(bad), generateKeyPairSync("ed25519").privateKey) }));
    expect(runStatus(bad)).toEqual(["requested"]);
    expect(audits(bad, "agent_output.invalid").at(-1)).toMatchObject({ reason: "VERIFIER_SIGNATURE_INVALID" });
  });

  it("without a key, a signature is recorded as unverified, never as valid", async () => {
    const h = await verifying({ verificationAdvisory: true, verifierPublicKey: null });
    await h.verifierReply("pass");
    expect(audits(h, "verification.passed")[0]!.payload).toMatchObject({ signature: "unverified", advisory: true });
  });

  it("the harness test key is Ed25519", () => {
    expect(TEST_VERIFIER_KEYS.publicKey.asymmetricKeyType).toBe("ed25519");
  });
});
