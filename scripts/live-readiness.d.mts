// Types for scripts/live-readiness.mjs (imported by the tests).
export interface GateConfigIssue { scope: "current" | "isolated"; group?: string; variable: string; message: string }
export interface GateRules {
  ConfigError: new (...args: never[]) => Error & { issues: readonly { variable: string; message: string }[] };
  loadSwitchConfig(env: Record<string, string | undefined>): unknown;
  loadIdentityConfig(env: Record<string, string | undefined>): { runIssuerKeyPath: string | null };
  loadGitHubConfig(env: Record<string, string | undefined>): unknown;
  loadRuntimeConfig(env: Record<string, string | undefined>): unknown;
  assertIdentityConsistency(sw: never, id: never): void;
  loadRunIssuerKey(path: string): unknown;
}
export interface ReadinessItem { group: string; ok: boolean; text: string; owner: string }
/** A POSIX mode, or on Windows the problem found in the file's ACL (null = none). */
export type FilePrivacy = number | { aclProblem: string | null };
export interface ReadinessFacts {
  env: Record<string, string>; keyModes: Record<string, FilePrivacy | null>; daemon: boolean; desktop?: boolean; containers: string[];
  tools?: Record<string, boolean>;
  credFiles: Record<string, { mode: FilePrivacy; names: string[] } | null>; tagRuleset: boolean | null; signerKeyMatch?: boolean | null;
  gateConfig?: { available: boolean; reason?: string; issues: GateConfigIssue[]; ran?: Record<string, boolean> };
}
export const REQUIRED: Readonly<Record<string, string[]>>;
export const FLAGS: readonly string[];
export const CONTAINERS: readonly string[];
export function assessReadiness(facts: ReadinessFacts): ReadinessItem[];
export function isDesktopDaemon(infoLine: string): boolean;
export function spkiOf(text: string): string | null;
export function parseEnvText(text: string): Record<string, string>;
export function evaluateGateConfig(env: Record<string, string | undefined>, rules: GateRules, opts: { root: string }): { issues: GateConfigIssue[]; ran: Record<string, boolean> };
export const RULE_EXPORTS: readonly string[];
export function rulesUsable(mod: unknown, distMtimeMs: number, sourceMtimesMs: number[]): { ok: true } | { ok: false; reason: "stale" | "incomplete" };
export function parseEnvFile(text: string): Record<string, string>;
