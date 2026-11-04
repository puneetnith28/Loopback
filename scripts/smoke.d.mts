// Types for scripts/smoke.mjs (imported by the tests).
export function smoke(port: number, fetchFn?: typeof fetch): Promise<{ code: number; lines: string[] }>;
