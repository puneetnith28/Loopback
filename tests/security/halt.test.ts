import { describe, expect, it } from "vitest";
import { listRecent } from "../../apps/switch-gate/src/audit/index.js";
import { HaltSwitch, HaltedError } from "../../apps/switch-gate/src/cases/halt.js";
import { transition } from "../../apps/switch-gate/src/cases/service.js";
import { getCase, listApprovals, listMergeOps } from "../../apps/switch-gate/src/persistence/repos.js";
import { GitHubError } from "../../apps/switch-gate/src/github/client.js";
import { A, B, BASE, G, MAINT, createHarness, type Harness } from "../helpers/harness.js";

// Halting privileged work after a Switch policy failure (security review M2).
// Each test parks one GitHub call on a promise, halts the gate while the operation is
// waiting, releases the call, and asserts that nothing privileged was written after it.

function gate() {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const opened = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { entered = r; });
  return { release: () => release(), reached, async wait() { entered(); await opened; } };
}

/**
 * Park the `nth` call (1-based) of `method` on the fake GitHub until released. With
 * `fail`, the parked call then throws a GitHub error instead of answering.
 */
function park(h: Harness, method: "snapshot" | "getPull" | "setGateStatus" | "getBranchHead", nth = 1, fail = false) {
  const g = gate();
  const target = h.gh as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = target[method]!.bind(h.gh);
  let calls = 0;
  target[method] = async (...args: unknown[]) => {
    calls += 1;
    if (calls === nth) {
      await g.wait();
      if (fail) throw new GitHubError("unavailable", 503);
    }
    return original(...args);
  };
  return g;
}

/** Run a merge, halt while the parked call waits, release it, and wait for the command. */
async function haltDuringMerge(h: Harness, g: ReturnType<typeof park>, beforeRelease: () => void = () => undefined) {
  const pending = h.say(MAINT, `${G} merge LB-001`);
  await g.reached;
  h.halt.halt("policy mismatch");
  beforeRelease();
  g.release();
  await pending;
}

const auditTypes = (h: Harness) => listRecent(h.db, "LB-001", 200).map((r) => r.type);
const haltedRefusals = (h: Harness) =>
  (h.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'command.refused' AND reason_code = 'GATE_HALTED'").get() as { n: number }).n;

describe("HaltSwitch", () => {
  it("is one-way, keeps the first reason, and throws HaltedError once halted", () => {
    const s = new HaltSwitch();
    expect(() => s.assertRunning("merge")).not.toThrow();
    s.halt("policy widened");
    s.halt("second reason");
    expect(s.halted).toBe(true);
    expect(s.reason).toBe("policy widened");
    expect(() => s.assertRunning("merge")).toThrow(HaltedError);
  });
});

describe("merge stops at its next write boundary after a halt", () => {
  it("halted before the command runs: refused at entry, nothing written", async () => {
    const h = createHarness();
    await h.driveToReady();
    h.halt.halt("policy mismatch");
    await h.say(MAINT, `${G} merge LB-001`);
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state()).toBe("ReadyToMerge");
    expect(auditTypes(h)).not.toContain("merge.requested");
    expect(haltedRefusals(h)).toBe(1);
  });

  it("halted while waiting on revalidation: no gate status, no merge attempt, no merge", async () => {
    const h = createHarness();
    await h.driveToReady();
    const g = park(h, "snapshot");
    const pending = h.say(MAINT, `${G} merge LB-001`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.gh.statuses).toEqual([]);
    expect(listMergeOps(h.db, "LB-001", A)).toEqual([]);
    expect(h.state()).toBe("Revalidating"); // left as a crash would leave it; startup reconciliation recovers it
    expect(haltedRefusals(h)).toBe(1);
  });

  it("halted while the gate-status write is in flight: no merge, and no further writes", async () => {
    const h = createHarness();
    await h.driveToReady();
    const g = park(h, "setGateStatus");
    const pending = h.say(MAINT, `${G} merge LB-001`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state()).toBe("Revalidating");
    expect(auditTypes(h)).not.toContain("gate_status.corrected");
    expect(haltedRefusals(h)).toBe(1);
  });

  it("halted while re-reading the PR after the status: no transition to Merging, no merge", async () => {
    const h = createHarness();
    await h.driveToReady();
    // snapshot reads the PR twice; the third read is the post-status head check.
    const g = park(h, "getPull", 3);
    const pending = h.say(MAINT, `${G} merge LB-001`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state()).toBe("Revalidating");
    expect(listMergeOps(h.db, "LB-001", A).map((o) => o.status)).toEqual(["started"]);
    expect(h.gh.statuses.map((s) => s.state)).toEqual(["success"]); // posted before the halt; startup reconciliation resets it (D9)
    expect(haltedRefusals(h)).toBe(1);
  });

  it("halted while revalidation fails: the failure is not settled (no Blocked write)", async () => {
    const h = createHarness();
    await h.driveToReady();
    await haltDuringMerge(h, park(h, "snapshot", 1, true));
    expect(h.state()).toBe("Revalidating");
    expect(h.merger).not.toHaveBeenCalled();
    expect(haltedRefusals(h)).toBe(1);
  });

  it("halted while the gate-status write fails: no correction and no settle", async () => {
    const h = createHarness();
    await h.driveToReady();
    await haltDuringMerge(h, park(h, "setGateStatus", 1, true));
    expect(h.state()).toBe("Revalidating");
    expect(listMergeOps(h.db, "LB-001", A).map((o) => o.status)).toEqual(["started"]);
    expect(h.gh.statuses).toEqual([]);
    expect(auditTypes(h)).not.toContain("gate_status.corrected");
    expect(haltedRefusals(h)).toBe(1);
  });

  it("halted while the head moves during the post-status read: no correction, no Stale write", async () => {
    const h = createHarness();
    await h.driveToReady();
    await haltDuringMerge(h, park(h, "getPull", 3), () => h.gh.setPull(42, { headSha: B }));
    expect(h.state()).toBe("Revalidating");
    expect(listMergeOps(h.db, "LB-001", A).map((o) => o.status)).toEqual(["started"]);
    expect(h.gh.statuses.map((s) => s.state)).toEqual(["success"]);
    expect(h.merger).not.toHaveBeenCalled();
    expect(haltedRefusals(h)).toBe(1);
  });

  it("a halted merge is recovered by startup reconciliation like a crash: status reset, case blocked, never merged", async () => {
    const h = createHarness();
    await h.driveToReady();
    const g = park(h, "getPull", 3);
    const pending = h.say(MAINT, `${G} merge LB-001`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    await h.exec.reconcileStartup();
    expect(h.state()).toBe("Blocked");
    expect(h.gh.statuses.map((s) => s.state)).toEqual(["success", "failure"]);
    expect(listMergeOps(h.db, "LB-001", A).map((o) => o.status)).toEqual(["failed"]);
    expect(h.merger).not.toHaveBeenCalled();
  });

  it("without a halt the same merge goes through (graceful behaviour unchanged)", async () => {
    const h = createHarness();
    await h.driveToReady();
    await h.say(MAINT, `${G} merge LB-001`);
    expect(h.merger).toHaveBeenCalledTimes(1);
    expect(h.state()).toBe("Merged");
    expect(haltedRefusals(h)).toBe(0);
  });
});

describe("decisions and retasks stop before their state writes after a halt", () => {
  it("an approval waiting on the live PR read records nothing", async () => {
    const h = createHarness();
    await h.driveToAwaitingApproval();
    const g = park(h, "getPull");
    const pending = h.say(MAINT, `${G} approve LB-001 ${A}`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    expect(listApprovals(h.db, "LB-001")).toEqual([]);
    expect(h.state()).toBe("AwaitingApproval");
    expect(auditTypes(h)).not.toContain("approval.accepted");
    expect(haltedRefusals(h)).toBe(1);
  });

  it("a rejection waiting on the live PR read records nothing", async () => {
    const h = createHarness();
    await h.driveToAwaitingApproval();
    const g = park(h, "getPull");
    const pending = h.say(MAINT, `${G} reject LB-001 not this one`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    expect(listApprovals(h.db, "LB-001")).toEqual([]);
    expect(auditTypes(h)).not.toContain("approval.rejected");
    expect(haltedRefusals(h)).toBe(1);
  });

  it("a retask waiting on the base-branch check writes no transition and tasks nobody", async () => {
    const h = createHarness({ expectedBase: BASE });
    await h.driveToAwaitingApproval();
    transition(h.db, { caseId: "LB-001", to: "Blocked", actorId: "system", trigger: "system", reason: "PR_CLOSED" }, h.clock.now);
    const posted = h.posts.length;
    const g = park(h, "getBranchHead");
    const pending = h.say(MAINT, `${G} retask LB-001 try a smaller fix`);
    await g.reached;
    h.halt.halt("policy mismatch");
    g.release();
    await pending;
    expect(getCase(h.db, "LB-001")?.state).toBe("Blocked");
    expect(auditTypes(h)).not.toContain("case.retasked");
    expect(h.posts.slice(posted)).toEqual([]);
    expect(haltedRefusals(h)).toBe(1);
  });

  it("a verify command after a halt requests no verification", async () => {
    const h = createHarness();
    await h.driveToAwaitingApproval();
    const runs = () => (h.db.prepare("SELECT count(*) AS n FROM verification_runs").get() as { n: number }).n;
    const before = runs();
    const posted = h.posts.length;
    h.halt.halt("policy mismatch");
    await h.say(MAINT, `${G} verify LB-001`);
    expect(runs()).toBe(before);
    expect(h.posts.slice(posted)).toEqual([]);
    expect(h.state()).toBe("AwaitingApproval");
    expect(haltedRefusals(h)).toBe(1);
  });

  it("a halted command is marked processed, so it is not re-run on redelivery", async () => {
    const h = createHarness();
    await h.driveToReady();
    h.halt.halt("policy mismatch");
    const count = () => (h.db.prepare("SELECT count(*) AS n FROM processed_events").get() as { n: number }).n;
    const before = count();
    await h.say(MAINT, `${G} merge LB-001`);
    expect(count()).toBe(before + 1);
  });
});
