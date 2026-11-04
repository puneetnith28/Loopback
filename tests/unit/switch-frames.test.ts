import { describe, expect, it } from "vitest";
import { advance, parseFrame, toInbound, type MessageEvent } from "../../apps/switch-gate/src/switch/frames.js";

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const state = (over: Record<string, unknown> = {}) => JSON.stringify({
  event: "connection_state",
  data: {
    connection_id: "c1", agent_id: AGENT, generation: 8589934592, scope: "single", filter: "all",
    rooms: ["room-1"], cursor: 0, position: { s: 3 }, protocol: 9, heartbeat_interval_seconds: 2.0,
    client: { speaks: 9, accepts: 9 }, ...over,
  },
});
const message = (payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({
  event: "message",
  id: 41,
  data: {
    type: "message", room_id: "room-1", bridge_id: null, channel_type: null,
    payload: {
      addressed: true, sender: "@alice:localhost", sender_name: "Alice", sender_kind: null, on_behalf_of: null,
      message_id: "$evt1", body: "@loopback-gate help", timestamp: 1_793_700_000_000, thread_id: null,
      attachments: [], opening_message: null, sender_role: "admin", ...payload,
    },
    sequence: 41, position: { "r:room-1": 17 }, ...extra,
  },
});

describe("parseFrame", () => {
  it("parses connection_state with a generation above 2^32", () => {
    const f = parseFrame(state());
    expect(f).toMatchObject({ kind: "connection_state", state: { generation: 8589934592, protocol: 9, rooms: ["room-1"] } });
  });

  it.each([
    ["an unsafe integer", 2 ** 53],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a string", "8589934592"],
  ])("rejects a generation that is %s", (_name, generation) => {
    expect(parseFrame(state({ generation })).kind).toBe("invalid");
  });

  it("reads an over-precise JSON integer as unsafe instead of rounding it", () => {
    const raw = state().replace("8589934592", "9007199254740993");
    expect(parseFrame(raw).kind).toBe("invalid");
  });

  it("parses the frames the live server sends", () => {
    expect(parseFrame('{"event":"ping","data":{}}')).toEqual({ kind: "ping" });
    expect(parseFrame('{"event":"evicted","data":{"code":"taken_over","reason":"x","room_id":null}}')).toEqual({ kind: "evicted", code: "taken_over" });
    expect(parseFrame('{"event":"refused","data":{"status":409,"detail":{"code":"taken_over","message":"m"}}}')).toEqual({ kind: "refused", status: 409, code: "taken_over" });
    expect(parseFrame('{"event":"refused","data":{"status":400,"detail":"connection_id is required"}}')).toEqual({ kind: "refused", status: 400, code: null });
    expect(parseFrame('{"event":"subscription_changed","data":{"rooms":["a"],"reason":"r"}}')).toEqual({ kind: "subscription_changed", rooms: ["a"] });
    expect(parseFrame('{"event":"room_released","data":{"room_id":"a","session_id":null}}')).toEqual({ kind: "room_released", roomId: "a" });
    expect(parseFrame('{"event":"gap","data":{}}')).toEqual({ kind: "gap", rooms: [], allRooms: false, reason: "" });
    expect(parseFrame('{"event":"gap","data":{"from_sequence":4,"resumed_at":"t","resumed_position":{"s":9},"rooms":["a"],"all_rooms":false,"reason":"buffer_overflow"}}'))
      .toEqual({ kind: "gap", rooms: ["a"], allRooms: false, reason: "buffer_overflow" });
    expect(parseFrame('{"event":"gap","data":{"rooms":null,"all_rooms":true}}').kind).toBe("invalid");
    expect(parseFrame('{"event":"gap","data":{"rooms":[""]}}').kind).toBe("invalid");
  });

  it("ignores frames it does not act on and rejects garbage", () => {
    expect(parseFrame('{"event":"room_join","data":{}}')).toEqual({ kind: "ignored", event: "room_join" });
    expect(parseFrame("not json").kind).toBe("invalid");
    expect(parseFrame(new Uint8Array([1])).kind).toBe("invalid");
    expect(parseFrame('{"event":"ping"}').kind).toBe("invalid");
    expect(parseFrame('{"event":"evicted","data":{}}').kind).toBe("invalid");
  });

  it("rejects message frames with missing or mistyped fields", () => {
    expect(parseFrame(message({ message_id: "" })).kind).toBe("invalid");
    expect(parseFrame(message({ addressed: "yes" })).kind).toBe("invalid");
    expect(parseFrame(message({ timestamp: 2 ** 60 })).kind).toBe("invalid");
    expect(parseFrame(message({}, { position: { bogus: 1 } })).kind).toBe("invalid");
  });
});

describe("toInbound", () => {
  const event = (raw: string): MessageEvent => {
    const f = parseFrame(raw);
    if (f.kind !== "message") throw new Error("expected a message");
    return f.event;
  };

  it("carries ids and raw attribution fields unchanged", () => {
    expect(toInbound(event(message({ thread_id: "$root", on_behalf_of: "Bob", sender_kind: "platform" })))).toEqual({
      eventId: "$evt1", messageId: "$evt1", roomId: "room-1", sequence: 17, sender: "@alice:localhost",
      senderKind: "platform", onBehalfOf: "Bob", senderRole: "admin", addressed: true,
      body: "@loopback-gate help", threadId: "$root", timestamp: 1_793_700_000_000,
    });
  });

  it("maps absent descriptive fields (thread_id, sender_role) to null rather than guessing", () => {
    const raw = JSON.parse(message()) as { data: { payload: Record<string, unknown> } };
    for (const k of ["thread_id", "sender_role"]) delete raw.data.payload[k];
    const m = toInbound(event(JSON.stringify(raw)));
    expect(m).toMatchObject({ threadId: null, senderRole: null });
  });

  it.each(["sender_kind", "on_behalf_of"])("rejects a message whose %s key is absent (it must not read as the human value)", (k) => {
    const raw = JSON.parse(message()) as { data: { payload: Record<string, unknown> } };
    delete raw.data.payload[k];
    expect(parseFrame(JSON.stringify(raw)).kind).toBe("invalid");
  });

  it("drops a message whose body exceeds the contract limit", () => {
    expect(toInbound(event(message({ body: "x".repeat(20_001) })))).toBeNull();
  });
});

describe("advance", () => {
  it("only moves positions forward", () => {
    expect(advance({ s: 5, "r:a": 3 }, { s: 4, "r:a": 9, "r:b": 1 })).toEqual({ s: 5, "r:a": 9, "r:b": 1 });
    expect(advance({ s: 1 }, undefined)).toEqual({ s: 1 });
  });
});
