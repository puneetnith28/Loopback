#!/usr/bin/env node
// Plays the built demo page in a real browser and fails if it is broken anywhere a judge could look:
// the title page fits the first screen at every width, no chapter scrolls sideways, all 21 steps can be
// typed through to Merged at desktop, tablet and phone sizes, Switch off stops everything, and the real
// console in the frame shows the gate's recorded settings.
//   npm run demo:page && npm run demo:check
// Needs Playwright's Chromium (npx playwright install chromium). Exit code 1 lists every problem found.

/* global document, window, location, getComputedStyle */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chromium } = await import("playwright");
// The page is checked exactly as someone opening the file sees it: its own doctype, viewport and
// base rules. It used to be a fragment that whatever embedded it had to complete, which meant the
// file in docs/demo/ opened in quirks mode with every chapter visible at once.
const file = join(root, "docs", "demo", "loopback-demo.html");
const built = readFileSync(file, "utf8");
for (const [needed, why] of [
  ["<!doctype html>", "a browser would open it in quirks mode"],
  ['name="viewport"', "it would not lay out on a phone"],
  ["[hidden]", "every chapter would show at once"],
]) {
  if (!built.toLowerCase().includes(needed.toLowerCase())) {
    process.stderr.write(`demo page: ${needed} missing - ${why}. Rebuild with npm run demo:page\n`);
    process.exit(1);
  }
}
const url = pathToFileURL(file).href;
const problems = [];
const problem = (where, what) => problems.push(`${where}: ${what}`);
const CHAPTERS = ["what", "setup", "run", "without", "built"];

const browser = await chromium.launch();
const open = async (w, h, at = "") => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => problem(`${w}px`, `script error: ${e.message}`));
  await page.goto(`${url}${at}`);
  // As a viewer sees it: web fonts loaded, and the title page's entrance finished.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1600);
  return page;
};
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

try {
  // 1. The title page and every chapter, from a small phone to a large monitor.
  for (const [w, h] of [[2560, 1300], [1920, 1080], [1366, 768], [1024, 768], [820, 1180], [400, 860], [360, 740], [320, 640]]) {
    const page = await open(w, h);
    const fit = await page.evaluate(() => {
      const b = (s) => document.querySelector(s).getBoundingClientRect();
      const wrap = b("#mark-wrap");
      return { cta: b("#run-cta").bottom, knob: b(".intro-knob .knob").bottom, wrapInside: wrap.left >= 0 && wrap.right <= window.innerWidth };
    });
    if (fit.cta > h) problem(`${w}x${h}`, "the Run the demo button is below the first screen");
    if (fit.knob > h) problem(`${w}x${h}`, "the title page's Switch is below the first screen");
    if (!fit.wrapInside) problem(`${w}x${h}`, "the name and its loop are wider than the screen");
    for (const c of CHAPTERS) {
      await page.evaluate((x) => { location.hash = `#${x}`; }, c);
      await page.waitForTimeout(150);
      const extra = await sideways(page);
      if (extra > 0) problem(`${w}px`, `the ${c} chapter scrolls sideways by ${extra}px`);
    }
    await page.close();
  }

  // 2. The whole run, typed, at three sizes, then Switch off.
  for (const [w, h] of [[1366, 860], [820, 1180], [400, 860]]) {
    const page = await open(w, h, "#run");
    const total = await page.locator("#jump option").count();
    for (let n = 0; n < total; n++) {
      const button = page.locator(".todo button");
      if ((await button.innerText()) === "Fill it in for me") {
        await button.click();
        await page.keyboard.press("Enter");
      } else await page.click("#happen");
      if ((await sideways(page)) > 0) problem(`${w}px`, `step ${n + 1} scrolls sideways`);
      if (n < total - 1) await page.locator("#next").click();
    }
    const end = await page.locator("#sha").innerText();
    if (!/Merged/.test(end)) problem(`${w}px`, `the run ended at "${end}", not Merged`);
    await page.locator("#rr .knob").click();
    await page.waitForTimeout(300);
    await page.click('#tabs [data-tab="chat"]');
    await page.locator("#input").fill("@loopback-gate report anything");
    await page.keyboard.press("Enter");
    if ((await page.locator(".undelivered").count()) !== 1) problem(`${w}px`, "with Switch off, a sent message was not shown as undelivered");
    if ((await page.locator("#sha").innerText()) !== "No case yet") problem(`${w}px`, "with Switch off, the evidence panel still shows a case");
    await page.close();
  }

  // 3. The late commit in the real console, and the settings the gate recorded.
  {
    const page = await open(1366, 860, "#step-late");
    await page.locator(".todo button").click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await page.locator("#after .actions button.btn:not(.primary)").click();
    const frame = page.frameLocator("iframe.frame");
    await frame.locator("main").waitFor({ timeout: 20000 });
    await page.waitForTimeout(900);
    const caseText = await frame.locator("main").innerText();
    if (!/Verifying/.test(caseText)) problem("console", "after the late commit the case is not back at Verifying");
    await frame.getByRole("link", { name: "System" }).first().click().catch(async () => {
      await frame.locator("header button").first().click();
      await frame.getByRole("link", { name: "System" }).first().click();
    });
    await page.waitForTimeout(900);
    const system = await frame.locator("main").innerText();
    if (!/Advisory/.test(system)) problem("console", "the System page does not show advisory verification");
    if (/Isolated \(signed reports required\)/.test(system)) problem("console", "the System page claims isolated verification");
    await page.close();
  }

  // 4. Reduced motion: nothing animates, and everything is still there.
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(400);
    const flow = await page.evaluate(() => { const p = document.querySelector("#dgm-hero .w-flow"); return p ? getComputedStyle(p).display : "none"; });
    if (flow !== "none") problem("reduced motion", "the wire animation still runs");
    if ((await page.locator("#dgm-hero .mposts > *").count()) === 0) problem("reduced motion", "the room's messages are missing");
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (problems.length > 0) {
  process.stderr.write(`${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("demo page checked: 8 widths, 3 full runs, Switch off, the console, reduced motion. No problems.\n");
}
