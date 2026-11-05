// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WCAG 2.2 AA contrast for every text/background pairing the components use, in BOTH themes, computed from the
// single token source. (jsdom cannot evaluate contrast; this checks the design system itself.)

const css = readFileSync(fileURLToPath(new URL("../src/design-system/tokens.css", import.meta.url)), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

type RGBA = [number, number, number, number];
function parse(v: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) { const n = parseInt(hex[1]!, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const rgba = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unparsed colour ${v}`);
}
const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };

const themes = { dark: block(":root,\n[data-theme=\"dark\"]"), light: block("[data-theme=\"light\"]") };
const TEXT = ["--color-text", "--color-text-secondary", "--color-text-tertiary"];
const BACKGROUNDS = ["--color-canvas", "--color-surface", "--color-raised", "--color-overlay", "--color-inset"];
const TONES = ["machine", "human", "success", "danger", "demo"];

describe.each(Object.entries(themes))("%s theme", (_name, t) => {
  const c = (token: string) => { const v = t[token]; if (!v) throw new Error(`missing ${token}`); return parse(v); };

  it("defines every semantic token the components use", () => {
    for (const k of [...TEXT, ...BACKGROUNDS, "--color-accent", "--color-accent-text", "--color-focus", "--color-border"]) expect(t[k], k).toBeDefined();
    for (const tone of TONES) for (const s of ["", "-text", "-surface", "-border"]) expect(t[`--color-${tone}${s}`], `${tone}${s}`).toBeDefined();
  });

  it.each(TEXT.flatMap((fg) => BACKGROUNDS.map((bg) => [fg, bg] as const)))("text %s on %s meets 4.5:1", (fg, bg) => {
    expect(ratio(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TONES.flatMap((tone) => ["--color-canvas", "--color-surface", "--color-raised"].map((bg) => [tone, bg] as const)))("tone %s text on its tinted surface over %s meets 4.5:1", (tone, bg) => {
    const base = c(bg);
    expect(ratio(c(`--color-${tone}-text`), over(c(`--color-${tone}-surface`), base))).toBeGreaterThanOrEqual(4.5);
  });

  it("primary action text meets 4.5:1 and the focus ring meets 3:1 against every background", () => {
    expect(ratio(c("--color-accent-text"), c("--color-accent"))).toBeGreaterThanOrEqual(4.5);
    for (const bg of BACKGROUNDS) expect(ratio(c("--color-focus"), c(bg)), bg).toBeGreaterThanOrEqual(3);
  });

  it("status hues are distinguishable from the canvas as non-text UI (3:1)", () => {
    for (const tone of TONES) expect(ratio(c(`--color-${tone}`), c("--color-canvas")), tone).toBeGreaterThanOrEqual(3);
  });
});

it("the light theme is tuned independently, not an inversion of the dark theme", () => {
  expect(themes.light["--color-canvas"]).not.toBe(themes.dark["--color-text"]);
  expect(themes.light["--color-machine"]).not.toBe(themes.dark["--color-machine"]);
});
