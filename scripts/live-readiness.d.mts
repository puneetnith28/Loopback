// Types for scripts/live-readiness.mjs (imported by the tests).
export interface ReadinessItem { group: string; ok: boolean; text: string; owner: string }
export interface ReadinessFacts {
  env: Record<string, string>; keyModes: Record<string, number | null>; daemon: boolean; containers: string[];
  credFiles: Record<string, { mode: number; names: string[] } | null>; tagRuleset: boolean | null; signerKeyMatch?: boolean | null;
}
export const REQUIRED: Readonly<Record<string, string[]>>;
export const FLAGS: readonly string[];
export const CONTAINERS: readonly string[];
export function assessReadiness(facts: ReadinessFacts): ReadinessItem[];
export function spkiOf(text: string): string | null;
