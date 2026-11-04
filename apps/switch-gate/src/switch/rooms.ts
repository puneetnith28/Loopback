import type { ChatPort } from "../chat/port.js";
import type { Db } from "../persistence/db.js";
import { append } from "../audit/index.js";
import { isProcessed } from "../persistence/repos.js";
import type { InboundMessage } from "@loopback/contracts";
import { RoomChats, SwitchChat } from "./chat.js";
import { SwitchConnection, type ConnectionLog, type OpenSocket, type StopReason } from "./connection.js";
import { recoverGap } from "./gap.js";
import { readContext } from "./ops.js";
import { kvGet } from "../persistence/repos.js";
import { LEGACY_CONNECTION_KEY, connectionKey, sqliteConnectionStore } from "./store.js";

/**
 * D26: the gate serves two rooms, each over its own Switch connection (a `scope=single`
 * connection holds exactly one room, and threaded posting goes to that room). Both share
 * one agent identity, one database and one router; nothing is shared between the rooms'
 * connection records, so a reattach in one room never fences the other.
 */

export interface RoomSpec {
  /** A label for logs and readiness ("maintainers", "intake"); never an id. */
  readonly name: string;
  readonly roomId: string;
}

export interface RoomsOptions {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly selfId: string;
  readonly clientVersion: string;
  readonly openSocket: OpenSocket;
  readonly fetch: typeof fetch;
  readonly rooms: readonly RoomSpec[];
  readonly maintainerRoomId: string;
  readonly gateMention: string;
  readonly agentIds: ReadonlySet<string>;
  readonly log: ConnectionLog;
}

export interface RoomsBinding {
  readonly db: Db;
  readonly handle: (msg: InboundMessage) => Promise<void>;
  readonly reconcile: () => Promise<void>;
  /** Called for the first connection that stops; every other connection is then stopped. */
  readonly onStop: (reason: StopReason) => void;
}

export interface Room {
  readonly spec: RoomSpec;
  readonly connection: SwitchConnection;
}

/** The chat transport for every room, available before the gate exists (it needs a chat). */
export class Rooms {
  readonly chat: ChatPort;
  private readonly connections = new Map<string, SwitchConnection>();
  private readonly built: Room[] = [];
  private stopReported = false;
  /** Gap recovery per room: at most one running; a gap during it schedules one rerun (single-flight). */
  private readonly recovering = new Map<string, { run: Promise<void>; again: string | null }>();

  constructor(private readonly o: RoomsOptions) {
    const ids = new Set(o.rooms.map((r) => r.roomId));
    if (ids.size !== o.rooms.length || o.rooms.length === 0) throw new Error("rooms must be non-empty and distinct");
    if (!ids.has(o.maintainerRoomId)) throw new Error("the maintainers' room must be one of the served rooms");
    const chats = new Map<string, ChatPort>();
    for (const r of o.rooms) {
      const conn = () => this.connections.get(r.roomId);
      chats.set(r.roomId, new SwitchChat({
        bridgeUrl: o.bridgeUrl, agentId: o.agentId, apiKey: o.apiKey, roomId: r.roomId, fetch: o.fetch,
        connection: {
          get connection() { return conn()?.connection ?? null; },
          get stopped() { return conn()?.stopped ?? false; },
          takenOver: (detail) => { conn()?.takenOver(detail); },
        },
      }));
    }
    this.chat = new RoomChats(chats);
  }

  /** Create one connection per room, bound to the gate. Connections are not started. */
  bind(b: RoomsBinding): readonly Room[] {
    if (this.built.length > 0) throw new Error("rooms are already bound");
    if (kvGet(b.db, connectionKey(this.o.maintainerRoomId)) === undefined && kvGet(b.db, LEGACY_CONNECTION_KEY) !== undefined) {
      // The pre-two-room record names no room: it is assumed to be the maintainers' room.
      this.o.log.warn({ op: "switch.store" }, "adopting the single-room connection record for the maintainers' room; if SWITCH_ROOM_ID changed since, stop and investigate");
    }
    for (const spec of this.o.rooms) {
      const connection: SwitchConnection = new SwitchConnection({
        bridgeUrl: this.o.bridgeUrl, agentId: this.o.agentId, apiKey: this.o.apiKey,
        roomId: spec.roomId, clientVersion: this.o.clientVersion, openSocket: this.o.openSocket, fetch: this.o.fetch,
        store: sqliteConnectionStore(b.db, spec.roomId, { adoptLegacy: spec.roomId === this.o.maintainerRoomId }),
        onMessage: async (msg) => {
          if (msg.sender === this.o.selfId) return; // the gate's own messages echo back
          await b.handle(msg);
        },
        onStop: (reason) => this.stopAll(reason, b),
        onGap: (roomId, reason) => { this.scheduleRecovery(roomId, reason, connection, b); },
        log: this.o.log,
      });
      this.connections.set(spec.roomId, connection);
      this.built.push({ spec, connection });
    }
    return this.built;
  }

  get rooms(): readonly Room[] {
    return this.built;
  }

  start(): void {
    for (const r of this.built) r.connection.start();
  }

  /** Graceful stop of every connection. */
  async stop(): Promise<void> {
    await Promise.all(this.built.map((r) => r.connection.stop()));
  }

  /** A failed policy check stops every room, not just one. */
  policyMismatch(detail: string): void {
    for (const r of this.built) r.connection.policyMismatch(detail);
  }

  /** Wait for message handlers and any gap recovery to finish (call before closing the database). */
  async drained(): Promise<void> {
    await Promise.all(this.built.map((r) => r.connection.drained()));
    while (this.recovering.size > 0) await Promise.all([...this.recovering.values()].map((x) => x.run));
  }

  private scheduleRecovery(roomId: string, reason: string, connection: SwitchConnection, b: RoomsBinding): void {
    if (this.stopReported) return;
    const running = this.recovering.get(roomId);
    if (running !== undefined) {
      running.again = reason;
      return;
    }
    const entry: { run: Promise<void>; again: string | null } = { run: Promise.resolve(), again: null };
    entry.run = (async () => {
      let next: string | null = reason;
      while (next !== null && !this.stopReported) {
        entry.again = null;
        await this.recover(roomId, next, connection, b);
        next = entry.again;
      }
      this.recovering.delete(roomId);
    })();
    this.recovering.set(roomId, entry);
  }

  /**
   * The gate runs in both rooms or not at all: a room that stops for good (taken over,
   * refused, retries exhausted, policy mismatch) stops the others, and the first reason
   * is the one reported.
   */
  private stopAll(reason: StopReason, b: RoomsBinding): void {
    if (this.stopReported) return;
    this.stopReported = true;
    b.onStop(reason);
    for (const r of this.built) {
      if (r.connection.stopped) continue;
      if (reason.code === "policy_mismatch") r.connection.policyMismatch(reason.detail);
      else void r.connection.stop();
    }
  }

  private async recover(roomId: string, reason: string, connection: SwitchConnection, b: RoomsBinding): Promise<void> {
    const opts = { bridgeUrl: this.o.bridgeUrl, agentId: this.o.agentId, apiKey: this.o.apiKey, fetch: this.o.fetch };
    try {
      const outcome = await recoverGap(roomId, reason, {
        readContext: async (room) => {
          const held = connection.connection;
          if (held === null) return { ok: false, reason: "the room's connection is not open" };
          return readContext(opts, room, held.connectionId);
        },
        isProcessed: (id) => isProcessed(b.db, id),
        gateMention: this.o.gateMention,
        agentIds: this.o.agentIds,
        selfId: this.o.selfId,
        record: (room, payload) => {
          append(b.db, { caseId: null, actorId: "system", type: "delivery.gap", payload: { roomId: room, ...payload } });
        },
        notifyMaintainers: (text) => this.chat.post(this.o.maintainerRoomId, text, null),
        reconcile: b.reconcile,
        log: { error: (o, m) => this.o.log.error(o, m) },
      });
      this.o.log.warn({ op: "switch.gap", read: outcome.read, missed: outcome.missed, truncated: outcome.truncated }, "recovered from a Switch delivery gap");
    } catch (e) {
      this.o.log.error({ op: "switch.gap", err: e instanceof Error ? e.name : "unknown" }, "delivery gap recovery failed");
    }
  }
}
