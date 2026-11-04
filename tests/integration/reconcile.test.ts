import { CASE_STATES, type CaseState } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { createCase } from "../../apps/switch-gate/src/cases/service.js";
import { A, B, createHarness, type Harness } from "../helpers/harness.js";

// Step 8.9: startup (and post-gap) reconciliation from every case state against what
// GitHub says now. The order mirrors Gate.start(): interrupted merges first
// (reconcileStartup), then open cases (poller tick) and unknown outcomes (reconcileUnknown).
// Invariants: reconciliation never merges, never tasks the fixer for an untriaged public
// report, and never leaves an approval standing on a head that moved.

type Scenario = "same" | "moved" | "closed" | "merged";

function seed(state: CaseState, scenario: Scenario): Harness {
  const h = createHarness();
  createCase(h.db, { reporterId: "@r:x", roomId: "room", threadId: null, repo: "o/r", reportText: "a seeded bug report", sourceEventId: "seed" }, h.clock.now);
  const early = state === "Reported" || state === "Triaged" || state === "FixInProgress";
  // Test-only: place the case directly in the state under test.
  h.db.prepare("UPDATE cases SET state = ?, branch = 'loopback/LB-001', pr_number = ?, head_sha = ?, blocked_reason = ? WHERE id = 'LB-001'")
    .run(state, early ? null : 42, early ? null : A, state === "Blocked" ? "CI_FAILED" : null);
  h.gh.setPull(42, {
    headSha: scenario === "moved" ? B : A, headRef: "loopback/LB-001",
    state: scenario === "closed" || scenario === "merged" ? "closed" : "open",
    merged: scenario === "merged", mergeCommitSha: scenario === "merged" ? "e".repeat(40) : null,
  });
  h.gh.pass(A);
  h.gh.pass(B);
  return h;
}

async function reconcileAtStartup(h: Harness): Promise<void> {
  await h.exec.reconcileStartup();
  await h.poller.tick();
  await h.exec.reconcileUnknown();
}

// Expected state after reconciliation, per scenario, for every state.
const EXPECTED: Record<Scenario, Record<CaseState, CaseState>> = {
  same: {
    Reported: "Reported", Triaged: "Triaged", FixInProgress: "Verifying", PRCreated: "PRCreated", Verifying: "Verifying",
    VerificationFailed: "VerificationFailed", AwaitingApproval: "AwaitingApproval", ReadyToMerge: "ReadyToMerge",
    Revalidating: "Blocked", Merging: "Blocked", Merged: "Merged", Stale: "Verifying", Blocked: "Blocked", MergeUnknown: "Blocked",
  },
  moved: {
    Reported: "Reported", Triaged: "Triaged", FixInProgress: "Verifying", PRCreated: "Verifying", Verifying: "Verifying",
    VerificationFailed: "VerificationFailed", AwaitingApproval: "Verifying", ReadyToMerge: "Verifying",
    Revalidating: "Blocked", Merging: "Verifying", Merged: "Merged", Stale: "Verifying", Blocked: "Blocked", MergeUnknown: "Verifying",
  },
  closed: {
    Reported: "Reported", Triaged: "Triaged", FixInProgress: "FixInProgress", PRCreated: "Blocked", Verifying: "Blocked",
    VerificationFailed: "Blocked", AwaitingApproval: "Blocked", ReadyToMerge: "Blocked",
    Revalidating: "Blocked", Merging: "Blocked", Merged: "Merged", Stale: "Blocked", Blocked: "Blocked", MergeUnknown: "Blocked",
  },
  merged: {
    Reported: "Reported", Triaged: "Triaged", FixInProgress: "FixInProgress", PRCreated: "PRCreated", Verifying: "Verifying",
    VerificationFailed: "VerificationFailed", AwaitingApproval: "AwaitingApproval", ReadyToMerge: "ReadyToMerge",
    Revalidating: "Blocked", Merging: "Merged", Merged: "Merged", Stale: "Stale", Blocked: "Blocked", MergeUnknown: "Merged",
  },
};

const count = (h: Harness, type: string) =>
  (h.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = ?").get(type) as { n: number }).n;

describe("startup reconciliation from every state (step 8.9)", () => {
  const rows = (Object.keys(EXPECTED) as Scenario[]).flatMap((s) => CASE_STATES.map((st) => [s, st, EXPECTED[s][st]] as const));

  it("covers every state in every scenario", () => {
    expect(rows).toHaveLength(4 * CASE_STATES.length);
  });

  it.each(rows)("GitHub %s: %s -> %s, without merging, idempotently", async (scenario, state, expected) => {
    const h = seed(state, scenario);
    await reconcileAtStartup(h);
    expect(h.state()).toBe(expected);
    expect(h.merger).not.toHaveBeenCalled();

    // A second pass (the periodic task, or the next restart) changes nothing further.
    const violations = count(h, "policy.violation");
    const changes = count(h, "commit.changed");
    await reconcileAtStartup(h);
    expect(h.state()).toBe(expected);
    expect(h.merger).not.toHaveBeenCalled();
    expect(count(h, "policy.violation")).toBe(violations);
    expect(count(h, "commit.changed")).toBe(changes);
  });

  it("an untriaged public report is never tasked by reconciliation", async () => {
    const h = seed("Reported", "same");
    h.gh.setPull(7, { headRef: "loopback/LB-001", headSha: B });
    await reconcileAtStartup(h);
    expect(h.state()).toBe("Reported");
    expect(h.posts.filter((p) => p.includes("@loopback-fixer"))).toEqual([]);
  });

  it("a moved head always withdraws approval-bearing states before anything else can happen", async () => {
    for (const state of ["AwaitingApproval", "ReadyToMerge"] as const) {
      const h = seed(state, "moved");
      await reconcileAtStartup(h);
      expect(h.state()).toBe("Verifying");
      expect(h.posts.some((p) => /Previous approval and verification no longer apply/.test(p))).toBe(true);
    }
  });

  it("a merge outside Loopback is recorded once as a policy violation", async () => {
    const h = seed("AwaitingApproval", "merged");
    await reconcileAtStartup(h);
    await reconcileAtStartup(h);
    expect(count(h, "policy.violation")).toBe(1);
  });
});
