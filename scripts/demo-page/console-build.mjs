// Builds the real evidence console into one HTML document, for the demo page's frame. Only two things differ
// from a normal build, both applied here so that apps/console itself stays unchanged:
//  - its location store reads from the frame's stand-in, because a frame's document has no path to route on;
//  - its query client is reachable, so the page can refresh it when the step changes.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = join(here, "..", "..", "apps", "console");
const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap";

const EDITS = [
  { file: /app[\\/]router\.tsx$/, from: "window.location.pathname", to: "__demoLocation.pathname" },
  { file: /app[\\/]router\.tsx$/, from: "window.location.search", to: "__demoLocation.search" },
  { file: /app[\\/]router\.tsx$/, from: "window.location.origin", to: "__demoLocation.origin" },
  { file: /app[\\/]router\.tsx$/, from: 'window.history.replaceState(null, "", href)', to: "__demoLocation.go(href)" },
  { file: /app[\\/]router\.tsx$/, from: 'window.history.pushState(null, "", href)', to: "__demoLocation.go(href)" },
  { file: /api[\\/]queries\.ts$/, from: "return new QueryClient({", to: "return window.__demoQueryClient = new QueryClient({" },
];

/** A script's text, safe to place inside a script tag. */
const inScript = (code) => code.replace(/<\/script/gi, "<\\/script");

/** The console as one document, with the recording and the stand-in in front of it. */
export async function buildConsoleDocument(recording) {
  const { build } = await import("vite");
  const applied = new Set();
  const outDir = mkdtempSync(join(tmpdir(), "loopback-console-"));
  try {
    await build({
      root: consoleRoot,
      configFile: join(consoleRoot, "vite.config.ts"),
      mode: "production",
      logLevel: "error",
      plugins: [{
        name: "loopback-demo-frame",
        enforce: "pre",
        transform(code, id) {
          let out = code;
          for (const edit of EDITS) {
            if (edit.file.test(id.split("?")[0]) && out.includes(edit.from)) {
              out = out.replaceAll(edit.from, edit.to);
              applied.add(edit.from);
            }
          }
          return out === code ? null : out;
        },
      }],
      build: { outDir, emptyOutDir: true, assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false },
    });
    const missing = EDITS.filter((e) => !applied.has(e.from)).map((e) => e.from);
    if (missing.length > 0) throw new Error(`the console changed, and these edits no longer apply: ${missing.join("; ")}`);

    const assets = readdirSync(join(outDir, "assets"));
    const scripts = assets.filter((a) => a.endsWith(".js"));
    const styles = assets.filter((a) => a.endsWith(".css"));
    if (scripts.length !== 1 || styles.length !== 1) throw new Error(`expected one script and one stylesheet, got ${assets.join(", ")}`);
    const js = readFileSync(join(outDir, "assets", scripts[0]), "utf8");
    const css = readFileSync(join(outDir, "assets", styles[0]), "utf8");
    const shim = readFileSync(join(here, "console-shim.js"), "utf8");
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      '<base href="https://console.loopback.invalid/">',
      `<link rel="stylesheet" href="${FONTS}">`,
      `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`,
      "</head><body><div id=\"root\"></div>",
      `<script type="application/json" id="lb-recording">${JSON.stringify(recording).replace(/</g, "\\u003c")}</script>`,
      `<script>${inScript(shim)}</script>`,
      `<script type="module">${inScript(js)}</script>`,
      "</body></html>",
    ].join("");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
