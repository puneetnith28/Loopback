import { expect, test } from "@playwright/test";
import { SHA_A, SHA_C, caseSummary, envelope } from "../test-fixtures/api.ts";
import { expectNoAxeViolations, expectNoHorizontalOverflow, isNarrow, mockApi, openNav } from "./support.ts";

const EVIDENCE = "evidence";
const ROUTES: readonly (readonly [string, string])[] = [
  ["/", "Overview"], ["/cases", "Cases"], ["/cases/LB-042", "LB-042"], ["/cases/LB-043", "LB-043"],
  ["/agents", "Agent activity"], ["/gate", "Gate & verification"], ["/audit", "Audit history"], ["/system", "System"],
];

test.describe("every screen: real browser, production build", () => {
  for (const [path, title] of ROUTES) {
    test(`${path} renders, reflows without horizontal scroll and passes axe (incl. contrast)`, async ({ page }) => {
      const { apiMethods, foreign } = await mockApi(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByText("Read API data generated").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
      expect(apiMethods.every((m) => m === "GET")).toBe(true);
      expect(foreign).toEqual([]);
    });
  }
});

test("critical flow: overview → case → evidence bound to the current head → exact approval command", async ({ page }, info) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("link", { name: "LB-042" }).first().click();
  await expect(page).toHaveURL(/\/cases\/LB-042$/);
  await expect(page.getByRole("heading", { level: 1, name: "LB-042" })).toBeFocused();
  await expect(page.getByText("Sealed: evidence is bound to the current head.")).toBeVisible();
  await expect(page.getByText(`@loopback-gate approve LB-042 ${SHA_A}`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^(approve|merge)\b/i })).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/case-sealed-${info.project.name}-dark.png` });
});

test("critical flow: the head moved — prominent alert, broken seal, stale evidence, no approval command", async ({ page }, info) => {
  await mockApi(page);
  await page.goto("/cases/LB-043");
  await expect(page.getByText("The head commit moved after verification")).toBeVisible();
  await expect(page.getByText("Seal broken: the head moved after verification.")).toBeVisible();
  await expect(page.getByText(/approve LB-043/)).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/case-head-moved-${info.project.name}-dark.png` });
  await page.getByRole("tab", { name: /Commits/ }).click();
  await expect(page.getByText("The head commit changed 1 time")).toBeVisible();
  await expect(page.getByRole("tabpanel").locator("[data-stale='true']").first()).toBeVisible();
  await expect(page.getByText(SHA_C).first()).toBeVisible();
  await page.getByRole("tab", { name: /Evidence/ }).click();
  await expect(page.getByText("Earlier commit — does not apply to the current head").first()).toBeVisible();
});

test("keyboard: skip link, tabs with arrow keys, and focus on the new page after navigating", async ({ page }) => {
  await mockApi(page);
  await page.goto("/cases/LB-042");
  await expect(page.getByText("Sealed: evidence is bound to the current head.")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  await page.getByRole("tab", { name: /Evidence/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Commits/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /Commits/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Activity" })).toBeFocused();

  await openNav(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit history" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Audit history" })).toBeFocused();
  await openNav(page);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit history" })).toHaveAttribute("aria-current", "page");
});

test("theme: light theme applies, persists across reload, and passes contrast", async ({ page }, info) => {
  await mockApi(page);
  await page.goto("/cases/LB-043");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByText("The head commit moved after verification")).toBeVisible();
  await expectNoAxeViolations(page);
  await page.screenshot({ path: `${EVIDENCE}/case-head-moved-${info.project.name}-light.png` });
  await page.goto("/");
  await expect(page.getByText("Read API data generated").first()).toBeVisible();
  await expectNoAxeViolations(page);
  await page.screenshot({ path: `${EVIDENCE}/overview-${info.project.name}-light.png` });
});

test("responsive navigation: sidebar on wide screens, disclosure menu on narrow screens", async ({ page }, info) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByText("Read API data generated").first()).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/overview-${info.project.name}-dark.png` });
  const nav = page.getByRole("navigation", { name: "Primary" });
  if (isNarrow(page)) {
    await expect(nav).toBeHidden();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(nav).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nav).toBeHidden();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await nav.getByRole("link", { name: "Cases" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Cases" })).toBeVisible();
    await expect(nav).toBeHidden();
  } else {
    await expect(nav).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  }
});

test("production build: no design route, no demo fixtures", async ({ page }) => {
  await mockApi(page);
  await page.goto("/design");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("loopback-demo-fixture");
  expect(html).not.toContain("The Evidence Ledger");
  await openNav(page);
  await expect(page.getByRole("link", { name: "Design reference" })).toHaveCount(0);
});

test("no read API: an honest error, nothing simulated", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByText("Cannot reach the read API")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a failed refresh keeps the last data, clearly marked as not current", async ({ page }) => {
  let calls = 0;
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/v1/cases", async (route) => {
    calls += 1;
    if (calls === 1) await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope([caseSummary()])) });
    else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "UNAVAILABLE", message: "x" } }) });
  });
  await page.goto("/cases");
  await expect(page.getByRole("link", { name: "LB-042" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/unavailable: the latest refresh \(showing data from/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "LB-042" })).toBeVisible();
});
