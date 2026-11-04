// Types for scripts/verify-isolation.mjs (a stand-alone Node script, imported by the tests).
export interface CheckResult { readonly level: "pass" | "fail" | "info"; readonly text: string }
export interface RoleSpec {
  readonly uid: number; readonly container: string; readonly proxy: string; readonly network: string; readonly volume: string; readonly home: string;
  readonly networks: readonly string[]; readonly volumes: Readonly<Record<string, readonly [string, boolean]>>;
}
export interface ProxyExpectation { readonly host: string; readonly port: number; readonly allowed: boolean | null }
type Role = "fixer" | "verifier";

export const EGRESS_NETWORK: string;
export const SIGNER_NETWORK: string;
export const SIGNER_EGRESS_NETWORK: string;
export const JOBS_VOLUME: string;
export const RESULTS_VOLUME: string;
export const SIGNER: Readonly<{ uid: number; container: string; proxy: string; volume: string; home: string; keyFile: string; tokenFile: string; networks: readonly string[] }>;
export const RUNNER: Readonly<{ uid: number; container: string; jobs: string; results: string }>;
export const PROXY_NETWORK: Readonly<{ fixer: string; verifier: string; signer: string }>;
export const PROXY_URL: string;
export const ROLES: Readonly<{ fixer: RoleSpec; verifier: RoleSpec }>;
export const ROOTFUL_SOCKETS: readonly string[];
export const DIRECT_PROBES: readonly { host: string; port: number; what: string }[];
export const NO_ROUTE: readonly string[];
export const NOT_REACHABLE_BY_NAME: readonly string[];
export const PROXY_DENIED: number;

export const DESKTOP_HOST_NAMES: readonly string[];
export function githubGetOptions(path: string, token: string): { host: string; path: string; method: string; timeout: number; headers: Record<string, string> };
export function assessDaemon(dockerInfo: unknown, dockerHost: string | undefined, expectedSocket: string | undefined): CheckResult[];
export function assessDesktopDaemon(dockerInfo: unknown, dockerHost: string | undefined): CheckResult[];
export function assessContainer(roleName: Role, container: unknown, network: unknown): CheckResult[];
export function assessProxy(roleName: Role | "signer", container: unknown): CheckResult[];
export function assessSigner(container: unknown, signerNet: unknown, egressNet: unknown): CheckResult[];
export function assessRunner(container: unknown): CheckResult[];
export function assessVolumeOwnership(containers: unknown[]): CheckResult[];
export function assessVolumes(volumes: unknown[] | undefined): CheckResult[];
export function assessSeparation(fixer: unknown, verifier: unknown): CheckResult[];
export function parseProcStatus(text: string): { capEff: bigint | null; noNewPrivs: boolean };
export function rootIsReadOnly(mountinfo: string): boolean;
export function mountIsReadOnly(mountinfo: string, point: string): boolean;
export function proxyExpectations(roleName: Role, nonce?: string): ProxyExpectation[];
export function connectAsExpected(status: number | string, allowed: boolean): boolean;
export function main(argv?: string[], out?: (line: string) => void): Promise<number>;
