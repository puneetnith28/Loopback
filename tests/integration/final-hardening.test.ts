import { describe, expect, it } from "vitest";
import { isAllowedTransition } from "../../apps/switch-gate/src/cases/machine.js";
import { getCase, listRuns } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, B, G, MAINT, REP, createHarness, type Harness } from "../helpers/harness.js";

const BASE_SHA_LINE = /Compare against base ([0-9a-f]{40})/;
const MINUTE = 60_000;

async function verifying(opts: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = createHarness(opts);
  await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
  h.gh.setPull(42);
  h.gh.pass(A);
  await h.poller.tick();
  return h;
}

async function timedOut(): Promise<Harness> {
  const h = await verifying();
  h.clock.now = new Date(h.clock.now.getTime() + 11 * MINUTE);
  await h.wf.sweep();
  expect(h.state()).toBe("VerificationFailed");
  return h;
}

const audits = (h: Harness, type: string) =>
  (h.db.prepare("SELECT reason_code AS reason, payload_json AS p FROM audit_events WHERE event_type = ? ORDER BY id").all(type) as { reason: string | null; p: string }[]);

describe("D33: retrying a timed-out verification without a new commit", () => {
  it("the state machine allows the retry only as an explicit command", () => {
    expect(isAllowedTransition("VerificationFailed", "Verifying", null, "command")).toBe(true);
    for (const trigger of ["system", "poller", "sweep", "agent_report", "reconcile", "maintainer_merge"] as const) {
      expect(isAllowedTransition("VerificationFailed", "Verifying", null, trigger), trigger).toBe(false);
    }
  });

  it("a maintainer's verify starts a fresh run with a new capability on the same commit", async () => {
    const h = await timedOut();
    const oldRun = h.lastRunId();
    const oldCapability = h.lastCapability();
    await h.say(MAINT, `${G} verify LB-001`);
    expect(h.state()).toBe("Verifying");
    expect(getCase(h.db, "LB-001")!.headSha).toBe(A);
    expect(h.lastRunId()).not.toBe(oldRun);
    expect(h.lastCapability()).not.toBe(oldCapability);
    expect(listRuns(h.db, "LB-001").map((r) => r.status).sort()).toEqual(["requested", "timeout"]);
    await h.verifierReply("pass");
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
  });

  it("a late report for the timed-out run cannot complete the new run", async () => {
    const h = await timedOut();
    const oldRun = h.lastRunId();
    await h.say(MAINT, `${G} verify LB-001`);
    await h.verifierReply("pass", { runId: oldRun });
    await h.poller.tick();
    expect(h.state()).toBe("Verifying");
  });

  it("an announced timeout tells the maintainer about the retry", async () => {
    const h = await timedOut();
    expect(h.posts.join("\n")).toMatch(new RegExp(`${G} verify LB-001`));
  });

  it("a CI failure still needs a retask, even if the open run later times out", async () => {
    const h = await verifying();
    h.gh.pass(A, "failure", 101);
    await h.poller.tick();
    expect(h.state()).toBe("VerificationFailed");
    h.clock.now = new Date(h.clock.now.getTime() + 11 * MINUTE);
    await h.wf.sweep();
    expect(listRuns(h.db, "LB-001").at(-1)?.status).toBe("timeout");
    const runs = listRuns(h.db, "LB-001").length;
    await h.say(MAINT, `${G} verify LB-001`);
    expect(h.state()).toBe("VerificationFailed");
    expect(listRuns(h.db, "LB-001")).toHaveLength(runs);
    expect(audits(h, "command.refused").at(-1)).toMatchObject({ reason: "INVALID_STATE" });
  });

  it("a failed verdict still needs a retask: verify is refused", async () => {
    const h = await verifying();
    await h.verifierReply("fail");
    await h.poller.tick();
    expect(h.state()).toBe("VerificationFailed");
    const runs = listRuns(h.db, "LB-001").length;
    await h.say(MAINT, `${G} verify LB-001`);
    expect(h.state()).toBe("VerificationFailed");
    expect(listRuns(h.db, "LB-001")).toHaveLength(runs);
    expect(audits(h, "command.refused").at(-1)).toMatchObject({ reason: "INVALID_STATE" });
  });

  it("a timed-out run whose PR head has moved needs a retask: verify is refused", async () => {
    const h = await timedOut();
    const runs = listRuns(h.db, "LB-001").length;
    h.gh.setPull(42, { headSha: B });
    await h.say(MAINT, `${G} verify LB-001`);
    expect(h.state()).toBe("VerificationFailed");
    expect(listRuns(h.db, "LB-001")).toHaveLength(runs);
    expect(audits(h, "command.refused").at(-1)).toMatchObject({ reason: "HEAD_MOVED" });
  });

  it("someone who is not a maintainer cannot retry", async () => {
    const h = await timedOut();
    const runs = listRuns(h.db, "LB-001").length;
    await h.say(REP, `${G} verify LB-001`);
    expect(h.state()).toBe("VerificationFailed");
    expect(listRuns(h.db, "LB-001")).toHaveLength(runs);
  });

  it("the retry stays off while privileged commands are disabled", async () => {
    const h = createHarness({ privilegedEnabled: false });
    await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
    h.gh.setPull(42);
    h.gh.pass(A);
    await h.poller.tick();
    h.clock.now = new Date(h.clock.now.getTime() + 11 * MINUTE);
    await h.wf.sweep();
    await h.say(MAINT, `${G} verify LB-001`);
    expect(h.state()).toBe("VerificationFailed");
  });
});

describe("the gate applies the signer's rule for a pass, even with no signer in the loop", () => {
  it.each([
    ["the regression test never failed before the fix", { regressionTestFailsBeforeFix: false }],
    ["it reports a high-severity finding", { findings: [{ severity: "high", message: "breaks something" }] }],
  ])("a pass where %s is invalid, and cannot reach approval", async (_name, over) => {
    const h = await verifying({ verificationAdvisory: true, verifierPublicKey: null });
    await h.verifierReply("pass", { signature: undefined, ...over });
    await h.poller.tick();
    expect(h.state()).toBe("VerificationFailed");
    expect(listRuns(h.db, "LB-001").at(-1)?.status).toBe("invalid");
    expect(audits(h, "verification.passed")).toEqual([]);
  });

  it("a consistent pass still reaches approval", async () => {
    const h = await verifying({ verificationAdvisory: true, verifierPublicKey: null });
    await h.verifierReply("pass", { signature: undefined, findings: [{ severity: "low", message: "a nit" }] });
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
  });
});

describe("the verification request carries what the verifier needs", () => {
  it("names the PR's base commit as well as the head", async () => {
    const h = await verifying();
    const request = [...h.posts].reverse().find((p) => /Run id:/.test(p))!;
    const base = BASE_SHA_LINE.exec(request)?.[1];
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(base).not.toBe(A);
  });
});

describe("a run with no report yet reminds the operator once", () => {
  it("posts one reminder after five minutes, naming the likely cause, and never again", async () => {
    const h = await verifying();
    h.clock.now = new Date(h.clock.now.getTime() + 4 * MINUTE);
    await h.wf.sweep();
    expect(h.posts.join("\n")).not.toMatch(/permission prompt/);
    h.clock.now = new Date(h.clock.now.getTime() + 2 * MINUTE);
    await h.wf.sweep();
    const reminders = () => h.posts.filter((p) => /permission prompt/.test(p));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatch(/LB-001/);
    h.clock.now = new Date(h.clock.now.getTime() + MINUTE);
    await h.wf.sweep();
    expect(reminders()).toHaveLength(1);
    expect(h.state()).toBe("Verifying");
  });

  it("stays silent when the report arrived in time", async () => {
    const h = await verifying();
    await h.verifierReply("pass");
    await h.poller.tick();
    h.clock.now = new Date(h.clock.now.getTime() + 6 * MINUTE);
    await h.wf.sweep();
    expect(h.posts.join("\n")).not.toMatch(/permission prompt/);
  });
});
