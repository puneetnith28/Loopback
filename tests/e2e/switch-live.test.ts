import { describe, expect, it } from "vitest";
import { loadSwitchConfig } from "../../apps/switch-gate/src/config.js";
import { SwitchChat } from "../../apps/switch-gate/src/switch/chat.js";
import {
  SwitchConnection, type ConnectionRecord, type OpenSocket, type SocketLike, type StopReason,
} from "../../apps/switch-gate/src/switch/connection.js";

// Live checks of the Switch transport against the running Switch server, as loopback-gate.
// Skipped unless LOOPBACK_LIVE_SWITCH=1 and the Switch configuration group is set.
// It posts two short, labelled messages into SWITCH_ROOM_ID (a top-level one and a
// threaded reply to it). Do not run it while the gate itself is running: it opens its
// own connection and claims the same room.

const live = process.env.LOOPBACK_LIVE_SWITCH === "1";

const openSocket: OpenSocket = (url, headers) => {
  const WS = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => SocketLike;
  return new WS(url, { headers: { ...headers } });
};

describe.skipIf(!live)("live Switch transport", () => {
  const cfg = live ? loadSwitchConfig(process.env) : undefined;

  it("connects, claims the room, posts top-level and threaded, and closes cleanly", async () => {
    const c = cfg!;
    let record: ConnectionRecord | null = null;
    const stops: StopReason[] = [];
    const conn = new SwitchConnection({
      bridgeUrl: c.bridgeUrl, agentId: c.agentId, apiKey: c.apiKey, roomId: c.roomId, clientVersion: "0.1.0-live-test",
      openSocket, fetch: globalThis.fetch,
      store: { load: () => null, save: (r) => { record = r; } },
      onMessage: () => Promise.resolve(),
      onStop: (r) => { stops.push(r); },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      reconnect: { baseMs: 200, maxMs: 1000, maxAttempts: 2 },
      beatIntervalMs: 0,
    });
    conn.start();
    for (let i = 0; i < 100 && conn.connection === null && stops.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(stops).toEqual([]);
    expect(conn.connection?.rooms).toEqual([c.roomId]);
    expect(Number.isSafeInteger(conn.connection?.generation)).toBe(true);
    expect(record).not.toBeNull();

    await conn.sendBeat();
    expect(stops).toEqual([]);

    const chat = new SwitchChat({ bridgeUrl: c.bridgeUrl, agentId: c.agentId, apiKey: c.apiKey, roomId: c.roomId, fetch: globalThis.fetch, connection: conn });
    const rootId = await chat.postWithId(c.roomId, "[loopback live check] top-level message from the gate transport", null);
    const replyId = await chat.postWithId(c.roomId, "[loopback live check] threaded reply from the gate transport", rootId);
    expect(rootId).not.toBe(replyId);

    await conn.stop();
    expect(stops).toEqual([expect.objectContaining({ code: "stopped" })]);
  }, 30_000);
});
