// Types for scripts/build-demo-page.mjs (imported by the tests).
import type { RehearsalEvent } from "../apps/switch-gate/src/demo/rehearsal.js";

export interface PageTable { header: string[]; rows: string[][] }
export interface PageScene {
  title: string;
  items: Extract<RehearsalEvent, { kind: "chat" | "github" }>[];
  checks: { claim: string; held: boolean }[];
  state: { state: string | null; commit: string | null; ci: string | null; verifier: string | null; approvals: number } | null;
}
export interface PageData { scenes: PageScene[]; tables: { board: PageTable; decisions: PageTable } | null; held: number; total: number; videoUrl: string }
export function buildPageData(events: readonly RehearsalEvent[], videoUrl?: string): PageData;
export function renderPage(template: string, data: PageData): string;
