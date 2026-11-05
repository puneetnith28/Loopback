import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../src/design-system/components/Button.tsx";
import { DataTable } from "../src/design-system/components/DataTable.tsx";
import { DataView } from "../src/design-system/components/DataView.tsx";
import { Dialog } from "../src/design-system/components/Dialog.tsx";
import { Dropdown } from "../src/design-system/components/Dropdown.tsx";
import { Input } from "../src/design-system/components/Input.tsx";
import { ApprovalCommand, Sha } from "../src/design-system/components/Sha.tsx";
import { Tabs } from "../src/design-system/components/Tabs.tsx";
import { Toggle } from "../src/design-system/components/Toggle.tsx";
import { Tooltip } from "../src/design-system/components/Tooltip.tsx";
import { UntrustedText } from "../src/design-system/components/UntrustedText.tsx";
import type { Loadable } from "../src/lib/loadable.ts";
import { expectAccessible } from "./setup.ts";

const SHA = "e804775a5938f9afe55fa5321875735734e3e1a5";

describe("Button and IconButton", () => {
  it("a busy button is disabled, announces busy and does not fire again", async () => {
    const onClick = vi.fn();
    render(<Button busy onClick={onClick}>Request verification</Button>);
    const b = screen.getByRole("button", { name: "Request verification" });
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    await userEvent.setup().click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("icon-only buttons have an accessible name and pass axe", async () => {
    const { container } = render(<IconButton icon="copy" label="Copy commit SHA" />);
    expect(screen.getByRole("button", { name: "Copy commit SHA" })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("form controls", () => {
  it("Input connects its label, hint and error and marks itself invalid", async () => {
    const { container } = render(<Input label="Case id" hint="Like LB-001" error="Use three digits" />);
    const input = screen.getByLabelText("Case id");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Like LB-001", "Use three digits"]);
    expect(screen.getByRole("alert").textContent).toContain("Use three digits");
    await expectAccessible(container);
  });

  it("Toggle is a switch that reports its state in text, not position alone", async () => {
    function Harness() { const [on, setOn] = useState(false); return <Toggle label="Compact rows" checked={on} onChange={setOn} />; }
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: /Compact rows/ });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toContain("Off");
    await userEvent.setup().click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.textContent).toContain("On");
  });
});

describe("Tabs", () => {
  it("moves selection with arrow, Home and End keys (roving tabindex)", async () => {
    const user = userEvent.setup();
    const { container } = render(<Tabs label="States" items={[{ id: "a", label: "Alpha", content: "A" }, { id: "b", label: "Beta", content: "B" }, { id: "c", label: "Gamma", content: "C" }]} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    await user.click(tabs[0]!);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Beta" }));
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Gamma" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("A");
    await expectAccessible(container);
  });
});

describe("Dropdown menu", () => {
  it("opens with focus on the first item, navigates with arrows, and Escape returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Dropdown label="Copy" items={[{ id: "a", label: "Copy case id", onSelect }, { id: "b", label: "Copy head SHA", onSelect: () => undefined }]} />);
    const trigger = screen.getByRole("button", { name: "Copy" });
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Copy case id" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Copy head SHA" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("Dialog", () => {
  it("is labelled by its title and returns focus to the opener when closed", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><Button onClick={() => setOpen(true)}>Open</Button><Dialog open={open} onClose={() => setOpen(false)} title="Approval stays in Switch">Body</Dialog></>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Approval stays in Switch" });
    expect(dialog.hasAttribute("open")).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe("Tooltip", () => {
  it("describes its trigger, opens on keyboard focus and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Tooltip content="Copies the full SHA"><IconButton icon="copy" label="Copy" /></Tooltip>);
    const trigger = screen.getByRole("button", { name: "Copy" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
    await user.tab();
    expect(tip.getAttribute("data-open")).toBe("true");
    await user.keyboard("{Escape}");
    expect(tip.getAttribute("data-open")).toBe("false");
  });
});

describe("DataTable", () => {
  it("sorts by a sortable column and exposes aria-sort", async () => {
    const user = userEvent.setup();
    const rows = [{ id: "LB-002", n: 2 }, { id: "LB-001", n: 1 }, { id: "LB-003", n: 3 }];
    const { container } = render(<DataTable caption="Cases" rowKey={(r) => r.id} rows={rows} columns={[{ key: "id", header: "Case", render: (r) => r.id, sortValue: (r) => r.id }, { key: "n", header: "N", render: (r) => r.n }]} />);
    const header = screen.getByRole("columnheader", { name: /Case/ });
    expect(header.getAttribute("aria-sort")).toBe("none");
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getAllByRole("row").slice(1).map((r) => r.firstChild?.textContent)).toEqual(["LB-001", "LB-002", "LB-003"]);
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    await expectAccessible(container);
  });
});

describe("DataView: the six content states", () => {
  const view = (state: Loadable<string>) => render(<DataView label="cases" state={state} skeleton={<span>skeleton</span>}>{(d) => <p>data: {d}</p>}</DataView>);
  it.each([
    ["loading", { status: "loading" } as const, (c: HTMLElement) => expect(within(c).getByRole("status").textContent).toContain("Loading cases")],
    ["empty", { status: "empty", title: "No open cases", detail: "Nothing to review." } as const, () => expect(screen.getByText("No open cases")).toBeTruthy()],
    ["error", { status: "error", title: "Could not load cases", detail: "The API did not respond." } as const, () => expect(screen.getByRole("alert").textContent).toContain("Could not load cases")],
    ["permission", { status: "permission", boundary: "maintainers only", detail: "Ask a maintainer." } as const, () => expect(screen.getByText("No access: maintainers only")).toBeTruthy()],
    ["partial", { status: "partial", data: "x", missing: ["CI evidence"] } as const, () => { expect(screen.getByText("data: x")).toBeTruthy(); expect(screen.getByText(/unavailable: CI evidence/)).toBeTruthy(); }],
    ["success", { status: "success", data: "x" } as const, () => expect(screen.getByText("data: x")).toBeTruthy()],
  ])("%s", (_n, state, assert) => {
    const { container } = view(state);
    assert(container);
  });

  it("error offers a retry when one is given", async () => {
    const retry = vi.fn();
    view({ status: "error", title: "Failed", detail: "x", retry });
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("SHA and approval command", () => {
  it("Sha shows 7 characters by default but exposes and copies the full SHA", async () => {
    const user = userEvent.setup(); // installs its own clipboard; spy on it afterwards
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<Sha value={SHA} />);
    expect(screen.getByLabelText(`commit ${SHA}`).textContent).toBe("e804775");
    await user.click(screen.getByRole("button", { name: `Copy full commit SHA ${SHA}` }));
    expect(writeText).toHaveBeenCalledWith(SHA);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("the approval command appears only with evidence for the current head, with the full SHA", () => {
    const { rerender } = render(<ApprovalCommand caseId="LB-042" headSha={SHA} verifiedSha={null} />);
    expect(screen.queryByText(/approve LB-042/)).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/No approval command/);
    rerender(<ApprovalCommand caseId="LB-042" headSha={SHA} verifiedSha={SHA} />);
    expect(screen.getByText(`@loopback-gate approve LB-042 ${SHA}`)).toBeTruthy();
  });

  it("refuses to build a command from a short or malformed SHA", () => {
    render(<ApprovalCommand caseId="LB-042" headSha="e804775" verifiedSha={SHA} />);
    expect(screen.queryByText(/approve LB-042/)).toBeNull();
  });

  it("the console exposes no approve/merge action anywhere in the command component", () => {
    render(<ApprovalCommand caseId="LB-042" headSha={SHA} verifiedSha={SHA} />);
    expect(screen.queryByRole("button", { name: /approve|merge/i })).toBeNull();
  });
});

describe("UntrustedText", () => {
  it("renders markup as inert text (no element is created)", () => {
    const { container } = render(<UntrustedText value={'<img src=x onerror="alert(1)"><b>bold</b>'} />);
    expect(container.querySelector("img, b")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("makes hidden bidi and zero-width characters visible and says so to screen readers", () => {
    const { container } = render(<UntrustedText value={"fdp‮.exe​"} />);
    expect(container.textContent).toContain("⟨U+202E⟩");
    expect(container.textContent).toContain("⟨U+200B⟩");
    expect(container.textContent).not.toContain("‮");
    expect(container.textContent).toContain("2 hidden characters shown");
  });

  it("clamps very long input", () => {
    const { container } = render(<UntrustedText value={"x".repeat(5000)} maxLength={100} />);
    expect(container.textContent.length).toBeLessThan(110);
  });
});
