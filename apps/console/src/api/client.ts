import type { z } from "zod";
import { ApiError as WireApiError } from "@loopback/console-contracts";
import { ErrorEnvelope, type ResponseMeta } from "./schemas.ts";

/**
 * The one way the console talks to the read API: same-origin GET only, no credentials beyond the same-origin
 * session cookie or local dev Bearer token, no write methods (DESIGN.md §5, backend-api-requirements.md R4).
 * Every response is validated; every failure becomes an ApiError with a kind the UI knows how to explain.
 */
export const API_BASE = "/api/v1";

const DEFAULT_MOCK_TOKEN = "loopback-console-mock-token-not-a-secret";
const getAuthToken = (): string => {
  try {
    const envVal: unknown = typeof import.meta !== "undefined" && import.meta.env ? (import.meta.env as Record<string, unknown>).VITE_CONSOLE_API_TOKEN : undefined;
    return typeof envVal === "string" && envVal ? envVal : DEFAULT_MOCK_TOKEN;
  } catch {
    return DEFAULT_MOCK_TOKEN;
  }
};

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

function kindForStatus(status: number, code: string | null = null): ApiErrorKind {
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || status === 401 || status === 403) return "permission";
  if (code === "NOT_FOUND" || status === 404) return "not-found";
  if (code === "DATABASE_UNAVAILABLE" || code === "SCHEMA_MISMATCH" || status >= 500) return "server";
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
  const token = getAuthToken();
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await doFetch(apiUrl(path, opts.query), {
      method: "GET",
      headers,
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
      const raw: unknown = await response.json();
      const wire = WireApiError.safeParse(raw);
      if (wire.success) {
        code = wire.data.error.code;
      } else {
        const parsed = ErrorEnvelope.safeParse(raw);
        if (parsed.success) code = parsed.data.error.code;
      }
    } catch {
      // A non-JSON error body is fine: the status code is enough.
    }
    throw new ApiError(kindForStatus(response.status, code), `The read API answered ${response.status}.`, { status: response.status, code });
  }

  const body = await readJson(response);

  // If wrapped in legacy proposal envelope ({ success: true, data, meta })
  if (typeof body === "object" && body !== null && "success" in body && body.success === true && "data" in body) {
    const envelopeBody = body as { data: unknown; meta?: Partial<ResponseMeta> };
    const parsed = schema.safeParse(envelopeBody.data);
    if (!parsed.success) {
      throw new ApiError("invalid-response", "The API returned data the console could not validate.", {
        status: response.status,
        issues: issuePaths(parsed.error).map((p) => (p === "(root)" ? "data" : `data.${p}`)),
      });
    }
    const meta: ResponseMeta = {
      generatedAt: envelopeBody.meta?.generatedAt ?? new Date().toISOString(),
      nextCursor: envelopeBody.meta?.nextCursor ?? null,
      unavailable: envelopeBody.meta?.unavailable ?? [],
    };
    return { data: parsed.data, meta };
  }

  // A failure envelope with 200 OK is rejected as invalid response
  if (typeof body === "object" && body !== null && "success" in body && body.success === false) {
    throw new ApiError("invalid-response", "The API returned an unexpected error format.", { status: response.status });
  }

  // Canonical wire response (naked JSON from @loopback/console-contracts on real API endpoints)
  const isWireEndpoint = path !== "/overview" && path !== "/config/summary" && path !== "/status";
  const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const isWireBody = obj !== null && (
    "items" in obj || "generatedAt" in obj || "checkedAt" in obj || "apiVersion" in obj || "repository" in obj || ("status" in obj && obj.status === "ok")
  );

  if (!isWireEndpoint || !isWireBody) {
    throw new ApiError("invalid-response", "The API returned data without an expected envelope or wire contract.", {
      status: response.status,
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("invalid-response", "The API returned data the console could not validate.", {
      status: response.status,
      issues: issuePaths(parsed.error),
    });
  }

  const generatedAt =
    (typeof obj.generatedAt === "string" && obj.generatedAt) ||
    (typeof obj.checkedAt === "string" && obj.checkedAt) ||
    (typeof obj.updatedAt === "string" && obj.updatedAt) ||
    (typeof obj.stateEnteredAt === "string" && obj.stateEnteredAt) ||
    new Date().toISOString();
  const nextCursor = typeof obj.nextCursor === "string" ? obj.nextCursor : null;
  const unavailable = Array.isArray(obj.unavailable) ? (obj.unavailable as string[]) : [];

  const meta: ResponseMeta = {
    generatedAt,
    nextCursor,
    unavailable,
  };

  return { data: parsed.data, meta };
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
