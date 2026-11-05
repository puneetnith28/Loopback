import { CASE_STATES, REASON_CODES, TRANSIENT_REASON_CODES, type CaseState, type ReasonCode } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransition, assertTransition, isAllowedTransition, isTerminal, type TransitionTrigger } from "../../apps/switch-gate/src/cases/machine.js";

// Independent copy of implementation §8.2 so the test does not trust the code's own table.
const SPEC: Record<CaseState, CaseState[]> = {
  Reported: ["Triaged", "Blocked"], Triaged: ["FixInProgress"], FixInProgress: ["PRCreated", "Blocked"],
  PRCreated: ["Verifying", "Stale"], Verifying: ["AwaitingApproval", "VerificationFailed", "Stale"],
  VerificationFailed: ["FixInProgress", "Verifying"], AwaitingApproval: ["ReadyToMerge", "Stale"],
  ReadyToMerge: ["Revalidating", "Stale"], Revalidating: ["Merging", "Stale", "Blocked"],
  Merging: ["Merged", "MergeUnknown"], MergeUnknown: ["Revalidating", "Merged"],
  Stale: ["Verifying"], Blocked: ["FixInProgress"], Merged: [],
};
const PR_CLOSED_SOURCES: CaseState[] = ["PRCreated", "Verifying", "VerificationFailed", "AwaitingApproval", "ReadyToMerge", "Stale"];

describe("state machine (§8.2 + D18 exceptions)", () => {
  // The trigger each specified edge legitimately uses (all others are checked below).
  const triggerFor = (from: CaseState, to: CaseState): TransitionTrigger => {
    if (from === "Revalidating" && to === "Merging") return "maintainer_merge";
    if (to === "Merged") return "reconcile";
    if ((from === "Blocked" || from === "VerificationFailed") && to === "FixInProgress") return "command";
    if (from === "VerificationFailed" && to === "Verifying") return "command"; // D33
    return "system";
  };

  it("checks all 14 x 14 pairs against the specified table", () => {
    for (const from of CASE_STATES) {
      for (const to of CASE_STATES) {
        expect(isAllowedTransition(from, to, null, triggerFor(from, to)), `${from}->${to}`).toBe(SPEC[from].includes(to));
      }
    }
  });

  it("only the merge path, reconciliation or the poller can record Merged", () => {
    for (const from of ["Merging", "MergeUnknown"] as CaseState[]) {
      for (const t of ["maintainer_merge", "reconcile", "poller"] as TransitionTrigger[]) expect(isAllowedTransition(from, "Merged", null, t)).toBe(true);
      for (const t of ["command", "agent_report", "sweep", "system"] as TransitionTrigger[]) expect(isAllowedTransition(from, "Merged", null, t), t).toBe(false);
    }
  });

  it("D10: re-tasking (Blocked/VerificationFailed -> FixInProgress) requires an explicit command", () => {
    for (const from of ["Blocked", "VerificationFailed"] as CaseState[]) {
      expect(isAllowedTransition(from, "FixInProgress", null, "command")).toBe(true);
      for (const t of ["agent_report", "poller", "sweep", "system", "reconcile"] as TransitionTrigger[]) {
        expect(isAllowedTransition(from, "FixInProgress", null, t), `${from}/${t}`).toBe(false);
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
    const ctx = { hasPrAndHead: true };
    for (const code of REASON_CODES) {
      const expected = TRANSIENT_REASON_CODES.has(code);
      expect(isAllowedTransition("Blocked", "Revalidating", code, "maintainer_merge", ctx), code).toBe(expected);
      expect(isAllowedTransition("Blocked", "Revalidating", code, "reconcile", ctx), code).toBe(false);
      expect(isAllowedTransition("Blocked", "Revalidating", code, "poller", ctx), code).toBe(false);
    }
    expect(isAllowedTransition("Blocked", "Revalidating", null, "maintainer_merge", ctx)).toBe(false);
  });

  it("review fix: a case without a PR and head can never reach Revalidating from Blocked", () => {
    // Reported -> Blocked -> Revalidating would otherwise skip the whole workflow.
    expect(isAllowedTransition("Reported", "Blocked", "RATE_LIMITED", "system")).toBe(true);
    expect(isAllowedTransition("Blocked", "Revalidating", "RATE_LIMITED", "maintainer_merge", { hasPrAndHead: false })).toBe(false);
    expect(isAllowedTransition("Blocked", "Revalidating", "RATE_LIMITED", "maintainer_merge")).toBe(false);
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
