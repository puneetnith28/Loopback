// Types for scripts/sandbox-runner.mjs (imported by the tests).
export const MAX_OUTPUT_BYTES: number;
export const MAX_TIMEOUT_SEC: number;
export const JOB_ID: RegExp;
export function validateJob(raw: unknown): { argv: string[]; timeoutSec: number } | null;
export const RESULT_TTL_MS: number;
export function pruneResults(resultsDir: string, nowMs: number): void;
export function forceRemove(path: string): void;
export function processPending(o: { jobsDir: string; resultsDir: string; workDir: string; env: Record<string, string | undefined> }): Promise<void>;
