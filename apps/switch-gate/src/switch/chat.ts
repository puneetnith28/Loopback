import { z } from "zod";
import type { ChatPort } from "../chat/port.js";

/**
 * Outbound chat over the Switch agent bridge (switch-core 0.31.0).
 *
 * - Top-level messages: `POST /agents/{id}/message {room_id, content}`. This route
 *   has no thread parameter (the handler ignores `metadata`).
 * - Threaded replies: `POST /agents/{id}/ops/post_message {body, thread_id}` with
 *   `X-Switch-Connection-Id`, which posts into the connection's single claimed room
 *   and normalises `thread_id` to the thread root (server source:
 *   operations/definitions.py `post_message`).
 *
 * Posts are not retried: a request whose response was lost may already have been
 * delivered, and a duplicate gate message is worse than a logged failure.
 */

export class SwitchPostError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "SwitchPostError";
  }
}

export interface ChatConnection {
  /** The open connection, or null while (re)connecting. */
  readonly connection: { readonly connectionId: string; readonly rooms: readonly string[] } | null;
  /** True once the connection has stopped for good (taken over, refused, shut down). */
  readonly stopped: boolean;
  takenOver(detail: string): void;
}

export interface SwitchChatOptions {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly roomId: string;
  readonly fetch: typeof fetch;
  readonly connection: ChatConnection;
  readonly timeoutMs?: number;
}

const PostResult = z.union([
  z.object({ ok: z.literal(true), event_id: z.string().min(1) }),
  z.object({ result: z.object({ event_id: z.string().min(1) }) }),
]);

export class SwitchChat implements ChatPort {
  constructor(private readonly o: SwitchChatOptions) {}

  async post(roomId: string, content: string, threadId: string | null): Promise<void> {
    await this.postWithId(roomId, content, threadId);
  }

  /** Post and return the Switch event id of the new message. */
  async postWithId(roomId: string, content: string, threadId: string | null): Promise<string> {
    // A gate that lost its connection (or is shutting down) no longer speaks for loopback-gate.
    if (this.o.connection.stopped) throw new SwitchPostError(null, "the Switch connection has stopped; not posting");
    if (roomId !== this.o.roomId) throw new SwitchPostError(null, "the gate posts only in its configured room");
    if (content.trim() === "") throw new SwitchPostError(null, "refusing to post an empty message");
    const base = `${this.o.bridgeUrl.replace(/\/+$/, "")}/agents/${encodeURIComponent(this.o.agentId)}`;
    if (threadId === null) return this.send(`${base}/message`, { room_id: roomId, content }, {});
    const conn = this.o.connection.connection;
    if (conn === null) throw new SwitchPostError(null, "not connected to Switch; a threaded reply needs an open connection");
    // post_message targets the connection's only room; refuse if that is not the gate's room.
    if (conn.rooms.length !== 1 || conn.rooms[0] !== roomId) {
      throw new SwitchPostError(null, "the open connection is not bound to exactly the gate's room");
    }
    return this.send(`${base}/ops/post_message`, { body: content, thread_id: threadId }, { "X-Switch-Connection-Id": conn.connectionId });
  }

  private async send(url: string, body: object, extra: Record<string, string>): Promise<string> {
    let res: Response;
    try {
      res = await this.o.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json", ...extra },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new SwitchPostError(null, `Switch did not answer (${e instanceof Error ? e.name : "unknown"})`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const code = detailCode(text);
      if (res.status === 409 && code === "taken_over") this.o.connection.takenOver("a post was refused: another client holds this connection");
      throw new SwitchPostError(res.status, `Switch refused the message (${res.status}${code !== null ? `, ${code}` : ""})`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SwitchPostError(res.status, "Switch answered with a body that is not JSON");
    }
    const parsed = PostResult.safeParse(json);
    if (!parsed.success) throw new SwitchPostError(res.status, "Switch answered without an event id");
    return "event_id" in parsed.data ? parsed.data.event_id : parsed.data.result.event_id;
  }
}

function detailCode(body: string): string | null {
  try {
    const j = JSON.parse(body) as { detail?: { code?: unknown } };
    return typeof j.detail?.code === "string" ? j.detail.code : null;
  } catch {
    return null;
  }
}
