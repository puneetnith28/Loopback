// Types for scripts/host-agent-tool.mjs (imported by the tests).
export function roleToken(text: string): string | null;
export function testPlan(sha: string | undefined, argv: string[]): { dir: string; command: string[] } | null;
export function diffPlan(base: string | undefined, head: string | undefined): string[] | null;
