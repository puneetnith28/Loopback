import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEMO_CASES, DEMO_SENTINEL } from "../src/demo/fixtures.ts";
import { happyApi } from "../test-fixtures/api.ts";
import { mockApi, renderAt, routesFrom } from "./api-mock.tsx";
import { expectAccessible } from "./setup.ts";

describe("theme", () => {
  it("toggles dark/light on <html>, persists the choice, and labels the control by its effect", async () => {
    mockApi(routesFrom(happyApi()));
    const user = userEvent.setup();
    renderAt("/");
    const toggle = screen.getByRole("button", { name: "Switch to light theme" });
    await user.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("loopback.theme")).toBe("light");
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("still switches theme when storage is unavailable (private mode)", async () => {
    mockApi(routesFrom(happyApi()));
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      renderAt("/");
      await userEvent.setup().click(screen.getByRole("button", { name: "Switch to light theme" }));
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("no read API (production surface without a backend)", () => {
  it("says the API cannot be reached and shows no fabricated data", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const { container } = renderAt("/");
    expect(await screen.findByText("Cannot reach the read API")).toBeTruthy();
    expect(container.textContent).not.toContain(DEMO_CASES[0]!.id);
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    await expectAccessible(container);
  });
});

describe("/design reference", () => {
  it("renders with a persistent DEMO banner, one h1, and every fixture inside a labelled DEMO frame", async () => {
    mockApi({});
    const { container } = renderAt("/design");
    expect(await screen.findByRole("heading", { level: 1, name: "The Evidence Ledger" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Design reference — demonstration content only")).toBeTruthy();
    // The shell header is the first banner (testing-library also counts in-section <header>s, which the HTML-AAM maps to generic).
    expect(within(screen.getAllByRole("banner")[0]!).getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "DEMO data")).toBeTruthy();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    // Every element showing a fixture case id sits inside a [data-demo] frame.
    for (const c of DEMO_CASES) {
      for (const el of screen.queryAllByText(c.id, { exact: false })) {
        expect(el.closest(`[data-demo="${DEMO_SENTINEL}"]`), `${c.id} outside a DEMO frame`).not.toBeNull();
      }
    }
    await expectAccessible(container);
  }, 20_000);
});
