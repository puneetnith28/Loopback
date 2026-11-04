import { describe, expect, it, vi } from "vitest";
import { SwitchChat, SwitchPostError, type ChatConnection } from "../../apps/switch-gate/src/switch/chat.js";

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const ROOM = "room-1";
const BASE = `http://127.0.0.1:37203/agents/${AGENT}`;

function setup(respond: () => Response | Promise<Response>, connection: ChatConnection["connection"] = { connectionId: "c1", rooms: [ROOM] }, stopped = false) {
  const fetchImpl = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(respond()));
  const takenOver = vi.fn();
  const chat = new SwitchChat({
    bridgeUrl: "http://127.0.0.1:37203/", agentId: AGENT, apiKey: "test-key", roomId: ROOM,
    fetch: fetchImpl as unknown as typeof fetch, connection: { connection, stopped, takenOver },
  });
  const call = (i = 0) => {
    const [url, init] = fetchImpl.mock.calls[i]!;
    return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as unknown };
  };
  return { chat, fetchImpl, takenOver, call };
}
const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });

describe("SwitchChat", () => {
  it("posts a top-level message to the room with the agent credential", async () => {
    const t = setup(() => ok({ ok: true, event_id: "$e1" }));
    await t.chat.post(ROOM, "hello", null);
    expect(t.call()).toEqual({
      url: `${BASE}/message`,
      headers: expect.objectContaining({ Authorization: "Bearer test-key", "Content-Type": "application/json" }) as unknown,
      body: { room_id: ROOM, content: "hello" },
    });
  });

  it("posts a threaded reply through post_message bound to the open connection", async () => {
    const t = setup(() => ok({ result: { event_id: "$e2" } }));
    await t.chat.post(ROOM, "reply", "$root");
    const c = t.call();
    expect(c.url).toBe(`${BASE}/ops/post_message`);
    expect(c.headers["X-Switch-Connection-Id"]).toBe("c1");
    expect(c.body).toEqual({ body: "reply", thread_id: "$root" });
  });

  it("refuses a threaded reply while disconnected instead of posting it top-level", async () => {
    const t = setup(() => ok({ ok: true, event_id: "$e" }), null);
    await expect(t.chat.post(ROOM, "reply", "$root")).rejects.toBeInstanceOf(SwitchPostError);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a threaded reply when the connection is not bound to exactly the gate's room", async () => {
    const t = setup(() => ok({ ok: true, event_id: "$e" }), { connectionId: "c1", rooms: [ROOM, "other"] });
    await expect(t.chat.post(ROOM, "reply", "$root")).rejects.toThrow(/exactly the gate's room/);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to post once the connection has stopped for good", async () => {
    const t = setup(() => ok({ ok: true, event_id: "$e" }), null, true);
    await expect(t.chat.post(ROOM, "hello", null)).rejects.toThrow(/stopped/);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses other rooms and empty messages", async () => {
    const t = setup(() => ok({ ok: true, event_id: "$e" }));
    await expect(t.chat.post("other", "x", null)).rejects.toThrow(/configured room/);
    await expect(t.chat.post(ROOM, "  ", null)).rejects.toThrow(/empty/);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([403, 404, 422, 429, 500])("surfaces a %i refusal without retrying", async (status) => {
    const t = setup(() => new Response('{"detail":"no"}', { status }));
    await expect(t.chat.post(ROOM, "x", null)).rejects.toMatchObject({ name: "SwitchPostError", status });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a 409 taken_over refusal as losing the connection", async () => {
    const t = setup(() => new Response('{"detail":{"code":"taken_over","message":"m"}}', { status: 409 }));
    await expect(t.chat.post(ROOM, "x", "$root")).rejects.toThrow(/taken_over/);
    expect(t.takenOver).toHaveBeenCalledOnce();
  });

  it("rejects success responses that do not carry an event id", async () => {
    await expect(setup(() => ok({ ok: true })).chat.post(ROOM, "x", null)).rejects.toThrow(/event id/);
    await expect(setup(() => new Response("<html>", { status: 200 })).chat.post(ROOM, "x", null)).rejects.toThrow(/not JSON/);
  });

  it("reports a network failure without leaking the credential", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const chat = new SwitchChat({
      bridgeUrl: "http://127.0.0.1:37203", agentId: AGENT, apiKey: "test-key", roomId: ROOM,
      fetch: fetchImpl, connection: { connection: null, stopped: false, takenOver: vi.fn() },
    });
    const err = await chat.post(ROOM, "x", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwitchPostError);
    expect(String((err as Error).message)).not.toContain("test-key");
  });
});
