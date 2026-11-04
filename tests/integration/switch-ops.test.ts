import { describe, expect, it, vi } from "vitest";
import { REQUIRED_OPERATIONS, discoverOperations, readContext } from "../../apps/switch-gate/src/switch/ops.js";

// Step 3.6 (operation discovery) and the read_context client used by gap recovery (3.9).
// Shapes follow switch-core 0.31.0: GET /agents/{id}/ops -> {"operations": {...}},
// POST /agents/{id}/ops/read_context -> {"result": {"threads": [...], "truncated": bool}}.

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const respond = (status: number, body: unknown) =>
  vi.fn(() => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
const opts = (f: ReturnType<typeof vi.fn>) => ({ bridgeUrl: "http://127.0.0.1:37203/", agentId: AGENT, apiKey: "test-key", fetch: f as unknown as typeof fetch });

describe("discoverOperations", () => {
  it("lists the agent's operations with the bearer key and accepts them when the required ones exist", async () => {
    const f = respond(200, { operations: { post_message: {}, read_context: {}, get_agent_detail: {} } });
    const r = await discoverOperations(opts(f));
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.operations].sort()).toEqual(["get_agent_detail", "post_message", "read_context"]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:37203/agents/${AGENT}/ops`);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(url).not.toContain("test-key");
  });

  it("names the missing required operations", async () => {
    const r = await discoverOperations(opts(respond(200, { operations: { post_message: {} } })));
    expect(r).toEqual({ ok: false, reason: "required Switch operations missing: read_context", missing: ["read_context"] });
  });

  it.each([
    ["an HTTP error", respond(401, "{}"), /HTTP 401/],
    ["a non-JSON body", respond(200, "<html>"), /not JSON/],
    ["an unexpected shape", respond(200, { ops: [] }), /unexpected shape/],
    ["operations as a list", respond(200, { operations: ["post_message", "read_context"] }), /unexpected shape/],
    ["a network failure", vi.fn(() => Promise.reject(new TypeError("fetch failed"))), /could not list/],
  ])("fails closed on %s, treating every required operation as missing", async (_n, f, reason) => {
    const r = await discoverOperations(opts(f));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(reason);
      expect(r.missing).toEqual([...REQUIRED_OPERATIONS]);
      expect(r.reason).not.toContain("test-key");
    }
  });
});

describe("readContext", () => {
  const entry = (id: string, over: Record<string, unknown> = {}) => ({
    id, kind: "message", sender: "@alice:localhost", sender_name: "Alice", body: `body ${id}`, timestamp: 1, attachments: [], ...over,
  });

  it("reads the room bound to this connection and flattens threads to messages", async () => {
    const f = respond(200, { result: { truncated: true, threads: [
      { root: entry("m1"), replies: [entry("m2"), entry("j1", { kind: "join" })] },
      { root: entry("m3", { body: undefined }), replies: [] },
    ] } });
    const r = await readContext(opts(f), "room-1", "conn-1", 50);
    expect(r).toEqual({ ok: true, truncated: true, entries: [
      { id: "m1", kind: "message", sender: "@alice:localhost", body: "body m1", timestamp: 1 },
      { id: "m2", kind: "message", sender: "@alice:localhost", body: "body m2", timestamp: 1 },
      { id: "m3", kind: "message", sender: "@alice:localhost", body: "", timestamp: 1 },
    ] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:37203/agents/${AGENT}/ops/read_context`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key", "X-Switch-Connection-Id": "conn-1" });
    expect(JSON.parse(init.body as string)).toEqual({ limit: 50, room_id: "room-1" });
  });

  it.each([
    ["an HTTP error", respond(403, "{}"), /HTTP 403/],
    ["a non-JSON body", respond(200, "nope"), /not JSON/],
    ["a missing result", respond(200, { threads: [] }), /unexpected shape/],
    ["an entry without a sender", respond(200, { result: { truncated: false, threads: [{ root: entry("m1", { sender: "" }), replies: [] }] } }), /unexpected shape/],
    ["a network failure", vi.fn(() => Promise.reject(new TypeError("fetch failed"))), /read_context failed/],
  ])("reports %s as a failed read", async (_n, f, reason) => {
    const r = await readContext(opts(f), "room-1", "conn-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
});
