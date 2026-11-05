import { render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";
import { App } from "../src/app/App.tsx";

export interface MockResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly contentType?: string;
}

export type Handler = MockResponse | ((url: URL) => MockResponse | Promise<MockResponse>);

/**
 * Stubs global fetch with a path-keyed table. Unknown paths answer 404 (so a test never silently hits a real
 * network), and every request URL is recorded so tests can assert query parameters and methods.
 */
export function mockApi(routes: Readonly<Record<string, Handler>>) {
  const calls: { readonly url: URL; readonly init: RequestInit | undefined }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const handler = routes[url.pathname];
    const res = handler === undefined
      ? { status: 404, body: { success: false, error: { code: "NOT_FOUND", message: "no route" } } }
      : typeof handler === "function" ? await handler(url) : handler;
    return new Response(typeof res.body === "string" ? res.body : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": res.contentType ?? "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

/** Plain JSON bodies → handlers. */
export function routesFrom(table: Readonly<Record<string, unknown>>): Record<string, Handler> {
  return Object.fromEntries(Object.entries(table).map(([path, body]) => [path, { body }]));
}

export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false, gcTime: Infinity, staleTime: Infinity } } });
}

/** Renders the whole app at `path` with an isolated query cache. */
export function renderAt(path: string, client: QueryClient = testQueryClient()) {
  window.history.pushState(null, "", path);
  return { client, ...render(<App queryClient={client} />) };
}
