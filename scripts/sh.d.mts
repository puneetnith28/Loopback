// Types for scripts/sh.mjs (imported by the tests).
type Env = Readonly<Record<string, string | undefined>>;
export function bashCandidates(env: Env, gitExecPath?: string): string[];
export function findBash(platform?: string, env?: Env, exists?: (path: string) => boolean, execPath?: () => string): string | null;
export function isMainModule(metaUrl: string, argv1?: string, platform?: string): boolean;
