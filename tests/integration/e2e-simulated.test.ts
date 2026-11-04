import { describe, expect, it } from "vitest";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, B, G, IROOM, MAINT, MROOM, createHarness, type Harness } from "../helpers/harness.js";

// Simulated end-to-end runs of the whole public path through the real router, workflow,
// poller and merge executor. GitHub is the scripted FakeGitHub, Switch is the harness chat,
// and the verifier report is signed with the test key (isolated mode). This shows the modules
// work together; it is NOT evidence of live GitHub or Switch integration.

const PUBLIC = "@switch-mattermost-x-stranger:localhost";
const types = (h: Harness) => (h.db.prepare("SELECT event_type AS t FROM audit_events WHERE case_id = 'LB-001' ORDER BY id").all() as { t: string }[]).map((r) => r.t);

async function toReadyToMerge(h: Harness): Promise<void> {
  await h.say(PUBLIC, `${G} report slugify.extend({'%': null}) throws a TypeError`, { roomId: IROOM });
  expect(h.state()).toBe("Reported");
  await h.say(MAINT, `${G} accept LB-001`);
  expect(h.state()).toBe("FixInProgress");
  h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
  h.gh.pass(A);
  await h.poller.tick(); // PR discovered -> Verifying, verifier asked for exactly A
  expect(h.state()).toBe("Verifying");
  await h.verifierReply("pass"); // signed with the test verifier key
  await h.poller.tick(); // CI for A -> AwaitingApproval
  expect(h.state()).toBe("AwaitingApproval");
  await h.say(MAINT, `${G} approve LB-001 ${A}`);
  expect(h.state()).toBe("ReadyToMerge");
}

describe("simulated end-to-end: public report to gated merge", () => {
  it("merges exactly the approved, verified, CI-green commit once, with a complete audit trail", async () => {
    const h = createHarness();
    await toReadyToMerge(h);
    await h.say(MAINT, `${G} merge LB-001`);
    expect(h.state()).toBe("Merged");
    expect(h.merger).toHaveBeenCalledTimes(1);
    expect(h.merger).toHaveBeenCalledWith(42, A);
    expect(h.gh.statuses).toEqual([expect.objectContaining({ sha: A, state: "success" })]);
    const trail = types(h);
    for (const t of ["case.created", "case.triaged", "fixer.started", "pr.created", "verification.started", "verification.passed", "merge.requested", "gate_status.posted", "merge.confirmed"]) {
      expect(trail, t).toContain(t);
    }
    expect(trail.indexOf("verification.passed")).toBeLessThan(trail.indexOf("merge.requested"));
    expect(h.roomPosts.filter((p) => p.room === IROOM).every((p) => !/approve|merge/i.test(p.content))).toBe(true);
    expect(h.roomPosts.some((p) => p.room === MROOM && /MERGED: GitHub confirmed/.test(p.content))).toBe(true);
  });

  it("a commit pushed after approval stops the merge, re-verifies the new head, and never merges", async () => {
    const h = createHarness();
    await toReadyToMerge(h);
    h.gh.setPull(42, { headSha: B });
    await h.say(MAINT, `${G} merge LB-001`);
    expect(h.merger).not.toHaveBeenCalled();
    expect(getCase(h.db, "LB-001")).toMatchObject({ headSha: B });
    expect(["Verifying", "Stale"]).toContain(h.state());
    expect(h.posts.some((p) => p.includes(`head ${B}`))).toBe(true); // the verifier is asked about B
  });

  it("with privileged commands disabled (the default for a live gate), nothing can be approved or merged", async () => {
    const h = createHarness({ privilegedEnabled: false });
    await h.say(PUBLIC, `${G} report slugify.extend({'%': null}) throws a TypeError`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`); // triage is not privileged
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    await h.verifierReply("pass");
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
    await h.say(MAINT, `${G} approve LB-001 ${A}`);
    await h.say(MAINT, `${G} merge LB-001`);
    expect(h.posts.slice(-2).every((p) => /PRIVILEGED_DISABLED/.test(p))).toBe(true);
    expect(h.state()).toBe("AwaitingApproval");
    expect(h.merger).not.toHaveBeenCalled();
  });

  it("with merging disabled, an approved case is refused at merge and stays ready", async () => {
    const h = createHarness({ mergeEnabled: false });
    await toReadyToMerge(h);
    await h.say(MAINT, `${G} merge LB-001`);
    expect(h.posts.at(-1)).toMatch(/MERGE_DISABLED/);
    expect(h.state()).toBe("ReadyToMerge");
    expect(h.merger).not.toHaveBeenCalled();
  });

  it("advisory verification still needs the maintainer's exact-SHA approval; it never authorizes a merge on its own", async () => {
    const h = createHarness({ verificationAdvisory: true, verifierPublicKey: null });
    await h.say(PUBLIC, `${G} report slugify.extend({'%': null}) throws a TypeError`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`);
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    await h.verifierReply("pass", { signature: undefined });
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
    expect(h.posts.at(-1)).toMatch(/advisory/i);
    await h.say(MAINT, `${G} merge LB-001`); // no approval yet
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state()).toBe("AwaitingApproval");
  });
});
