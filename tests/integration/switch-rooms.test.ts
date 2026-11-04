/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRecent } from "../../apps/switch-gate/src/audit/index.js";
import { migrate, openDatabase, type Db } from "../../apps/switch-gate/src/persistence/db.js";
import { kvGet, kvSet, markProcessed } from "../../apps/switch-gate/src/persistence/repos.js";
import { RoomChats, SwitchPostError } from "../../apps/switch-gate/src/switch/chat.js";
import type { SocketLike, StopReason } from "../../apps/switch-gate/src/switch/connection.js";
import { Rooms } from "../../apps/switch-gate/src/switch/rooms.js";
import { LEGACY_CONNECTION_KEY, connectionKey } from "../../apps/switch-gate/src/switch/store.js";

// D26: one Switch connection per room, a room-keyed chat transport, all-or-nothing stop,
// and gap recovery bound to the room (and connection) that reported the gap.

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const MROOM = "maint-room";
const IROOM = "intake-room";
const SELF = "@switch-agent-gate:localhost";
const FIXER = "@switch-agent-fixer:localhost";
const G1 = 8589934592;

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: URL) {}
  send(): void { /* pongs are not inspected here */ }
  close(code = 1000): void { this.onclose?.({ code, reason: "" }); }
  frame(event: string, data: object): void { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
  get room(): string { return this.url.searchParams.get("rooms")!; }
  open(): void {
    this.frame("connection_state", {
      connection_id: this.url.searchParams.get("connection_id"), agent_id: AGENT, generation: G1,
      rooms: [this.room], cursor: 0, position: { s: 1 }, protocol: 9, heartbeat_interval_seconds: 2,
    });
  }
}

let db: Db;
beforeEach(() => {
  vi.useFakeTimers();
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify({ ok: true, event_id: "$e" }), { status: 200 })) {
  const sockets: FakeSocket[] = [];
  const stops: StopReason[] = [];
  const fetch = vi.fn(fetchImpl);
  const handled: string[] = [];
  const reconcile = vi.fn(async () => undefined);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const rooms = new Rooms({
    bridgeUrl: "http://127.0.0.1:37203", agentId: AGENT, apiKey: "test-key", selfId: SELF, clientVersion: "0.1.0",
    openSocket: (url) => { const s = new FakeSocket(new URL(url)); sockets.push(s); return s; },
    fetch: fetch as unknown as typeof globalThis.fetch,
    rooms: [{ name: "maintainers", roomId: MROOM }, { name: "intake", roomId: IROOM }],
    maintainerRoomId: MROOM, gateMention: "@loopback-gate", agentIds: new Set([FIXER]), log,
  });
  rooms.bind({ db, handle: async (m) => { handled.push(`${m.roomId}:${m.body}`); }, reconcile, onStop: (r) => { stops.push(r); } });
  const socketFor = (room: string) => sockets.filter((s) => s.room === room).at(-1)!;
  return { rooms, sockets, stops, fetch, handled, reconcile, log, socketFor };
}

describe("Rooms: one connection per room", () => {
  it("opens one single-room connection per room, each with its own connection id", () => {
    const t = setup();
    t.rooms.start();
    expect(t.sockets.map((s) => s.room).sort()).toEqual([IROOM, MROOM]);
    expect(t.sockets.every((s) => s.url.searchParams.get("scope") === "single")).toBe(true);
    const ids = new Set(t.sockets.map((s) => s.url.searchParams.get("connection_id")));
    expect(ids.size).toBe(2);
    t.socketFor(MROOM).open();
    t.socketFor(IROOM).open();
    expect(JSON.parse(kvGet(db, connectionKey(MROOM))!)).toMatchObject({ generation: G1 });
    expect(JSON.parse(kvGet(db, connectionKey(IROOM))!)).toMatchObject({ generation: G1 });
  });

  it("hands each room's messages to the router with their own room id, and drops the gate's own", async () => {
    const t = setup();
    t.rooms.start();
    for (const room of [MROOM, IROOM]) t.socketFor(room).open();
    const msg = (room: string, id: string, sender: string) => ({
      type: "message", room_id: room, position: { [`r:${room}`]: 1 },
      payload: { addressed: true, sender, sender_name: "x", sender_kind: null, on_behalf_of: null, message_id: id, body: `hi ${id}`, timestamp: 1 },
    });
    t.socketFor(IROOM).frame("message", msg(IROOM, "i1", "@bob:localhost"));
    t.socketFor(MROOM).frame("message", msg(MROOM, "m1", "@alice:localhost"));
    t.socketFor(MROOM).frame("message", msg(MROOM, "m2", SELF));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.handled.sort()).toEqual([`${IROOM}:hi i1`, `${MROOM}:hi m1`]);
  });

  it("posts to the room asked for, and refuses a room it does not serve", async () => {
    const t = setup();
    t.rooms.start();
    for (const room of [MROOM, IROOM]) t.socketFor(room).open();
    await t.rooms.chat.post(IROOM, "to intake", null);
    await t.rooms.chat.post(MROOM, "to maintainers", null);
    const bodies = t.fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string) as { room_id: string; content: string });
    expect(bodies).toEqual([{ room_id: IROOM, content: "to intake" }, { room_id: MROOM, content: "to maintainers" }]);
    await expect(t.rooms.chat.post("elsewhere", "x", null)).rejects.toBeInstanceOf(SwitchPostError);
  });

  it("stops every room when one stops for good, reporting the first reason once", async () => {
    const t = setup();
    t.rooms.start();
    for (const room of [MROOM, IROOM]) t.socketFor(room).open();
    t.socketFor(IROOM).frame("evicted", { code: "taken_over", reason: "x", room_id: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([expect.objectContaining({ code: "taken_over" })]);
    expect(t.rooms.rooms.every((r) => r.connection.stopped)).toBe(true);
  });

  it("a policy mismatch stops every room with that reason", () => {
    const t = setup();
    t.rooms.start();
    for (const room of [MROOM, IROOM]) t.socketFor(room).open();
    t.rooms.policyMismatch("policy changed");
    expect(t.stops).toEqual([expect.objectContaining({ code: "policy_mismatch" })]);
    expect(t.rooms.rooms.every((r) => r.connection.stopped)).toBe(true);
  });

  it("reattaches the maintainers' room from the pre-two-room record, and only that room, with a warning", () => {
    kvSet(db, LEGACY_CONNECTION_KEY, JSON.stringify({ connectionId: "legacy-id", generation: 5, position: null }));
    const t = setup();
    expect(t.log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "switch.store" }), expect.stringMatching(/adopting/));
    t.rooms.start();
    expect(t.socketFor(MROOM).url.searchParams.get("connection_id")).toBe("legacy-id");
    expect(t.socketFor(MROOM).url.searchParams.get("expected_generation")).toBe("5");
    expect(t.socketFor(IROOM).url.searchParams.get("connection_id")).not.toBe("legacy-id");
  });

  it("refuses an invalid room set", () => {
    const base = {
      bridgeUrl: "http://x", agentId: AGENT, apiKey: "k", selfId: SELF, clientVersion: "0", openSocket: () => { throw new Error("no"); },
      fetch: vi.fn() as unknown as typeof fetch, maintainerRoomId: MROOM, gateMention: "@g", agentIds: new Set<string>(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    expect(() => new Rooms({ ...base, rooms: [] })).toThrow();
    expect(() => new Rooms({ ...base, rooms: [{ name: "a", roomId: MROOM }, { name: "b", roomId: MROOM }] })).toThrow();
    expect(() => new Rooms({ ...base, rooms: [{ name: "b", roomId: IROOM }] })).toThrow(/maintainers' room/);
    expect(() => new RoomChats(new Map())).toThrow();
  });
});

describe("Rooms: gap recovery", () => {
  it("reads the gapped room through its own connection, audits, notifies maintainers and reconciles", async () => {
    let readBody: unknown;
    let readHeaders: Record<string, string> = {};
    const t = setup(async (url, init) => {
      if (url.endsWith("/ops/read_context")) {
        readBody = JSON.parse(init.body as string);
        readHeaders = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ result: { truncated: false, threads: [
          { root: { id: "x1", kind: "message", sender: "@bob:localhost", body: "@loopback-gate report lost", timestamp: 2 }, replies: [] },
          { root: { id: "x2", kind: "message", sender: "@bob:localhost", body: "@loopback-gate help", timestamp: 3 }, replies: [] },
        ] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, event_id: "$e" }), { status: 200 });
    });
    markProcessed(db, "x2", new Date());
    t.rooms.start();
    for (const room of [MROOM, IROOM]) t.socketFor(room).open();
    t.socketFor(IROOM).frame("gap", { rooms: [IROOM], all_rooms: false, reason: "buffer_overflow" });
    await vi.advanceTimersByTimeAsync(0);

    const intakeConn = t.socketFor(IROOM).url.searchParams.get("connection_id");
    expect(readBody).toEqual({ limit: 100, room_id: IROOM });
    expect(readHeaders["X-Switch-Connection-Id"]).toBe(intakeConn);
    const gap = db.prepare("SELECT payload_json AS p FROM audit_events WHERE event_type = 'delivery.gap'").all() as { p: string }[];
    expect(gap).toHaveLength(1);
    expect(JSON.parse(gap[0]!.p)).toMatchObject({ roomId: IROOM, recovered: true, missed: [{ messageId: "x1" }] });
    const notice = t.fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string) as { room_id?: string; content?: string }).find((b) => b.content?.includes("undelivered"));
    expect(notice).toMatchObject({ room_id: MROOM });
    expect(notice?.content).not.toContain("report lost");
    expect(t.reconcile).toHaveBeenCalledTimes(1);
    expect(t.handled).toEqual([]); // nothing recovered reaches the router
    expect(db.prepare("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 0 });
    expect(listRecent(db, "LB-001")).toEqual([]);
  });

  it("runs one recovery per room at a time, coalescing gaps that arrive meanwhile, and drained() waits for it", async () => {
    let release: () => void = () => undefined;
    let reads = 0;
    const t = setup(async (url) => {
      if (url.endsWith("/ops/read_context")) {
        reads += 1;
        if (reads === 1) await new Promise<void>((r) => { release = r; });
        return new Response(JSON.stringify({ result: { truncated: false, threads: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, event_id: "$e" }), { status: 200 });
    });
    t.rooms.start();
    for (const room of [MROOM, IROOM]) t.socketFor(room).open();
    for (let i = 0; i < 5; i += 1) t.socketFor(IROOM).frame("gap", { rooms: [IROOM], reason: `g${i}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    let drained = false;
    const d = t.rooms.drained().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    release();
    await d;
    expect(reads).toBe(2); // the five gaps during the first recovery ran as one more
    expect(t.reconcile).toHaveBeenCalledTimes(2);
  });
});
