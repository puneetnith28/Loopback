import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/app/ErrorBoundary.tsx";
import { DataView } from "../src/design-system/components/DataView.tsx";
import { Dialog } from "../src/design-system/components/Dialog.tsx";
import { Dropdown } from "../src/design-system/components/Dropdown.tsx";
import { Input } from "../src/design-system/components/Input.tsx";
import { StateTrack } from "../src/design-system/components/StateTrack.tsx";
import { Tabs } from "../src/design-system/components/Tabs.tsx";
import { Tooltip } from "../src/design-system/components/Tooltip.tsx";

// Regression tests for the ecc:react-reviewer, ecc:typescript-reviewer and ecc:a11y-architect findings.

const A = "e804775a5938f9afe55fa5321875735734e3e1a5";
const B = "70a5362de6f0ae97b11b83c4406d6316433daa8d";

describe("Dialog under StrictMode", () => {
  it("keeps the page scroll locked while open and restores it on close", () => {
    const { rerender } = render(<StrictMode><Dialog open onClose={() => {}} title="T">body</Dialog></StrictMode>);
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<StrictMode><Dialog open={false} onClose={() => {}} title="T">body</Dialog></StrictMode>);
    expect(document.body.style.overflow).toBe("");
  });
});

describe("Dropdown focus", () => {
  it("Tab out of the open menu closes it without stranding focus on <body>", async () => {
    const user = userEvent.setup();
    render(<><Dropdown label="Actions" items={[{ id: "a", label: "One", onSelect: () => {} }]} /><button type="button">After</button></>);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "One" })).toBe(document.activeElement);
    await user.tab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Tabs reconcile with their items", () => {
  it("falls back to the first tab when the selected tab disappears", () => {
    const items = [{ id: "x", label: "X", content: "x" }, { id: "y", label: "Y", content: "y" }];
    const { rerender } = render(<Tabs label="t" items={items} defaultId="y" />);
    rerender(<Tabs label="t" items={[{ id: "x", label: "X", content: "x" }, { id: "z", label: "Z", content: "z" }]} />);
    expect(screen.getByRole("tab", { name: "X" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tabpanel").textContent).toBe("x");
  });

  it("names the count for screen readers", () => {
    render(<Tabs label="t" items={[{ id: "x", label: "Events", count: 3, content: "x" }]} />);
    expect(screen.getByRole("tab").textContent).toMatch(/3 items/);
  });
});

describe("Seal break is announced when it happens live", () => {
  it("mounts a fresh, short alert when the head moves, leaving the SHAs outside it", () => {
    const { rerender } = render(<StateTrack state="AwaitingApproval" headSha={A} evidenceSha={A} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<StateTrack state="Stale" headSha={B} evidenceSha={A} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Seal broken/);
    expect(alert.textContent).not.toContain(A);
    expect(alert.textContent).not.toContain(B);
    expect(screen.getAllByText(A, { exact: false }).length).toBeGreaterThan(0);
  });
});

describe("DataView loading", () => {
  it("has announceable text inside the status region", () => {
    render(<DataView state={{ status: "loading" }} label="cases" skeleton={<div />}>{() => null}</DataView>);
    expect(screen.getByRole("status").textContent).toMatch(/Loading cases/);
  });
});

describe("aria-describedby is merged, never overwritten", () => {
  it("Input keeps its hint and error linkage alongside a caller's description", () => {
    render(<><p id="extra">extra</p><Input label="Name" hint="h" error="e" aria-describedby="extra" /></>);
    const ids = screen.getByLabelText("Name").getAttribute("aria-describedby")!.split(" ");
    expect(ids).toContain("extra");
    expect(ids.length).toBe(3);
  });

  it("Tooltip keeps the child's own description", () => {
    render(<><p id="own">own</p><Tooltip content="tip"><button type="button" aria-describedby="own">B</button></Tooltip></>);
    const ids = screen.getByRole("button").getAttribute("aria-describedby")!.split(" ");
    expect(ids).toContain("own");
    expect(ids.length).toBe(2);
  });
});

describe("ErrorBoundary recovery", () => {
  it("shows a plain message, then recovers when its reset key changes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let setKey: (k: string) => void = () => {};
      let boom = true;
      function Boom() { if (boom) throw new Error("<script>secret</script>"); return <p>ok</p>; }
      function Host() { const [k, s] = useState("a"); setKey = s; return <ErrorBoundary resetKey={k}><Boom /></ErrorBoundary>; }
      render(<Host />);
      expect(screen.getByRole("alert").textContent).not.toContain("secret");
      boom = false;
      act(() => setKey("b"));
      expect(screen.getByText("ok")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
