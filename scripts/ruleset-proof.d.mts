// Types for scripts/ruleset-proof.mjs (imported by the tests).
export interface ApiResult { status: number; body?: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- GitHub's JSON, read defensively
export type Api = (actor: "owner" | "fixer", method: string, path: string, body?: unknown) => Promise<ApiResult>;
export interface Outcome { id: string; title: string; expected: string; actual: string; verdict: "PASS" | "FAIL" | "NOT RUN" }
export function validateInputs(i: { repo?: string; runBranch?: string; resetSha?: string }): string[];
export function runProof(api: Api, o: { repo: string; runBranch: string; resetSha: string; nonce: string; wait?: () => Promise<unknown>; now?: () => number; ciWaitMs?: number }): Promise<{ outcomes: Outcome[]; pr: number | null }>;
export function passed(outcomes: Outcome[]): boolean;
export function renderEvidence(i: { repo: string; runBranch: string; resetSha: string; when: string; outcomes: Outcome[]; pr: number | null }): string;
