import type { z } from "zod";
import { ErrorEnvelope, successEnvelope, type ResponseMeta } from "./schemas.ts";

/**
 * The one way the console talks to the read API: same-origin GET only, no credentials beyond the same-origin
 * session cookie, no write methods (DESIGN.md §5, backend-api-requirements.md R4). Every response is validated;
 * every failure becomes an ApiError with a kind the UI knows how to explain.
 */
export const API_BASE = "/api/v1";

export type ApiErrorKind = "network" | "permission" | "not-found" | "server" | "http" | "invalid-response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Machine code from the API error envelope, when it sent one. */
  readonly code: string | null;
  /** Schema paths that failed validation (never values, which may be untrusted). */
  readonly issues: readonly string[];

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number | null; code?: string | null; issues?: readonly string[] } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.issues = opts.issues ?? [];
  }
}

export interface ApiResult<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}

export type QueryParams = Readonly<Record<string, string | number | readonly string[] | null | undefined>>;

export interface GetOptions {
  readonly signal?: AbortSignal | undefined;
  readonly query?: QueryParams;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

const SAFE_PATH = /^\/[a-z0-9-]+(\/[A-Za-z0-9-]+)*$/;

/** Builds a same-origin API URL. Paths are fixed strings from the console, never user text. */
export function apiUrl(path: string, query: QueryParams = {}): string {
  if (!SAFE_PATH.test(path)) throw new Error(`invalid API path: ${path}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const search = params.toString();
  return `${API_BASE}${path}${search ? `?${search}` : ""}`;
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  return "http";
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new ApiError("invalid-response", "The API did not return JSON.", { status: response.status });
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ApiError("invalid-response", "The API returned malformed JSON.", { status: response.status });
  }
}

function issuePaths(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((i) => (i.path.length > 0 ? i.path.join(".") : "(root)"));
}

/**
 * GET + validate. Aborts propagate unchanged (AbortError), so a cancelled request is never reported as a failure.
 */
export async function apiGet<S extends z.ZodType>(path: string, schema: S, opts: GetOptions = {}): Promise<ApiResult<z.infer<S>>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(apiUrl(path, opts.query), {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: opts.signal ?? null,
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new ApiError("network", "The read API could not be reached.");
  }

  if (!response.ok) {
    let code: string | null = null;
    try {
      const parsed = ErrorEnvelope.safeParse(await response.json());
      if (parsed.success) code = parsed.data.error.code;
    } catch {
      // A non-JSON error body is fine: the status code is enough.
    }
    throw new ApiError(kindForStatus(response.status), `The read API answered ${response.status}.`, { status: response.status, code });
  }

  const body = await readJson(response);
  const parsed = successEnvelope(schema).safeParse(body);
  if (!parsed.success) {
    throw new ApiError("invalid-response", "The API returned data the console could not validate.", {
      status: response.status,
      issues: issuePaths(parsed.error),
    });
  }
  // zod cannot carry the generic `data` type through the envelope; the schema above has just validated it.
  const envelope = parsed.data as { readonly data: z.infer<S>; readonly meta: ResponseMeta };
  return { data: envelope.data, meta: envelope.meta };
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
