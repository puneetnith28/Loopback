import { CASE_STATES } from "@loopback/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProvenanceStamp } from "../src/design-system/components/ProvenanceStamp.tsx";
import { StateTrack } from "../src/design-system/components/StateTrack.tsx";
import { Timeline, EVENT_KINDS, type TimelineEvent } from "../src/design-system/components/Timeline.tsx";
import { MAIN_PATH, STATE_LABELS } from "../src/lib/lifecycle.ts";
import { PROVENANCE, PROVENANCE_KINDS } from "../src/lib/provenance.ts";
import { expectAccessible } from "./setup.ts";

const HEAD = "e804775a5938f9afe55fa5321875735734e3e1a5";
const OLD = "70a5362de6f0ae97b11b83c4406d6316433daa8d";

describe("ProvenanceStamp", () => {
  it.each(PROVENANCE_KINDS)("%s: names its source and trust category in text, with an accessible description", async (kind) => {
    const { container } = render(<ProvenanceStamp source={kind} />);
    const stamp = container.querySelector(`[data-provenance="${kind}"]`)!;
    expect(stamp.textContent).toContain(PROVENANCE[kind].label);
    expect(stamp.textContent).toContain(PROVENANCE[kind].trustLabel);
    expect(stamp.textContent).toContain(PROVENANCE[kind].description);
    expect(stamp.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true"); // icon supplements, never replaces, text
    await expectAccessible(container);
  });

  it("agent claims are labelled unverified and demo fixtures are labelled as fixtures", () => {
    render(<><ProvenanceStamp source="agent-claim" /><ProvenanceStamp source="demo" /></>);
    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByText("Fixture")).toBeTruthy();
  });
});

describe("StateTrack (the Loop)", () => {
  it.each(CASE_STATES)("renders state %s from the contract with an accessible label", (state) => {
    render(<StateTrack state={state} headSha={HEAD} evidenceSha={HEAD} />);
    expect(screen.getByRole("figure", { name: `Case lifecycle: ${STATE_LABELS[state]}` })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(MAIN_PATH.length);
  });

  it("marks exactly one current step on the main path and describes every step's status", () => {
    render(<StateTrack state="Verifying" headSha={HEAD} evidenceSha={null} />);
    const current = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("Verifying");
    expect(current[0]!.textContent).toContain("current step");
  });

  it("shows a detour state where it branches, with its meaning in text", () => {
    render(<StateTrack state="VerificationFailed" headSha={HEAD} evidenceSha={HEAD} />);
    expect(screen.getAllByText("Verification failed").length).toBeGreaterThan(0);
    expect(screen.getByText(/the fixer must rework/)).toBeTruthy();
  });

  it("breaks the seal when the head moved: both full SHAs shown, earlier evidence never shown as applying", () => {
    render(<StateTrack state="Stale" headSha={HEAD} evidenceSha={OLD} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Seal broken/);
    // Both full SHAs are shown next to the broken seal (outside the short alert, so it stays brief).
    expect(screen.getByLabelText(`commit ${OLD}`).textContent).toBe(OLD);
    expect(screen.getByLabelText(`commit ${HEAD}`).textContent).toBe(HEAD);
    expect(screen.queryByText(/Sealed: evidence is bound to the current head/)).toBeNull();
  });

  it("invalidates evidence-dependent steps (never 'completed') when the head moved", () => {
    render(<StateTrack state="ReadyToMerge" headSha={HEAD} evidenceSha={OLD} />);
    const verifying = screen.getAllByRole("listitem").find((li) => li.textContent?.startsWith("Verifying"))!;
    expect(verifying.getAttribute("data-status")).toBe("invalidated");
    expect(verifying.textContent).toContain("evidence no longer applies");
  });

  it("shows the seal intact with the full SHA when evidence matches the head, and passes axe", async () => {
    const { container } = render(<StateTrack state="AwaitingApproval" headSha={HEAD} evidenceSha={HEAD} />);
    expect(screen.getByText(/Sealed: evidence is bound to the current head/)).toBeTruthy();
    expect(screen.getByLabelText(`commit ${HEAD}`).textContent).toBe(HEAD);
    await expectAccessible(container);
  });
});

describe("Timeline", () => {
  const events: TimelineEvent[] = EVENT_KINDS.map((kind, i) => ({ id: String(i), kind, title: `${kind} event`, actor: "@a", at: "2026-11-04T14:00:00Z", provenance: "demo" }));

  it("supports every event category, labelled for assistive tech, in the given order only", async () => {
    const { container } = render(<Timeline events={events} now={new Date("2026-11-04T14:05:00Z")} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-kind"))).toEqual([...EVENT_KINDS]);
    for (const label of ["Human action", "Machine action", "Gate decision", "GitHub event", "Verification", "Failure", "Rejection"]) {
      expect(screen.getByRole("img", { name: label })).toBeTruthy();
    }
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-04T14:00:00Z");
    expect(screen.getAllByText("5 minutes ago")).toHaveLength(EVENT_KINDS.length);
    await expectAccessible(container);
  });

  it("renders nothing it was not given (no synthesised events)", () => {
    render(<Timeline events={[]} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("treats event detail as untrusted text", () => {
    const { container } = render(<Timeline events={[{ ...events[0]!, detail: "<script>alert(1)</script>" }]} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
