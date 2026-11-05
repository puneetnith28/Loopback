// Types for scripts/build-demo-page.mjs (imported by the tests).
import type { RehearsalEvent } from "../apps/switch-gate/src/demo/rehearsal.js";

export interface PageTable { header: string[]; rows: string[][] }
export interface PageState { state: string | null; commit: string | null; ci: string | null; verifier: string | null; approvals: number }
export interface PageScene {
  title: string;
  items: Extract<RehearsalEvent, { kind: "chat" | "github" }>[];
  checks: { claim: string; held: boolean }[];
  state: PageState | null;
  lines: string[];
}
export interface PageStep {
  scene: number;
  kind: "person" | "agent" | "github" | "documents";
  who: string;
  room: string | null;
  text: string;
  senderId: string;
  replies: { room: string; text: string; refused: boolean }[];
  checks: { claim: string; held: boolean }[];
  state: PageState | null;
  snapshot: number;
}
export type RecordedEvent = RehearsalEvent | { kind: "checkpoint"; snapshot: number } | { kind: "print"; line: string };
export interface PageData { scenes: PageScene[]; steps: PageStep[]; tables: { board: PageTable; decisions: PageTable } | null; held: number; total: number; videoUrl: string }
export function buildSteps(events: readonly RecordedEvent[]): PageStep[];
export function buildPageData(events: readonly RecordedEvent[], videoUrl?: string): PageData;
export function renderPage(template: string, data: unknown, consoleDocument?: string): string;
export function cutExcerpt(source: string, excerpt: { title: string; note: string; file: string; from: RegExp; to: RegExp; after?: number }): { title: string; note: string; file: string; line: number; code: string };
export function templateFields(yaml: string): string[];
export function withRelativeTimes(text: string, recordedAt: number): string;
export function assertClean(label: string, text: string): void;
