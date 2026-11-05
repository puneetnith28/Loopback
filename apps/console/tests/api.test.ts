import { describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiUrl, type ApiResult } from "../src/api/client.ts";
import { fromInfiniteQuery, fromQuery, type QueryLike } from "../src/api/loadable.ts";
import { shouldRetry } from "../src/api/queries.ts";
import { CaseDetail, ConfigSummary, Overview, VerificationRun, pageOf, AuditEvent } from "../src/api/schemas.ts";
import { hrefFor, inAppPath, parseRoute } from "../src/app/router.tsx";
import { auditEvent, caseDetail, configSummary, envelope, errorEnvelope, overview, verificationRun } from "../test-fixtures/api.ts";

const json = (body: unknown, status = 200, type = "application/json") =>
  vi.fn(() => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } })));

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

describe("apiUrl", () => {
  it("builds same-origin /api/v1 URLs, dropping empty parameters and joining lists", () => {
    expect(apiUrl("/cases", { state: "Stale", cursor: undefined, limit: 50 })).toBe("/api/v1/cases?state=Stale&limit=50");
    expect(apiUrl("/audit", { types: ["a.b", "c.d"], case: null })).toBe("/api/v1/audit?types=a.b%2Cc.d");
    expect(apiUrl("/cases/LB-042")).toBe("/api/v1/cases/LB-042");
  });

  it.each(["cases", "/cases/../admin", "//evil.example", "/cases?x=1", "/cases/LB 1"])("rejects the unsafe path %j", (p) => {
    expect(() => apiUrl(p)).toThrow();
  });
});

describe("apiGet", () => {
  it("sends a same-origin, no-store GET and returns validated data with metadata", async () => {
    const fetchImpl = json(envelope(configSummary(), { unavailable: ["status"] }));
    const r = await apiGet("/config/summary", ConfigSummary, { fetchImpl });
    expect(r.data.gateMention).toBe("@loopback-gate");
    expect(r.meta.unavailable).toEqual(["status"]);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
  });

  it("strips keys outside the allowlist, so an accidental secret never reaches the UI", async () => {
    const leaked = { ...configSummary(), githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----", switchApiKey: "sk-123" };
    const r = await apiGet("/config/summary", ConfigSummary, { fetchImpl: json(envelope(leaked)) });
    expect(JSON.stringify(r.data)).not.toMatch(/PRIVATE KEY|sk-123/);
  });

  it.each([
    [401, "permission"], [403, "permission"], [404, "not-found"], [500, "server"], [503, "server"], [400, "http"],
  ] as const)("maps HTTP %i to %s and keeps the API error code", async (status, kind) => {
    const err = await failure(apiGet("/overview", Overview, { fetchImpl: json(errorEnvelope("SOME_CODE"), status) }));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.code).toBe("SOME_CODE");
  });

  it("reports an unreachable API as a network error", async () => {
    const err = await failure(apiGet("/overview", Overview, { fetchImpl: vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) }));
    expect(err.kind).toBe("network");
  });

  it("propagates cancellation unchanged instead of reporting a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await expect(apiGet("/overview", Overview, { signal: controller.signal, fetchImpl })).rejects.toBeInstanceOf(DOMException);
  });

  it.each([
    ["non-JSON content", json("<html>login</html>", 200, "text/html")],
    ["malformed JSON", json("{not json", 200)],
    ["a failure envelope with 200", json(errorEnvelope("X"), 200)],
    ["a missing envelope", json(overview(), 200)],
  ])("rejects %s as an invalid response", async (_n, fetchImpl) => {
    const err = await failure(apiGet("/overview", Overview, { fetchImpl }));
    expect(err.kind).toBe("invalid-response");
  });

  it("names the failing fields (never their values) when validation fails", async () => {
    const bad = { ...caseDetail(), headSha: "e804775" };
    const err = await failure(apiGet("/cases/LB-042", CaseDetail, { fetchImpl: json(envelope(bad)) }));
    expect(err.kind).toBe("invalid-response");
    expect(err.issues).toContain("data.headSha");
    expect(err.message).not.toContain("e804775");
  });
});

describe("schemas: provenance is stated by the API and checked", () => {
  it("rejects signed-verifier provenance without a valid signature", () => {
    expect(VerificationRun.safeParse(verificationRun()).success).toBe(true);
    for (const signature of ["absent", "unverified", "invalid", null]) {
      expect(VerificationRun.safeParse(verificationRun({ signature })).success, String(signature)).toBe(false);
    }
    expect(VerificationRun.safeParse(verificationRun({ signature: "absent", provenance: "agent-claim", mode: "advisory" })).success).toBe(true);
  });

  it("never accepts DEMO provenance from the API", () => {
    expect(pageOf(AuditEvent).safeParse([auditEvent({ provenance: "demo" })]).success).toBe(false);
  });

  it("requires a count for every one of the 14 contract states", () => {
    const o = overview() as { countsByState: Record<string, number> };
    const missing: Record<string, number> = { ...o.countsByState };
    delete missing.Merged;
    expect(Overview.safeParse(overview()).success).toBe(true);
    expect(Overview.safeParse({ ...o, countsByState: missing }).success).toBe(false);
  });

  it("rejects short SHAs, malformed case ids and a gate mention that could smuggle words", () => {
    expect(CaseDetail.safeParse(caseDetail({ evidence: { verifiedSha: "e804775", runId: "r" } })).success).toBe(false);
    expect(CaseDetail.safeParse(caseDetail({ id: "LB-1" })).success).toBe(false);
    expect(ConfigSummary.safeParse(configSummary({ gateMention: "@gate merge" })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

function q<D>(over: Partial<QueryLike<D>>): QueryLike<D> {
  return { status: "pending", data: undefined, error: null, isRefetchError: false, refetch: vi.fn(), ...over };
}
type Res = ApiResult<number[]>;
const meta = { generatedAt: "2026-11-04T10:00:00Z", nextCursor: null, unavailable: [] as string[] };

describe("fromQuery: the six content states", () => {
  it("pending → loading", () => {
    expect(fromQuery(q<Res>({}), { resource: "x" }).status).toBe("loading");
  });

  it("errors map to error or permission, with retry only where retrying can help", () => {
    const perm = fromQuery(q<Res>({ status: "error", error: new ApiError("permission", "no") }), { resource: "cases" });
    expect(perm.status).toBe("permission");
    const net = fromQuery(q<Res>({ status: "error", error: new ApiError("network", "down") }), { resource: "cases" });
    expect(net).toMatchObject({ status: "error", title: "Cannot reach the read API" });
    expect(net.status === "error" && typeof net.retry).toBe("function");
    const missing = fromQuery(q<Res>({ status: "error", error: new ApiError("not-found", "no") }), { resource: "case LB-001" });
    expect(missing.status === "error" && missing.retry).toBeUndefined();
    const invalid = fromQuery(q<Res>({ status: "error", error: new ApiError("invalid-response", "bad", { issues: ["data.headSha"] }) }), { resource: "x" });
    expect(invalid.status === "error" && invalid.detail).toContain("data.headSha");
  });

  it("success, empty, and partial when the API reports unavailable sources", () => {
    expect(fromQuery(q({ status: "success", data: { data: [1], meta } }), { resource: "x" }).status).toBe("success");
    expect(fromQuery(q({ status: "success", data: { data: [], meta } }), { resource: "x", isEmpty: (v: number[]) => v.length === 0 }).status).toBe("empty");
    const partial = fromQuery(q({ status: "success", data: { data: [1], meta: { ...meta, unavailable: ["github-snapshot"] } } }), { resource: "x" });
    expect(partial).toMatchObject({ status: "partial", missing: ["the GitHub pull-request snapshot"] });
  });

  it("a failed refresh keeps the last good data but marks it partial with its age", () => {
    const s = fromQuery(q<Res>({ status: "error", isRefetchError: true, error: new ApiError("network", "down"), data: { data: [1], meta } }), { resource: "x" });
    expect(s.status).toBe("partial");
    expect(s.status === "partial" && s.missing[0]).toMatch(/latest refresh \(showing data from 2026-11-04 10:00:00 UTC\)/);
  });

  it("flattens cursor pages and merges unavailable sources from every page", () => {
    const pages = { pages: [{ data: [1, 2], meta: { ...meta, nextCursor: "c2" } }, { data: [3], meta: { ...meta, unavailable: ["audit"] } }], pageParams: [undefined, "c2"] };
    const s = fromInfiniteQuery(q({ status: "success", data: pages }), { resource: "x" });
    expect(s.status === "partial" && s.data.value).toEqual([1, 2, 3]);
    expect(s.status === "partial" && s.missing).toEqual(["the audit log"]);
  });
});

describe("retry policy", () => {
  it("retries network and server failures a bounded number of times, never permission or invalid data", () => {
    expect(shouldRetry(0, new ApiError("network", ""))).toBe(true);
    expect(shouldRetry(1, new ApiError("server", ""))).toBe(true);
    expect(shouldRetry(2, new ApiError("server", ""))).toBe(false);
    expect(shouldRetry(0, new ApiError("permission", ""))).toBe(false);
    expect(shouldRetry(0, new ApiError("invalid-response", ""))).toBe(false);
    expect(shouldRetry(0, new Error("other"))).toBe(false);
  });
});

describe("router", () => {
  it.each([
    ["/", "", { name: "overview" }],
    ["/cases", "?state=Stale", { name: "cases", state: "Stale" }],
    ["/cases", "?state=Bogus", { name: "cases", state: null }],
    ["/cases/LB-042", "", { name: "case", id: "LB-042" }],
    ["/cases/LB-042/", "", { name: "case", id: "LB-042" }],
    ["/cases/lb-042", "", { name: "not-found" }],
    ["/cases/%E0%A4%A", "", { name: "not-found" }],
    ["/cases/LB-042%0Aapprove", "", { name: "not-found" }],
    ["/audit", "?case=LB-042&type=merge.blocked", { name: "audit", caseId: "LB-042", type: "merge.blocked" }],
    ["/audit", "?case=<script>&type=evil", { name: "audit", caseId: null, type: null }],
    ["/agents", "", { name: "agents" }],
    ["/gate", "", { name: "gate" }],
    ["/system", "", { name: "system" }],
    ["/admin", "", { name: "not-found" }],
  ])("parses %s%s", (path, search, expected) => {
    expect(parseRoute(path, search)).toEqual(expected);
  });

  it("round-trips routes through hrefFor", () => {
    for (const r of [{ name: "cases", state: "Merged" }, { name: "case", id: "LB-123" }, { name: "audit", caseId: "LB-001", type: "ci.observed" }] as const) {
      const href = new URL(hrefFor(r), "http://x");
      expect(parseRoute(href.pathname, href.search)).toEqual(r);
    }
  });

  it("intercepts only same-origin, same-tab, non-API links", () => {
    const a = (attrs: Record<string, string>) => {
      const el = document.createElement("a");
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const origin = window.location.origin;
    expect(inAppPath(a({ href: "/cases?state=Stale" }), origin)).toBe("/cases?state=Stale");
    expect(inAppPath(a({ href: "#main" }), origin)).toBeNull();
    expect(inAppPath(a({ href: "https://github.com/acme/widgets" }), origin)).toBeNull();
    expect(inAppPath(a({ href: "/cases", target: "_blank" }), origin)).toBeNull();
    expect(inAppPath(a({ href: "/api/v1/cases" }), origin)).toBeNull();
    expect(inAppPath(a({ href: "/x", "data-external": "" }), origin)).toBeNull();
  });
});
