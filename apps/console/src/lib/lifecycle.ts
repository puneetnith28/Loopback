import { CASE_STATES, type CaseState } from "@loopback/contracts";

/**
 * Presentation of the 14 contract states (CASE_STATES) as one track. Nothing is invented: the main path and the
 * detours partition CASE_STATES exactly (asserted in tests/lifecycle.test.ts). The detours and where they leave
 * and rejoin the path mirror the gate's transition table (apps/switch-gate/src/cases/machine.ts, read-only).
 */
export const MAIN_PATH = [
  "Reported", "Triaged", "FixInProgress", "PRCreated", "Verifying",
  "AwaitingApproval", "ReadyToMerge", "Revalidating", "Merging", "Merged",
] as const satisfies readonly CaseState[];

export type MainPathState = (typeof MAIN_PATH)[number];
export type DetourState = Exclude<CaseState, MainPathState>;

export function isMainPathState(state: CaseState): state is MainPathState {
  return (MAIN_PATH as readonly CaseState[]).includes(state);
}

export interface Detour {
  readonly state: DetourState;
  /** The main-path step it branches from (where it is drawn). */
  readonly from: MainPathState;
  readonly tone: "danger" | "human";
  readonly meaning: string;
}

/** Keyed by every non-main-path state, so a new CASE_STATES member is a compile error until it is placed. */
const DETOUR_BY_STATE: Readonly<Record<DetourState, Omit<Detour, "state">>> = {
  VerificationFailed: { from: "Verifying", tone: "danger", meaning: "Verification failed; the fixer must rework" },
  Stale: { from: "PRCreated", tone: "human", meaning: "The head commit moved; verification must run again" },
  Blocked: { from: "FixInProgress", tone: "danger", meaning: "Stopped; needs maintainer attention" },
  MergeUnknown: { from: "Merging", tone: "danger", meaning: "Merge outcome unknown; being reconciled with GitHub" },
};

export const DETOURS: readonly Detour[] = (Object.keys(DETOUR_BY_STATE) as DetourState[]).map((state) => ({ state, ...DETOUR_BY_STATE[state] }));

/** The detour for `state`, or null when `state` is on the main path. */
export function detourOf(state: CaseState): Detour | null {
  return isMainPathState(state) ? null : { state, ...DETOUR_BY_STATE[state] };
}

export const STATE_LABELS: Readonly<Record<CaseState, string>> = {
  Reported: "Reported", Triaged: "Triaged", FixInProgress: "Fix in progress", PRCreated: "PR created",
  Verifying: "Verifying", VerificationFailed: "Verification failed", AwaitingApproval: "Awaiting approval",
  ReadyToMerge: "Ready to merge", Revalidating: "Revalidating", Merging: "Merging", Merged: "Merged",
  Stale: "Stale", Blocked: "Blocked", MergeUnknown: "Merge unknown",
};

export type StepStatus = "done" | "current" | "upcoming" | "invalidated";

/**
 * Status of every main-path step for a case in `state`. For a detour the track stops at the step it branched
 * from. When `headMoved` is true, steps after PRCreated that depended on the old commit are "invalidated",
 * never "done": earlier verification does not carry over to a new head.
 */
export function trackSteps(state: CaseState, headMoved: boolean): { state: MainPathState; status: StepStatus }[] {
  const detour = detourOf(state);
  const anchor: MainPathState = detour ? detour.from : isMainPathState(state) ? state : MAIN_PATH[0];
  const current = MAIN_PATH.indexOf(anchor);
  const evidenceStart = MAIN_PATH.indexOf("Verifying");
  return MAIN_PATH.map((s, i) => {
    if (i < current) return { state: s, status: headMoved && i >= evidenceStart ? "invalidated" : "done" };
    if (i === current) return { state: s, status: detour ? "done" : state === "Merged" ? "done" : "current" };
    return { state: s, status: "upcoming" };
  });
}

export function isKnownState(value: string): value is CaseState {
  return (CASE_STATES as readonly string[]).includes(value);
}
