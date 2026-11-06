#!/usr/bin/env node
// Regenerates the README's screenshots from the built demo page, in a real browser.
//   npm run demo:page && node scripts/demo-page/screenshots.mjs
// Needs Playwright's Chromium (installed with the console's dev dependencies: npx playwright install chromium).
/* global document */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "docs", "screenshots");
const { chromium } = await import("playwright");

// The page is written without a document skeleton, as the host adds one. Add the same one here.
const dir = mkdtempSync(join(tmpdir(), "loopback-shots-"));
const page = join(dir, "page.html");
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${readFileSync(join(root, "docs", "demo", "loopback-demo.html"), "utf8")}</body></html>`);
const url = pathToFileURL(page).href;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: "dark" });
  await tab.goto(url);
  await tab.waitForTimeout(2200);
  await tab.screenshot({ path: join(out, "demo-title.png") });

  await tab.evaluate(() => document.getElementById("circuit").scrollIntoView({ block: "start", behavior: "instant" }));
  await tab.waitForTimeout(3600);
  await tab.screenshot({ path: join(out, "demo-switch-on.png") });
  await tab.locator("#dgm-hero .knob").click();
  await tab.waitForTimeout(1300);
  await tab.screenshot({ path: join(out, "demo-switch-off.png") });
  await tab.locator("#dgm-hero .knob").click();

  await tab.goto(`${url}#step-late`);
  await tab.waitForTimeout(500);
  await tab.locator(".todo button").click();
  await tab.keyboard.press("Enter");
  await tab.waitForTimeout(2200);
  await tab.screenshot({ path: join(out, "demo-late-commit.png") });
  process.stdout.write(`wrote 4 screenshots to ${out}\n`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
