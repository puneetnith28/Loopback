// Types for scripts/live-readiness.mjs (imported by the tests).
export interface ReadinessItem { group: string; ok: boolean; text: string; owner: string }
/** A POSIX mode, or on Windows the problem found in the file's ACL (null = none). */
export type FilePrivacy = number | { aclProblem: string | null };
export interface ReadinessFacts {
  env: Record<string, string>; keyModes: Record<string, FilePrivacy | null>; daemon: boolean; desktop?: boolean; containers: string[];
  tools?: Record<string, boolean>;
  credFiles: Record<string, { mode: FilePrivacy; names: string[] } | null>; tagRuleset: boolean | null; signerKeyMatch?: boolean | null;
}
export const REQUIRED: Readonly<Record<string, string[]>>;
export const FLAGS: readonly string[];
export const CONTAINERS: readonly string[];
export function assessReadiness(facts: ReadinessFacts): ReadinessItem[];
export function isDesktopDaemon(infoLine: string): boolean;
export function spkiOf(text: string): string | null;
export function parseEnvText(text: string): Record<string, string>;
