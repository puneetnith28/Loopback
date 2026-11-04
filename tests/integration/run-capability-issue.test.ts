import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCapability } from "../../apps/switch-gate/src/agents/capability.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, B, G, MAINT, REP, REPO, TEST_ISSUER_KEYS, createHarness, type Harness } from "../helpers/harness.js";

// D29: every verification request carries a gate-signed capability for exactly that run, so the
// verifier signer can sign only reports for runs the gate issued.

async function verifying(opts: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = createHarness(opts);
  await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
  h.gh.setPull(42);
  h.gh.pass(A);
  await h.poller.tick();
  return h;
}

describe("verification requests carry a run capability", () => {
  it("binds the capability to the issued run, case, repository, PR and head, expiring with the run", async () => {
    const h = await verifying();
    const token = h.lastCapability();
    const r = verifyCapability(token, TEST_ISSUER_KEYS.publicKey, h.clock.now);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.capability).toMatchObject({ runId: h.lastRunId(), caseId: "LB-001", repository: REPO, pullRequest: 42, headSha: getCase(h.db, "LB-001")!.headSha });
    expect(Date.parse(r.capability.expiresAt) - Date.parse(r.capability.issuedAt)).toBe(600_000); // the run's timeout
  });

  it("a forced re-run gets a new capability for the new run; the old one names the superseded run", async () => {
    const h = await verifying();
    const first = h.lastCapability();
    const firstRun = h.lastRunId();
    await h.say(MAINT, `${G} verify LB-001`);
    expect(h.lastRunId()).not.toBe(firstRun);
    expect(h.lastCapability()).not.toBe(first);
    const old = verifyCapability(first, TEST_ISSUER_KEYS.publicKey, h.clock.now);
    expect(old.ok && old.capability.runId).toBe(firstRun);
  });

  it("a new head gets a capability for the new head", async () => {
    const h = await verifying();
    h.gh.setPull(42, { headSha: B });
    h.gh.pass(B);
    await h.poller.tick();
    const r = verifyCapability(h.lastCapability(), TEST_ISSUER_KEYS.publicKey, h.clock.now);
    expect(r.ok && r.capability.headSha).toBe(B);
  });

  it("is not verifiable with any other key", async () => {
    const h = await verifying();
    expect(verifyCapability(h.lastCapability(), generateKeyPairSync("ed25519").publicKey, h.clock.now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("without a run-issuer key (advisory mode) no capability is posted", async () => {
    const h = await verifying({ runIssuerKey: null, verificationAdvisory: true });
    expect(h.posts.join("\n")).not.toMatch(/lbcap1\./);
  });
});
