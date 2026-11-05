import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route } from "@playwright/test";
import { happyApi } from "../test-fixtures/api.ts";

export interface Mocked { readonly status?: number; readonly body: unknown }

/**
 * Serves the read API from test fixtures. Unknown API paths answer 404. Every request is recorded so tests can
 * assert that the console only issues same-origin GETs (fonts are self-hosted; there is no CDN or write path).
 */
export async function mockApi(page: Page, overrides: Readonly<Record<string, Mocked>> = {}) {
  const table: Record<string, Mocked> = { ...Object.fromEntries(Object.entries(happyApi()).map(([k, body]) => [k, { body }])), ...overrides };
  const apiMethods: string[] = [];
  const foreign: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.protocol !== "data:" && url.host !== "127.0.0.1:4179") foreign.push(req.url());
  });
  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    apiMethods.push(route.request().method());
    const hit = table[url.pathname];
    await route.fulfill({
      status: hit?.status ?? (hit ? 200 : 404),
      contentType: "application/json",
      body: JSON.stringify(hit?.body ?? { success: false, error: { code: "NOT_FOUND", message: "no route" } }),
    });
  });
  return { apiMethods, foreign };
}

/** Full axe run in a real browser, including colour contrast (which jsdom cannot evaluate). */
export async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const violations = result.violations.map((v) => `${v.id} (${v.impact ?? "?"}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(violations).toEqual([]);
}

/** No horizontal page scroll (WCAG 1.4.10 reflow at the tested widths). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

export const isNarrow = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 1024;

/** Opens the primary navigation on narrow screens (it is always visible on wide screens). */
export async function openNav(page: Page): Promise<void> {
  if (isNarrow(page)) await page.getByRole("button", { name: "Open navigation" }).click();
}
