// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_SENTINEL } from "../src/demo/fixtures.ts";

// A production build must contain no demonstration fixtures and no design reference, and must not
// reference any external font or CDN host (fonts are self-hosted).

const root = fileURLToPath(new URL("..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "loopback-console-prod-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
}

describe("production build isolation", () => {
  it("excludes demo fixtures and the design page, and loads nothing from external hosts", async () => {
    await build({ root, mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    const emitted = files(out);
    const text = emitted.filter((f) => /\.(js|css|html)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(text).not.toContain(DEMO_SENTINEL);
    expect(text).not.toContain("The Evidence Ledger");
    // Test fixtures (test-fixtures/, e2e/, tests/) never reach a build either.
    expect(text).not.toContain("acme/widgets");
    expect(text).not.toContain("formatToken throws TypeError");
    expect(text).not.toContain("e804775a5938f9afe55fa5321875735734e3e1a5");
    expect(emitted.some((f) => /DesignPage/.test(f))).toBe(false);
    expect(text).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com/);
    expect(emitted.filter((f) => f.endsWith(".woff2")).length).toBeGreaterThanOrEqual(5);
  }, 120_000);
});
