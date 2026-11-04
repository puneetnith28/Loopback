import { CASE_STATES, REASON_CODES, TRANSIENT_REASON_CODES, type CaseState, type ReasonCode } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransition, assertTransition, isAllowedTransition, isTerminal, type TransitionTrigger } from "../../apps/switch-gate/src/cases/machine.js";

// Independent copy of implementation §8.2 so the test does not trust the code's own table.
const SPEC: Record<CaseState, CaseState[]> = {
  Reported: ["Triaged", "Blocked"], Triaged: ["FixInProgress"], FixInProgress: ["PRCreated", "Blocked"],
  PRCreated: ["Verifying", "Stale"], Verifying: ["AwaitingApproval", "VerificationFailed", "Stale"],
  VerificationFailed: ["FixInProgress"], AwaitingApproval: ["ReadyToMerge", "Stale"],
  ReadyToMerge: ["Revalidating", "Stale"], Revalidating: ["Merging", "Stale", "Blocked"],
  Merging: ["Merged", "MergeUnknown"], MergeUnknown: ["Revalidating", "Merged"],
  Stale: ["Verifying"], Blocked: ["FixInProgress"], Merged: [],
};
const PR_CLOSED_SOURCES: CaseState[] = ["PRCreated", "Verifying", "VerificationFailed", "AwaitingApproval", "ReadyToMerge", "Stale"];

describe("state machine (§8.2 + D18 exceptions)", () => {
  it("checks all 14 x 14 pairs with a neutral reason and trigger", () => {
    for (const from of CASE_STATES) {
      for (const to of CASE_STATES) {
        const trigger: TransitionTrigger = from === "Revalidating" && to === "Merging" ? "maintainer_merge" : "system";
        expect(isAllowedTransition(from, to, null, trigger), `${from}->${to}`).toBe(SPEC[from].includes(to));
      }
    }
  });

  it("Merged is the only terminal state", () => {
    expect(CASE_STATES.filter(isTerminal)).toEqual(["Merged"]);
  });

  it("D15: Revalidating -> Merging only on a maintainer merge, never on reconcile", () => {
    expect(isAllowedTransition("Revalidating", "Merging", null, "maintainer_merge")).toBe(true);
    for (const t of ["reconcile", "poller", "system", "sweep", "command"] as TransitionTrigger[]) {
      expect(isAllowedTransition("Revalidating", "Merging", null, t), t).toBe(false);
    }
  });

  it("D18(1): Blocked -> Revalidating only for transient codes on a maintainer merge", () => {
    for (const code of REASON_CODES) {
      const expected = TRANSIENT_REASON_CODES.has(code);
      expect(isAllowedTransition("Blocked", "Revalidating", code, "maintainer_merge"), code).toBe(expected);
      expect(isAllowedTransition("Blocked", "Revalidating", code, "reconcile"), code).toBe(false);
      expect(isAllowedTransition("Blocked", "Revalidating", code, "poller"), code).toBe(false);
    }
    expect(isAllowedTransition("Blocked", "Revalidating", null, "maintainer_merge")).toBe(false);
  });

  it("D18(2): listed states -> Blocked only with PR_CLOSED", () => {
    for (const from of PR_CLOSED_SOURCES) {
      expect(isAllowedTransition(from, "Blocked", "PR_CLOSED", "poller"), from).toBe(true);
      for (const code of REASON_CODES.filter((c) => c !== "PR_CLOSED") as ReasonCode[]) {
        expect(isAllowedTransition(from, "Blocked", code, "poller"), `${from}/${code}`).toBe(false);
      }
    }
    // states outside the list never gain Blocked through PR_CLOSED
    for (const from of ["Triaged", "Merging", "Merged", "MergeUnknown"] as CaseState[]) {
      expect(isAllowedTransition(from, "Blocked", "PR_CLOSED", "poller"), from).toBe(false);
    }
  });

  it("assertTransition throws IllegalTransition with context", () => {
    expect(() => assertTransition("Merged", "Revalidating", null, "system")).toThrow(IllegalTransition);
    expect(() => assertTransition("Triaged", "FixInProgress", null, "command")).not.toThrow();
  });
});
