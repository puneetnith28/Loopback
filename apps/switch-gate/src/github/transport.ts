import { createSign } from "node:crypto";

// Low-level GitHub REST transport (D24): App JWT + installation token, explicit
// timeouts and error classification. Only github/* modules may import this file.

export const API = "https://api.github.com";
export const API_VERSION = "2022-11-28";
export const REQUEST_TIMEOUT_MS = 10_000;

export class GitHubError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "GitHubError";
  }
}
/** 409 on merge: the head moved, so GitHub refused the `sha` precondition. */
export class HeadChanged extends GitHubError {}
/** 405 on merge: rules not satisfied or otherwise not mergeable. */
export class NotMergeable extends GitHubError {}
/** Timeout, network failure or 5xx: the outcome of a write is unknown. */
export class Uncertain extends GitHubError {}
export class RateLimited extends GitHubError {
  constructor(message: string, status: number, readonly retryAfterSeconds: number) {
    super(message, status);
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface AppCredentials {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyPem: string;
}

export interface TransportOptions {
  readonly fetch?: FetchFn;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxReadRetries?: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60; // clock-skew allowance, per GitHub docs
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

function retryAfter(res: Response): number {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return ra;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return 60;
}

function isRateLimited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
}

export class GitHubTransport {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxReadRetries: number;

  constructor(private readonly creds: AppCredentials, opts: TransportOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxReadRetries = opts.maxReadRetries ?? 3;
  }

  private headers(auth: string): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "loopback-gate",
      Authorization: `Bearer ${auth}`,
    };
  }

  private async installationToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 5 * 60_000 > this.now()) return this.token.value;
    const jwt = signAppJwt(this.creds.appId, this.creds.privateKeyPem, this.now());
    const res = await this.raw("POST", `/app/installations/${this.creds.installationId}/access_tokens`, undefined, jwt);
    if (!res.ok) throw new GitHubError(`installation token request failed (${res.status})`, res.status);
    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GitHubError("installation token response malformed", res.status);
    }
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  private async raw(method: string, path: string, body: unknown, auth: string): Promise<Response> {
    try {
      return await this.fetchFn(`${API}${path}`, {
        method,
        headers: { ...this.headers(auth), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      // Never surface the error object: it may include request details.
      throw new Uncertain(`${method} ${path.split("?")[0]} failed: network error or timeout`, null);
    }
  }

  /** One authenticated request; refreshes the installation token once on 401. */
  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    let res = await this.raw(method, path, body, await this.installationToken());
    if (res.status === 401) res = await this.raw(method, path, body, await this.installationToken(true));
    if (isRateLimited(res)) throw new RateLimited(`${method} rate limited`, res.status, retryAfter(res));
    return res;
  }

  /** GET with bounded retries for 5xx and network errors. Rate limits are surfaced, not waited on. */
  async getJson<T>(path: string, okStatuses: readonly number[] = [200]): Promise<{ status: number; body: T; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.send("GET", path);
        if (res.status >= 500) throw new Uncertain(`GET ${path.split("?")[0]} returned ${res.status}`, res.status);
        if (!okStatuses.includes(res.status)) throw new GitHubError(`GET ${path.split("?")[0]} returned ${res.status}`, res.status);
        return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T, headers: res.headers };
      } catch (e) {
        if (!(e instanceof Uncertain) || attempt + 1 >= this.maxReadRetries) throw e;
        await this.sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
  }

  /** A write. Never retried here: callers decide, and merges are never retried blindly. */
  async write(method: "POST" | "PUT" | "PATCH", path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await this.send(method, path, body);
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }
}
