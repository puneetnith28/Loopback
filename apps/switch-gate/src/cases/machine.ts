import { isTransient, type CaseState, type ReasonCode } from "@loopback/contracts";

/** What caused a transition. Guards depend on it (D15, D18). */
export type TransitionTrigger = "command" | "maintainer_merge" | "poller" | "reconcile" | "sweep" | "agent_report" | "system";

/** Transition table from implementation §8.2, unchanged. */
const T: Readonly<Record<CaseState, readonly CaseState[]>> = {
  Reported: ["Triaged", "Blocked"],
  Triaged: ["FixInProgress"],
  FixInProgress: ["PRCreated", "Blocked"],
  PRCreated: ["Verifying", "Stale"],
  Verifying: ["AwaitingApproval", "VerificationFailed", "Stale"],
  VerificationFailed: ["FixInProgress"],
  AwaitingApproval: ["ReadyToMerge", "Stale"],
  ReadyToMerge: ["Revalidating", "Stale"],
  Revalidating: ["Merging", "Stale", "Blocked"],
  Merging: ["Merged", "MergeUnknown"],
  MergeUnknown: ["Revalidating", "Merged"],
  Stale: ["Verifying"],
  Blocked: ["FixInProgress"],
  Merged: [],
};

/** D18 exception (2): these states may go to Blocked only for PR_CLOSED. */
const PR_CLOSED_SOURCES: ReadonlySet<CaseState> = new Set<CaseState>([
  "PRCreated", "Verifying", "VerificationFailed", "AwaitingApproval", "ReadyToMerge", "Stale",
]);

export class IllegalTransition extends Error {
  constructor(from: CaseState, to: CaseState, reason: ReasonCode | null, trigger: TransitionTrigger) {
    super(`${from} -> ${to} (reason=${reason ?? "none"}, trigger=${trigger})`);
    this.name = "IllegalTransition";
  }
}

/** Facts about the case the guards need beyond its state. */
export interface TransitionContext {
  readonly hasPrAndHead: boolean;
}

const NO_CONTEXT: TransitionContext = { hasPrAndHead: false };

export function isAllowedTransition(
  from: CaseState,
  to: CaseState,
  reason: ReasonCode | null,
  trigger: TransitionTrigger,
  ctx: TransitionContext = NO_CONTEXT,
): boolean {
  if (T[from].includes(to)) {
    // D15: reconciliation reuses revalidation but never reaches Merging.
    if (from === "Revalidating" && to === "Merging") return trigger === "maintainer_merge";
    // Only the merge path, reconciliation or the poller may record a merge.
    if (to === "Merged") return trigger === "maintainer_merge" || trigger === "reconcile" || trigger === "poller";
    // D10: re-tasking the fixer is an explicit maintainer command.
    if ((from === "Blocked" || from === "VerificationFailed") && to === "FixInProgress") return trigger === "command";
    return true;
  }
  // D18 exception (1): transient Blocked cases re-enter Revalidating only on a maintainer
  // merge, and only if the case already has a PR and head (no skipping the workflow).
  if (from === "Blocked" && to === "Revalidating") {
    return trigger === "maintainer_merge" && ctx.hasPrAndHead && reason !== null && isTransient(reason);
  }
  // D18 exception (2): a PR closed without merging, observed from GitHub.
  if (to === "Blocked" && PR_CLOSED_SOURCES.has(from)) return reason === "PR_CLOSED";
  return false;
}

export function assertTransition(
  from: CaseState,
  to: CaseState,
  reason: ReasonCode | null,
  trigger: TransitionTrigger,
  ctx: TransitionContext = NO_CONTEXT,
): void {
  if (!isAllowedTransition(from, to, reason, trigger, ctx)) throw new IllegalTransition(from, to, reason, trigger);
}

export function isTerminal(state: CaseState): boolean {
  return T[state].length === 0;
}
