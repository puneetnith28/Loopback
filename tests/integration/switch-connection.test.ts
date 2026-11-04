import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@loopback/contracts";
import {
  SwitchConnection, type ConnectionRecord, type SocketLike, type StopReason,
} from "../../apps/switch-gate/src/switch/connection.js";

// Behaviour of the Switch connection against a scripted socket. Frames mirror what
// the live switch-core 0.31.0 sent (see plan Appendix C.1).

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const ROOM = "room-1";
const G1 = 8589934592;

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  closedWith: number | null = null;
  constructor(readonly url: URL, readonly headers: Readonly<Record<string, string>>) {}
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code = 1000): void { this.closedWith = code; }
  frame(event: string, data: object): void { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
  state(over: Record<string, unknown> = {}): void {
    this.frame("connection_state", {
      connection_id: this.url.searchParams.get("connection_id"), agent_id: AGENT, generation: G1,
      rooms: [ROOM], cursor: 0, position: { s: 3 }, protocol: 9, heartbeat_interval_seconds: 2, ...over,
    });
  }
  serverClose(code: number): void { this.onclose?.({ code, reason: "" }); }
}

function message(id: string, body: string, over: Record<string, unknown> = {}, roomPos = 1): object {
  return {
    type: "message", room_id: ROOM,
    payload: { addressed: true, sender: "@alice:localhost", sender_name: "Alice", sender_kind: null, on_behalf_of: null, message_id: id, body, timestamp: 1, ...over },
    position: { [`r:${ROOM}`]: roomPos },
  };
}

function setup(opts: { stored?: ConnectionRecord | null; fetchImpl?: typeof fetch; handler?: (m: InboundMessage) => Promise<void>; onGap?: (roomId: string, reason: string) => void } = {}) {
  const sockets: FakeSocket[] = [];
  const saved: ConnectionRecord[] = [];
  const stops: StopReason[] = [];
  const received: InboundMessage[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const conn = new SwitchConnection({
    bridgeUrl: "http://127.0.0.1:37203", agentId: AGENT, apiKey: "test-key", roomId: ROOM, clientVersion: "0.1.0",
    openSocket: (url, headers) => { const s = new FakeSocket(new URL(url), headers); sockets.push(s); return s; },
    fetch: opts.fetchImpl ?? vi.fn(),
    store: { load: () => opts.stored ?? null, save: (r) => { saved.push(r); } },
    onMessage: opts.handler ?? ((m) => { received.push(m); return Promise.resolve(); }),
    onStop: (r) => { stops.push(r); },
    ...(opts.onGap ? { onGap: opts.onGap } : {}),
    log,
    reconnect: { baseMs: 100, maxMs: 1000, maxAttempts: 3 },
    beatIntervalMs: 0,
    random: () => 1,
  });
  return { conn, sockets, saved, stops, received, log, last: () => sockets[sockets.length - 1]! };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("opening", () => {
  it("authenticates with a bearer header and sends the verified parameters", () => {
    const t = setup();
    t.conn.start();
    const s = t.last();
    expect(s.headers).toEqual({ Authorization: "Bearer test-key" });
    expect(s.url.protocol).toBe("ws:");
    expect(s.url.pathname).toBe(`/agents/${AGENT}/connection/ws`);
    const q = Object.fromEntries(s.url.searchParams);
    expect(q).toMatchObject({ protocol: "9", protocol_accepts: "9", client: "loopback-gate", scope: "single", filter: "all", rooms: ROOM, start_at: "head" });
    expect(q.connection_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(q).not.toHaveProperty("expected_generation");
    expect(s.url.toString()).not.toContain("test-key");
  });

  it("records the connection on connection_state and reports it open", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    expect(t.conn.connection).toMatchObject({ generation: G1, rooms: [ROOM] });
    expect(t.saved.at(-1)).toMatchObject({ generation: G1, position: { s: 3 } });
  });

  it("reattaches a stored connection fenced on the generation it held, resuming its position", () => {
    const t = setup({ stored: { connectionId: "stored-id", generation: G1, position: { s: 3, "r:room-1": 9 } } });
    t.conn.start();
    const q = t.last().url.searchParams;
    expect(q.get("connection_id")).toBe("stored-id");
    expect(q.get("expected_generation")).toBe(String(G1));
    expect(JSON.parse(q.get("start_at")!)).toEqual({ s: 3, "r:room-1": 9 });
  });

  it.each([
    ["another agent", { agent_id: "someone-else" }, "protocol"],
    ["another connection", { connection_id: "other" }, "protocol"],
    ["another protocol", { protocol: 8 }, "protocol"],
    ["no gate room", { rooms: ["elsewhere"] }, "room_lost"],
    ["an unsafe generation", { generation: 2 ** 53 }, "protocol"],
  ])("fails closed when connection_state names %s", (_n, over, code) => {
    const t = setup();
    t.conn.start();
    t.last().state(over);
    expect(t.stops).toEqual([expect.objectContaining({ code })]);
    expect(t.conn.connection).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("fails closed when the server issues a generation that is not newer than the one held", () => {
    const t = setup({ stored: { connectionId: "stored-id", generation: G1, position: null } });
    t.conn.start();
    t.last().state({ connection_id: "stored-id", generation: G1 });
    expect(t.stops).toEqual([expect.objectContaining({ code: "stale_generation" })]);
  });

  it("reconnects when connection_state does not arrive in time", () => {
    const t = setup();
    t.conn.start();
    vi.advanceTimersByTime(15_000);
    expect(t.sockets[0]!.closedWith).toBe(1000);
    vi.advanceTimersByTime(100);
    expect(t.sockets).toHaveLength(2);
  });
});

describe("heartbeat", () => {
  it("answers each ping with a pong", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.last().frame("ping", {});
    t.last().frame("ping", {});
    expect(t.last().sent).toEqual([{ type: "pong", cursor: 0 }, { type: "pong", cursor: 0 }]);
  });

  it("reconnects when pings stop for three heartbeat intervals", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    vi.advanceTimersByTime(5_999);
    expect(t.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1 + 100);
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets[1]!.url.searchParams.get("expected_generation")).toBe(String(G1));
  });

  it("sends the fenced beat with the current generation", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    const t = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });
    t.conn.start();
    t.last().state();
    await t.conn.sendBeat();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:37203/agents/${AGENT}/connection/beat`);
    expect(JSON.parse(init.body as string)).toEqual({ connection_id: t.last().url.searchParams.get("connection_id"), generation: G1 });
    expect(t.stops).toEqual([]);
  });

  it("ignores a beat refusal for a generation it no longer holds", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { release = r; }));
    const t = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });
    t.conn.start();
    t.last().state();
    const beat = t.conn.sendBeat();
    t.last().frame("evicted", { code: "heartbeat_lapsed" });
    vi.advanceTimersByTime(100);
    t.last().state({ generation: G1 + 1 });
    release(new Response('{"detail":{"code":"taken_over","message":"m"}}', { status: 409 }));
    await beat;
    expect(t.stops).toEqual([]);
    expect(t.conn.connection?.generation).toBe(G1 + 1);
  });

  it("does not stop on a network failure of the beat", async () => {
    const t = setup({ fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch });
    t.conn.start();
    t.last().state();
    await t.conn.sendBeat();
    expect(t.stops).toEqual([]);
    expect(t.conn.connection).not.toBeNull();
  });
});

describe("taken_over is terminal", () => {
  const takenOverBeat = () => Promise.resolve(new Response('{"detail":{"code":"taken_over","message":"m"}}', { status: 409 }));

  it.each([
    ["an evicted frame", (s: FakeSocket) => { s.frame("evicted", { code: "taken_over", reason: "r", room_id: null }); }],
    ["a refused reattach", (s: FakeSocket) => { s.frame("refused", { status: 409, detail: { code: "taken_over", message: "m" } }); }],
    ["close code 4409", (s: FakeSocket) => { s.serverClose(4409); }],
  ])("stops without reconnecting on %s", (_n, signal) => {
    const t = setup();
    t.conn.start();
    t.last().state();
    signal(t.last());
    expect(t.stops).toEqual([expect.objectContaining({ code: "taken_over" })]);
    t.last().serverClose(1000);
    vi.advanceTimersByTime(120_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.stops).toHaveLength(1);
  });

  it("stops without reconnecting on a 409 taken_over heartbeat refusal", async () => {
    const t = setup({ fetchImpl: takenOverBeat as unknown as typeof fetch });
    t.conn.start();
    t.last().state();
    await t.conn.sendBeat();
    expect(t.stops).toEqual([expect.objectContaining({ code: "taken_over" })]);
    vi.advanceTimersByTime(120_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("reopens on a recoverable eviction but fails closed on an unknown code", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.last().frame("evicted", { code: "heartbeat_lapsed" });
    vi.advanceTimersByTime(100);
    expect(t.sockets).toHaveLength(2);
    t.last().state({ generation: G1 + 1 });
    t.last().frame("evicted", { code: "something_new" });
    expect(t.stops).toEqual([expect.objectContaining({ code: "protocol" })]);
  });
});

describe("refusals and reconnects", () => {
  it.each([
    [401, "unauthorized"], [403, "forbidden"], [404, "forbidden"], [400, "protocol"], [409, "protocol"],
  ])("a %i refusal is terminal (%s)", (status, code) => {
    const t = setup();
    t.conn.start();
    t.last().frame("refused", { status, detail: "x" });
    expect(t.stops).toEqual([expect.objectContaining({ code })]);
  });

  it.each([[4401, "unauthorized"], [4403, "forbidden"], [4400, "protocol"]])("close code %i is terminal (%s)", (code, stop) => {
    const t = setup();
    t.conn.start();
    t.last().serverClose(code);
    expect(t.stops).toEqual([expect.objectContaining({ code: stop })]);
  });

  it("retries a dropped socket with backoff, then gives up after the bounded attempts", () => {
    const t = setup();
    t.conn.start();
    t.last().serverClose(1006);
    vi.advanceTimersByTime(99);
    expect(t.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(2);
    t.last().serverClose(1006);
    vi.advanceTimersByTime(200);
    t.last().serverClose(1006);
    vi.advanceTimersByTime(400);
    expect(t.sockets).toHaveLength(4);
    t.last().serverClose(1006);
    expect(t.stops).toEqual([expect.objectContaining({ code: "retries_exhausted" })]);
  });

  it("retries a 5xx refusal and restores the attempt budget once the connection stays up", () => {
    const t = setup();
    t.conn.start();
    t.last().frame("refused", { status: 503, detail: "busy" });
    vi.advanceTimersByTime(100);
    t.last().state();
    expect(t.conn.connection).not.toBeNull();
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(2_000); t.last().frame("ping", {}); }
    t.last().serverClose(1006);
    vi.advanceTimersByTime(100);
    expect(t.sockets).toHaveLength(3);
  });

  it("a server that accepts then drops every open still exhausts the bounded attempts", () => {
    const t = setup();
    t.conn.start();
    for (let i = 0; i < 4 && t.stops.length === 0; i++) {
      t.last().state({ generation: G1 + i });
      t.last().serverClose(1006);
      vi.advanceTimersByTime(1_000);
    }
    expect(t.stops).toEqual([expect.objectContaining({ code: "retries_exhausted" })]);
  });

  it("stops for good on a policy mismatch, without reconnecting", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.conn.policyMismatch("users widened");
    expect(t.stops).toEqual([{ code: "policy_mismatch", detail: "users widened" }]);
    vi.advanceTimersByTime(120_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("stops when the gate's room is no longer claimed", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.last().frame("subscription_changed", { rooms: [], reason: "r" });
    expect(t.stops).toEqual([expect.objectContaining({ code: "room_lost" })]);
  });

  it("stop() closes cleanly and reports once", async () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    await t.conn.stop();
    await t.conn.stop();
    expect(t.last().closedWith).toBe(1000);
    expect(t.stops).toEqual([{ code: "stopped", detail: "stopped by the gate" }]);
    expect(t.conn.stopped).toBe(true);
  });
});

describe("messages", () => {
  it("hands messages over in order and saves the position after each", async () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.last().frame("message", message("$1", "first", {}, 5));
    t.last().frame("message", message("$2", "second", { thread_id: "$1" }, 6));
    await t.conn.drained();
    await t.conn.stop();
    expect(t.received.map((m) => [m.messageId, m.threadId])).toEqual([["$1", null], ["$2", "$1"]]);
    expect(t.saved.at(-1)?.position).toEqual({ s: 3, "r:room-1": 6 });
  });

  it("drops messages from other rooms and invalid frames without stopping", async () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.last().frame("message", { ...message("$x", "elsewhere"), room_id: "other" });
    t.last().frame("message", { type: "message", room_id: ROOM, payload: { body: "no ids" } });
    await t.conn.stop();
    expect(t.received).toEqual([]);
    expect(t.stops).toEqual([expect.objectContaining({ code: "stopped" })]);
    expect(t.log.error).toHaveBeenCalledWith(expect.objectContaining({ op: "switch.frame" }), expect.any(String));
  });

  it("does not hand over queued messages after a takeover", async () => {
    let release: () => void = () => undefined;
    const handled: string[] = [];
    const t = setup({ handler: (m) => { handled.push(m.messageId); return m.messageId === "$1" ? new Promise<void>((r) => { release = r; }) : Promise.resolve(); } });
    t.conn.start();
    t.last().state();
    t.last().frame("message", message("$1", "first", {}, 1));
    t.last().frame("message", message("$2", "second", {}, 2));
    await Promise.resolve();
    t.last().frame("evicted", { code: "taken_over" });
    release();
    await t.conn.drained();
    expect(handled).toEqual(["$1"]);
    expect(t.saved.at(-1)?.position).toEqual({ s: 3 });
  });

  it("stops (storage) instead of silently stalling when the position cannot be saved", async () => {
    const t = setup();
    const conn = t.conn as unknown as { o: { store: { save: (r: ConnectionRecord) => void } } };
    t.conn.start();
    t.last().state();
    conn.o.store.save = () => { throw new Error("SQLITE_BUSY"); };
    t.last().frame("message", message("$1", "first"));
    await t.conn.drained();
    expect(t.stops).toEqual([expect.objectContaining({ code: "storage" })]);
  });

  it("does not move the saved position on a reattach's connection_state", () => {
    const t = setup({ stored: { connectionId: "stored-id", generation: G1, position: { s: 3, "r:room-1": 9 } } });
    t.conn.start();
    t.last().state({ connection_id: "stored-id", generation: G1 + 1, position: { s: 50, "r:room-1": 99 } });
    expect(t.saved.at(-1)?.position).toEqual({ s: 3, "r:room-1": 9 });
  });

  it("keeps going when the handler throws", async () => {
    const t = setup({ handler: () => Promise.reject(new Error("boom")) });
    t.conn.start();
    t.last().state();
    t.last().frame("message", message("$1", "first"));
    await t.conn.drained();
    expect(t.stops).toEqual([]);
    expect(t.log.error).toHaveBeenCalledWith(expect.objectContaining({ op: "switch.handle", err: "Error" }), expect.any(String));
  });

  it("logs a gap as an error", () => {
    const t = setup();
    t.conn.start();
    t.last().state();
    t.last().frame("gap", { reason: "expired" });
    expect(t.log.error).toHaveBeenCalledWith(expect.objectContaining({ op: "switch.gap" }), expect.any(String));
  });
});

describe("readiness inputs (step 9.5)", () => {
  it("reports the last heartbeat only while open, refreshed by each ping", () => {
    const t = setup();
    expect(t.conn.lastHeartbeatAt).toBeNull();
    t.conn.start();
    expect(t.conn.lastHeartbeatAt).toBeNull();
    t.last().state();
    const opened = t.conn.lastHeartbeatAt;
    expect(opened).toBe(Date.now());
    vi.advanceTimersByTime(1500);
    t.last().frame("ping", {});
    expect(t.conn.lastHeartbeatAt).toBe(opened! + 1500);
    expect(t.conn.roomId).toBe(ROOM);
    t.last().state({}); // a second connection_state is a protocol error: the connection stops
    expect(t.conn.lastHeartbeatAt).toBeNull();
  });
});

describe("gap recovery hook (step 3.9)", () => {
  it.each([
    ["names this room", { rooms: [ROOM], reason: "buffer_overflow" }, true],
    ["covers all rooms", { all_rooms: true, rooms: [] }, true],
    ["names no room", {}, true],
    ["names only another room", { rooms: ["other-room"], all_rooms: false }, false],
  ])("calls onGap when the gap frame %s", (_n, data, expected) => {
    const onGap = vi.fn();
    const t = setup({ onGap });
    t.conn.start();
    t.last().state();
    t.last().frame("gap", data);
    if (expected) expect(onGap).toHaveBeenCalledWith(ROOM, (data as { reason?: string }).reason ?? "");
    else expect(onGap).not.toHaveBeenCalled();
    expect(t.stops).toEqual([]);
  });
});
