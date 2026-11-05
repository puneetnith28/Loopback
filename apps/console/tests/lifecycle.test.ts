import { CASE_STATES } from "@loopback/contracts";
import { describe, expect, it } from "vitest";
import { DETOURS, MAIN_PATH, STATE_LABELS, trackSteps } from "../src/lib/lifecycle.ts";

describe("lifecycle model over the contract's 14 states", () => {
  it("main path + detours partition CASE_STATES exactly (nothing invented, nothing missing)", () => {
    const shown = [...MAIN_PATH, ...DETOURS.map((d) => d.state)];
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual([...CASE_STATES].sort());
    expect(CASE_STATES).toHaveLength(14);
  });

  it("every state has a label and every detour branches from a main-path step", () => {
    for (const s of CASE_STATES) expect(STATE_LABELS[s]).toBeTruthy();
    for (const d of DETOURS) expect(MAIN_PATH).toContain(d.from);
  });

  it("marks steps before the current one done, the current one current, later ones upcoming", () => {
    expect(trackSteps("Verifying", false).map((s) => s.status)).toEqual(["done", "done", "done", "done", "current", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(trackSteps("Merged", false).every((s) => s.status === "done")).toBe(true);
  });

  it("never shows evidence-dependent steps as done when the head moved", () => {
    const steps = trackSteps("ReadyToMerge", true);
    const byState = Object.fromEntries(steps.map((s) => [s.state, s.status]));
    expect(byState.PRCreated).toBe("done");
    expect(byState.Verifying).toBe("invalidated");
    expect(byState.AwaitingApproval).toBe("invalidated");
    expect(steps.some((s) => s.status === "done" && ["Verifying", "AwaitingApproval"].includes(s.state))).toBe(false);
  });

  it("a detour stops the track at the step it branched from", () => {
    expect(trackSteps("Stale", false).find((s) => s.state === "PRCreated")?.status).toBe("done");
    expect(trackSteps("Stale", false).find((s) => s.state === "Verifying")?.status).toBe("upcoming");
  });
});
