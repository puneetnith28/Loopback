import { randomUUID } from "node:crypto";
import type { InboundMessage } from "@loopback/contracts";
import { AGENT_PROTOCOL, advance, parseFrame, toInbound, type ConnectionState, type Frame, type Position } from "./frames.js";

/**
 * The gate's connection to Switch over the agent WebSocket (switch-core 0.31.0).
 *
 * Verified protocol (live, 2026-11-03): Bearer auth on the upgrade; `connection_id`
 * is required; the first frame is `connection_state` with the connection's
 * `generation`; the server pings every `heartbeat_interval_seconds` and a
 * `{"type":"pong"}` reply is the heartbeat; refusals arrive as a `refused` frame
 * and a close code of 4000 + HTTP status.
 *
 * Fail-closed rules:
 * - `taken_over` is terminal however it arrives (an `evicted` frame, a 409 on the
 *   fenced beat, or close code 4409). The connection stops and never reconnects.
 * - A reattach names the generation it held (`expected_generation`), so a gate
 *   restarted after losing a takeover is refused instead of taking the connection
 *   back. Generations come from a server-side sequence and only increase.
 * - Authentication, membership and protocol refusals are terminal; only network
 *   failures, 5xx and recoverable evictions are retried, with a bounded backoff.
 */

/** The minimal WebSocket surface used; Node's global WebSocket satisfies it. */
export interface SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type OpenSocket = (url: string, headers: Readonly<Record<string, string>>) => SocketLike;

/** What survives a gate restart, so a reattach is fenced and resumes in place. */
export interface ConnectionRecord {
  readonly connectionId: string;
  readonly generation: number | null;
  readonly position: Position | null;
}
export interface ConnectionStore {
  load(): ConnectionRecord | null;
  save(record: ConnectionRecord): void;
}

export type StopCode =
  | "taken_over" | "unauthorized" | "forbidden" | "protocol" | "stale_generation"
  | "room_lost" | "retries_exhausted" | "storage" | "policy_mismatch" | "stopped";
export interface StopReason {
  readonly code: StopCode;
  readonly detail: string;
}

export interface ConnectionLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface ConnectionOptions {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly roomId: string;
  readonly clientVersion: string;
  readonly openSocket: OpenSocket;
  readonly fetch: typeof fetch;
  readonly store: ConnectionStore;
  /** Messages are handed over one at a time, in order. A rejection is logged; the position still advances. */
  readonly onMessage: (msg: InboundMessage) => Promise<void>;
  /** Called exactly once, when the connection stops for good. */
  readonly onStop: (reason: StopReason) => void;
  readonly log: ConnectionLog;
  readonly reconnect?: { readonly baseMs: number; readonly maxMs: number; readonly maxAttempts: number };
  /** Interval of the generation-fenced HTTP beat; 0 disables it. */
  readonly beatIntervalMs?: number;
  /** How long to wait for `connection_state` after opening. */
  readonly openTimeoutMs?: number;
  readonly random?: () => number;
}

const DEFAULT_RECONNECT = { baseMs: 500, maxMs: 30_000, maxAttempts: 8 };
const MISSED_PINGS_BEFORE_RECONNECT = 3;
/** Heartbeat intervals a connection must stay up before the reconnect budget is restored. */
const STABLE_HEARTBEATS = 5;
/** Codes the server says are recovered by reopening (anything else fails closed). */
const RECOVERABLE_EVICTIONS = new Set(["heartbeat_lapsed", "closed"]);

type State = "idle" | "opening" | "open" | "waiting" | "stopped";

export class SwitchConnection {
  private state: State = "idle";
  private socket: SocketLike | null = null;
  private record: ConnectionRecord;
  private current: ConnectionState | null = null;
  private attempts = 0;
  private timers = new Set<NodeJS.Timeout>();
  private watchdog: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly reconnect: { baseMs: number; maxMs: number; maxAttempts: number };

  constructor(private readonly o: ConnectionOptions) {
    this.reconnect = { ...DEFAULT_RECONNECT, ...o.reconnect };
    this.record = o.store.load() ?? { connectionId: randomUUID(), generation: null, position: null };
  }

  /** The open connection's id and generation, or null while not open. */
  get connection(): { readonly connectionId: string; readonly generation: number; readonly rooms: readonly string[] } | null {
    return this.state === "open" && this.current !== null
      ? { connectionId: this.current.connection_id, generation: this.current.generation, rooms: this.current.rooms }
      : null;
  }

  get stopped(): boolean {
    return this.state === "stopped";
  }

  start(): void {
    if (this.state !== "idle") return;
    this.open();
  }

  /** Close deliberately. A handler already running completes; queued messages are not handed over. */
  async stop(): Promise<void> {
    this.finish({ code: "stopped", detail: "stopped by the gate" });
    await this.queue;
  }

  /** Stop for good because the gate's Switch addressing policy is no longer the expected one. */
  policyMismatch(detail: string): void {
    this.finish({ code: "policy_mismatch", detail });
  }

  /** Called by the chat transport when Switch refuses a call because this client lost the connection. */
  takenOver(detail: string): void {
    this.finish({ code: "taken_over", detail });
  }

  // --- opening ---------------------------------------------------------------

  private url(): string {
    const q = new URLSearchParams({
      connection_id: this.record.connectionId,
      protocol: String(AGENT_PROTOCOL),
      protocol_accepts: String(AGENT_PROTOCOL),
      client: "loopback-gate",
      client_version: this.o.clientVersion,
      scope: "single",
      filter: "all",
      rooms: this.o.roomId,
      start_at: this.record.position === null ? "head" : JSON.stringify(this.record.position),
    });
    if (this.record.generation !== null) q.set("expected_generation", String(this.record.generation));
    const base = this.o.bridgeUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${base}/agents/${encodeURIComponent(this.o.agentId)}/connection/ws?${q.toString()}`;
  }

  private open(): void {
    this.state = "opening";
    this.current = null;
    let socket: SocketLike;
    try {
      socket = this.o.openSocket(this.url(), { Authorization: `Bearer ${this.o.apiKey}` });
    } catch (e) {
      this.o.log.warn({ op: "switch.open", err: e instanceof Error ? e.name : "unknown" }, "could not open the Switch socket");
      this.retry("open failed");
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      try {
        this.onFrame(parseFrame(ev.data));
      } catch (e) {
        this.finish({ code: "storage", detail: `could not record the connection state (${e instanceof Error ? e.name : "unknown"})` });
      }
    };
    socket.onerror = () => { /* the close event carries the outcome */ };
    socket.onclose = (ev) => { if (this.socket === socket) this.onClose(ev.code); };
    this.after(this.o.openTimeoutMs ?? 15_000, () => {
      if (this.socket === socket && this.state === "opening") this.drop("no connection_state before the open timeout");
    });
  }

  // --- frames ----------------------------------------------------------------

  private onFrame(frame: Frame): void {
    if (this.state === "stopped") return;
    switch (frame.kind) {
      case "connection_state": return this.onState(frame.state);
      case "ping": return this.onPing();
      case "message": return this.onMessage(frame);
      case "evicted":
        if (frame.code === "taken_over") return this.finish({ code: "taken_over", detail: "evicted: another client took over this connection" });
        if (RECOVERABLE_EVICTIONS.has(frame.code)) return this.drop(`evicted: ${frame.code}`);
        return this.finish({ code: "protocol", detail: `evicted with an unrecognised code (${frame.code})` });
      case "refused": return this.onRefused(frame.status, frame.code);
      case "subscription_changed":
        if (!frame.rooms.includes(this.o.roomId)) this.finish({ code: "room_lost", detail: "the gate's room is no longer claimed by this connection" });
        return;
      case "room_released":
        if (frame.roomId === this.o.roomId) this.finish({ code: "room_lost", detail: "the gate's room was released from this connection" });
        return;
      case "gap":
        this.o.log.error({ op: "switch.gap" }, "Switch reported a gap: some events were not delivered and cannot be replayed");
        return;
      case "ignored": return;
      case "invalid":
        if (this.state === "opening") return this.finish({ code: "protocol", detail: `invalid frame while opening (${frame.reason})` });
        this.o.log.error({ op: "switch.frame", event: frame.event, reason: frame.reason }, "dropped an invalid Switch frame");
        return;
    }
  }

  private onState(s: ConnectionState): void {
    if (this.state !== "opening") return this.finish({ code: "protocol", detail: "unexpected second connection_state" });
    if (s.agent_id !== this.o.agentId) return this.finish({ code: "protocol", detail: "connection_state names a different agent" });
    if (s.connection_id !== this.record.connectionId) return this.finish({ code: "protocol", detail: "connection_state names a different connection" });
    if (s.protocol !== AGENT_PROTOCOL) return this.finish({ code: "protocol", detail: `server speaks agent-protocol ${s.protocol}, expected ${AGENT_PROTOCOL}` });
    if (this.record.generation !== null && s.generation <= this.record.generation) {
      return this.finish({ code: "stale_generation", detail: "the server issued a generation that is not newer than the one held" });
    }
    if (!s.rooms.includes(this.o.roomId)) return this.finish({ code: "room_lost", detail: "the connection opened without the gate's room" });
    this.current = s;
    // The saved position moves only as messages are processed. The server's position is
    // taken only on a first open, when nothing can be queued from an earlier socket.
    this.record = { connectionId: s.connection_id, generation: s.generation, position: this.record.position ?? s.position };
    this.o.store.save(this.record);
    this.state = "open";
    // The attempt count resets only once the connection has stayed up, so a server
    // that accepts and then drops every open still runs out of attempts.
    const generation = s.generation;
    this.after(s.heartbeat_interval_seconds * 1000 * STABLE_HEARTBEATS, () => {
      if (this.state === "open" && this.current?.generation === generation) this.attempts = 0;
    });
    this.armWatchdog(s.heartbeat_interval_seconds);
    this.armBeat();
    this.o.log.info({ op: "switch.open", generation: s.generation, rooms: s.rooms.length }, "connected to Switch");
  }

  private onPing(): void {
    if (this.state !== "open" || this.socket === null || this.current === null) return;
    this.socket.send(JSON.stringify({ type: "pong", cursor: this.current.cursor ?? 0 }));
    this.armWatchdog(this.current.heartbeat_interval_seconds);
  }

  private onMessage(frame: Extract<Frame, { kind: "message" }>): void {
    if (this.state !== "open") return;
    const e = frame.event;
    const position = e.position;
    const sameRoom = e.room_id === this.o.roomId;
    const msg = sameRoom ? toInbound(e) : null;
    if (msg === null && sameRoom) {
      // Not representable (e.g. an oversized body): it is skipped for good, so say which one.
      this.o.log.error({ op: "switch.message", messageId: e.payload.message_id }, "dropped a message in the gate's room that the gate cannot accept");
    }
    // Handed over strictly in order; the position is saved only after the handler ran.
    // Nothing runs once the connection has stopped: a client that lost the connection
    // (or is shutting down) must not act on messages, and the position is left for the
    // holder (or the next start, where the router's de-duplication makes replay safe).
    this.queue = this.queue
      .then(async () => {
        if (this.stopped) return;
        if (msg !== null) {
          try {
            await this.o.onMessage(msg);
          } catch (err) {
            this.o.log.error({ op: "switch.handle", messageId: msg.messageId, err: err instanceof Error ? err.name : "unknown" }, "message handler failed");
          }
        }
        if (this.stopped) return;
        this.record = { ...this.record, position: advance(this.record.position ?? {}, position) };
        this.o.store.save(this.record);
      })
      .catch((err: unknown) => {
        this.finish({ code: "storage", detail: `could not save the resume position (${err instanceof Error ? err.name : "unknown"})` });
      });
  }

  /** Resolves once every queued message has been handed over (or skipped after a stop). */
  async drained(): Promise<void> {
    await this.queue;
  }

  private onRefused(status: number, code: string | null): void {
    if (code === "taken_over") return this.finish({ code: "taken_over", detail: "reattach refused: another client holds this connection" });
    if (status === 401) return this.finish({ code: "unauthorized", detail: "Switch refused the agent credential" });
    if (status === 403 || status === 404) return this.finish({ code: "forbidden", detail: `Switch refused the connection (${status}); check that the gate is a member of its room` });
    if (status >= 500) return this.drop(`refused with ${status}`);
    this.finish({ code: "protocol", detail: `Switch refused the connection (${status})` });
  }

  private onClose(code: number): void {
    if (this.state === "stopped") return;
    if (code === 4409) return this.finish({ code: "taken_over", detail: "socket closed with 4409" });
    if (code === 4401) return this.finish({ code: "unauthorized", detail: "socket closed with 4401" });
    if (code === 4403 || code === 4404) return this.finish({ code: "forbidden", detail: `socket closed with ${code}` });
    if (code >= 4400 && code < 4500) return this.finish({ code: "protocol", detail: `socket closed with ${code}` });
    this.socket = null;
    this.retry(`socket closed (${code})`);
  }

  // --- heartbeat ---------------------------------------------------------------

  private armWatchdog(intervalSeconds: number): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.state === "open") this.drop("no ping from Switch within the heartbeat window");
    }, intervalSeconds * 1000 * MISSED_PINGS_BEFORE_RECONNECT);
  }

  private armBeat(): void {
    const every = this.o.beatIntervalMs ?? 30_000;
    if (every <= 0) return;
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = setInterval(() => {
      this.sendBeat().catch((e: unknown) => {
        this.o.log.error({ op: "switch.beat", err: e instanceof Error ? e.name : "unknown" }, "heartbeat check failed");
      });
    }, every);
  }

  /** The fenced beat: the server checks the generation and answers 409 `taken_over` to a displaced client. */
  async sendBeat(): Promise<void> {
    const conn = this.connection;
    if (conn === null) return;
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.bridgeUrl.replace(/\/+$/, "")}/agents/${encodeURIComponent(this.o.agentId)}/connection/beat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: conn.connectionId, generation: conn.generation }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.o.log.warn({ op: "switch.beat" }, "heartbeat request failed; relying on the socket");
      return;
    }
    const text = await res.text().catch(() => "");
    if (res.ok) return;
    // A refusal for a generation this client no longer holds says nothing about the current one.
    if (this.connection?.generation !== conn.generation) return;
    if (res.status === 409 && refusalIsTakenOver(text)) return this.finish({ code: "taken_over", detail: "heartbeat refused: another client holds this connection" });
    if (res.status === 401) return this.finish({ code: "unauthorized", detail: "heartbeat refused the agent credential" });
    this.o.log.warn({ op: "switch.beat", status: res.status }, "heartbeat refused; reopening");
    this.drop(`heartbeat refused (${res.status})`);
  }

  // --- lifecycle -----------------------------------------------------------------

  /** Close the socket and reconnect (transient). */
  private drop(why: string): void {
    if (this.state === "stopped") return;
    const s = this.socket;
    this.socket = null;
    this.clearConnectionTimers();
    try { s?.close(1000, "reconnecting"); } catch { /* already closed */ }
    this.retry(why);
  }

  private retry(why: string): void {
    if (this.state === "stopped") return;
    this.clearConnectionTimers();
    this.current = null;
    if (this.attempts >= this.reconnect.maxAttempts) {
      return this.finish({ code: "retries_exhausted", detail: `could not reconnect after ${this.attempts} attempts (last: ${why})` });
    }
    const exp = Math.min(this.reconnect.maxMs, this.reconnect.baseMs * 2 ** this.attempts);
    const delay = Math.round(exp / 2 + (this.o.random ?? Math.random)() * (exp / 2));
    this.attempts += 1;
    this.state = "waiting";
    this.o.log.warn({ op: "switch.reconnect", attempt: this.attempts, delayMs: delay, why }, "Switch connection lost; reconnecting");
    this.after(delay, () => { if (this.state === "waiting") this.open(); });
  }

  private finish(reason: StopReason): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.clearConnectionTimers();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const s = this.socket;
    this.socket = null;
    try { s?.close(1000, reason.code); } catch { /* already closed */ }
    const level = reason.code === "stopped" ? "info" : "error";
    this.o.log[level]({ op: "switch.stop", code: reason.code }, reason.detail);
    try {
      this.o.onStop(reason);
    } catch (e) {
      this.o.log.error({ op: "switch.stop", err: e instanceof Error ? e.name : "unknown" }, "stop handler failed");
    }
  }

  private clearConnectionTimers(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    if (this.beat !== null) clearInterval(this.beat);
    this.watchdog = null;
    this.beat = null;
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }
}

function refusalIsTakenOver(body: string): boolean {
  try {
    const j = JSON.parse(body) as { detail?: { code?: unknown } };
    return j.detail?.code === "taken_over";
  } catch {
    return false;
  }
}
