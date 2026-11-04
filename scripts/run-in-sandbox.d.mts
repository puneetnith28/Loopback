// Types for scripts/run-in-sandbox.mjs (imported by the tests).
export interface SandboxResult {
  ok: boolean; error?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; durationMs?: number;
  stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean;
}
export function submitJob(o: { jobsDir: string; tree: string; argv: unknown[]; timeoutSec: number }): string;
export function awaitResult(o: { resultsDir: string; id: string; timeoutMs: number; pollMs?: number }): Promise<SandboxResult>;
