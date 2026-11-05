import { cleanup } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, expect, vi } from "vitest";

const hasDom = typeof document !== "undefined";
afterEach(() => {
  if (!hasDom) return; // node-environment tests (build, token files) have no DOM
  cleanup();
  document.documentElement.setAttribute("data-theme", "dark");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

// jsdom gaps (documented): <dialog> modality and clipboard are browser features.
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
}
if (hasDom) Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => Promise.resolve()) } });

/**
 * axe in jsdom. `color-contrast` is disabled here because jsdom has no CSS engine; contrast of every token pair
 * is computed directly from tokens.css in tests/tokens.test.ts instead.
 */
export async function expectAccessible(node: Element): Promise<void> {
  const result = await axe.run(node, { rules: { "color-contrast": { enabled: false } } });
  const violations = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(violations).toEqual([]);
}
