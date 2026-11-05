import type { InfiniteData } from "@tanstack/react-query";
import type { Loadable } from "../lib/loadable.ts";
import { absoluteTime } from "../lib/format.ts";
import { sourceLabel } from "../lib/labels.ts";
import { isApiError, type ApiResult } from "./client.ts";
import type { ResponseMeta } from "./schemas.ts";

/** A successfully loaded value together with the response metadata (freshness, cursor, unavailable sources). */
export interface Loaded<T> {
  readonly value: T;
  readonly meta: ResponseMeta;
}

/** The subset of a TanStack query result the adapter needs (keeps it testable without a QueryClient). */
export interface QueryLike<D> {
  readonly status: "pending" | "error" | "success";
  readonly data: D | undefined;
  readonly error: unknown;
  readonly isRefetchError: boolean;
  readonly refetch: () => unknown;
}

export interface LoadOptions<T> {
  /** Human name of what is being loaded, e.g. "cases" or "case LB-042". */
  readonly resource: string;
  readonly isEmpty?: (value: T) => boolean;
  readonly empty?: { readonly title: string; readonly detail: string };
}

/** Maps a failure to a state the user can act on. Raw messages from the server are never shown. */
export function errorLoadable<T>(error: unknown, resource: string, retry: () => void): Loadable<T> {
  if (!isApiError(error)) {
    return { status: "error", title: `Could not load ${resource}`, detail: "An unexpected error occurred in the console.", retry };
  }
  switch (error.kind) {
    case "permission":
      return {
        status: "permission", boundary: "read API access",
        detail: `This session is not allowed to read ${resource}. Ask the Loopback operator for console access.`,
      };
    case "not-found":
      return { status: "error", title: `No ${resource}`, detail: "The read API has no record of it. Check the address; it may belong to another deployment." };
    case "network":
      return {
        status: "error", title: "Cannot reach the read API",
        detail: "The console shows only data served by the Loopback read API, and it did not respond. Nothing here is simulated.",
        retry,
      };
    case "server":
      return { status: "error", title: `The read API failed to load ${resource}`, detail: `It answered ${error.status ?? "with an error"}. Try again shortly.`, retry };
    case "invalid-response":
      return {
        status: "error", title: "The read API sent data the console could not validate",
        detail: `To avoid showing wrong evidence, nothing from this response is displayed.${error.issues.length > 0 ? ` Unexpected fields: ${error.issues.join(", ")}.` : ""}`,
        retry,
      };
    case "http":
      return { status: "error", title: `Could not load ${resource}`, detail: `The read API answered ${error.status ?? "unexpectedly"}.`, retry };
  }
}

function settle<T>(q: QueryLike<unknown>, loaded: Loaded<T>, opts: LoadOptions<T>): Loadable<Loaded<T>> {
  const retry = () => { void q.refetch(); };
  const missing = loaded.meta.unavailable.map(sourceLabel);
  // A failed refresh keeps the last good data, clearly marked with its age instead of silently presented as current.
  if (q.isRefetchError) missing.push(`the latest refresh (showing data from ${absoluteTime(loaded.meta.generatedAt)})`);
  if (missing.length > 0) return { status: "partial", data: loaded, missing, retry };
  if (opts.isEmpty?.(loaded.value)) {
    const empty = opts.empty ?? { title: `No ${opts.resource}`, detail: "The read API returned nothing to show." };
    return { status: "empty", title: empty.title, detail: empty.detail };
  }
  return { status: "success", data: loaded };
}

export function fromQuery<T>(q: QueryLike<ApiResult<T>>, opts: LoadOptions<T>): Loadable<Loaded<T>> {
  if (q.data !== undefined) return settle(q, { value: q.data.data, meta: q.data.meta }, opts);
  if (q.status === "error") return errorLoadable(q.error, opts.resource, () => { void q.refetch(); });
  return { status: "loading" };
}

/** Flattens cursor pages; freshness comes from the first page, partial sources from every page. */
export function fromInfiniteQuery<T>(q: QueryLike<InfiniteData<ApiResult<readonly T[]>>>, opts: LoadOptions<readonly T[]>): Loadable<Loaded<readonly T[]>> {
  const pages = q.data?.pages;
  const first = pages?.[0];
  const last = pages?.at(-1);
  if (pages && first && last) {
    const unavailable = [...new Set(pages.flatMap((p) => p.meta.unavailable))];
    const meta: ResponseMeta = { generatedAt: first.meta.generatedAt, nextCursor: last.meta.nextCursor, unavailable };
    return settle(q, { value: pages.flatMap((p) => p.data), meta }, opts);
  }
  if (q.status === "error") return errorLoadable(q.error, opts.resource, () => { void q.refetch(); });
  return { status: "loading" };
}
