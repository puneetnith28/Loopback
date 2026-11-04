import { z } from "zod";
import { InboundMessage } from "@loopback/contracts";

/**
 * Frames of the Switch agent WebSocket (switch-core 0.31.0, agent-protocol 9), as
 * read from the installed server and observed live. Every frame is untrusted input:
 * it is validated here before anything acts on it, and a frame that does not match
 * is reported as invalid rather than coerced.
 */

/** The agent-protocol revision this client speaks and requires the server to speak. */
export const AGENT_PROTOCOL = 9;

/** A non-negative integer that survives JSON as an exact JS number. Never coerced. */
export const SafeCount = z.number().refine((n) => Number.isSafeInteger(n) && n >= 0, "must be a non-negative safe integer");

/** Resume position: `s` (the agent's own events) or `r:<room>` → sequence. */
export const Position = z.record(z.string().regex(/^(s|r:.+)$/), SafeCount);
export type Position = z.infer<typeof Position>;

const ConnectionState = z.object({
  connection_id: z.string().min(1),
  agent_id: z.string().min(1),
  generation: SafeCount,
  protocol: z.number().int(),
  heartbeat_interval_seconds: z.number().positive().max(300),
  rooms: z.array(z.string().min(1)),
  cursor: SafeCount.optional(),
  position: Position,
});
export type ConnectionState = z.infer<typeof ConnectionState>;

const Evicted = z.object({ code: z.string().min(1), reason: z.string().optional(), room_id: z.string().nullable().optional() });
const Refused = z.object({ status: z.number().int(), detail: z.unknown() });
const SubscriptionChanged = z.object({ rooms: z.array(z.string().min(1)) });
const RoomReleased = z.object({ room_id: z.string().min(1) });
/** `gap`: events the server could not deliver (stream.py `_gap`); rooms may be empty when `all_rooms`. */
const Gap = z.object({ rooms: z.array(z.string().min(1)).optional(), all_rooms: z.boolean().optional(), reason: z.string().optional() });

/** `MessagePayload` as the server builds it; optional fields may be absent on old rows. */
const MessagePayload = z.object({
  addressed: z.boolean(),
  sender: z.string().min(1),
  sender_name: z.string(),
  // Attribution keys are required (null allowed): an absent key must not read as the
  // human value null. Every live switch-core 0.31.0 payload carried both.
  sender_kind: z.string().min(1).nullable(),
  on_behalf_of: z.string().min(1).nullable(),
  message_id: z.string().min(1),
  body: z.string(),
  timestamp: SafeCount,
  thread_id: z.string().min(1).nullable().optional(),
  sender_role: z.string().min(1).nullable().optional(),
});
const MessageEvent = z.object({
  type: z.literal("message"),
  room_id: z.string().min(1),
  payload: MessagePayload,
  sequence: SafeCount.optional(),
  position: Position.optional(),
});
export type MessageEvent = z.infer<typeof MessageEvent>;

const Envelope = z.object({ event: z.string().min(1), data: z.record(z.string(), z.unknown()), id: SafeCount.optional() });

export type Frame =
  | { readonly kind: "connection_state"; readonly state: ConnectionState }
  | { readonly kind: "ping" }
  | { readonly kind: "evicted"; readonly code: string }
  | { readonly kind: "refused"; readonly status: number; readonly code: string | null }
  | { readonly kind: "message"; readonly event: MessageEvent }
  | { readonly kind: "gap"; readonly rooms: readonly string[]; readonly allRooms: boolean; readonly reason: string }
  | { readonly kind: "subscription_changed"; readonly rooms: readonly string[] }
  | { readonly kind: "room_released"; readonly roomId: string }
  /** A frame this client does not act on (e.g. room_join, session_command). */
  | { readonly kind: "ignored"; readonly event: string }
  | { readonly kind: "invalid"; readonly event: string | null; readonly reason: string };

const invalid = (event: string | null, reason: string): Frame => ({ kind: "invalid", event, reason });

function refusalCode(detail: unknown): string | null {
  if (typeof detail === "object" && detail !== null && "code" in detail) {
    const code = detail.code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** Parse one raw WebSocket message. Never throws. */
export function parseFrame(raw: unknown): Frame {
  if (typeof raw !== "string") return invalid(null, "not a text frame");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid(null, "not JSON");
  }
  const env = Envelope.safeParse(json);
  if (!env.success) return invalid(null, "malformed envelope");
  const { event, data } = env.data;
  const parse = <T>(schema: z.ZodType<T>, build: (v: T) => Frame): Frame => {
    const r = schema.safeParse(data);
    return r.success ? build(r.data) : invalid(event, `malformed ${event} data`);
  };
  switch (event) {
    case "connection_state": return parse(ConnectionState, (state) => ({ kind: "connection_state", state }));
    case "ping": return { kind: "ping" };
    case "evicted": return parse(Evicted, (d) => ({ kind: "evicted", code: d.code }));
    case "refused": return parse(Refused, (d) => ({ kind: "refused", status: d.status, code: refusalCode(d.detail) }));
    case "message": return parse(MessageEvent, (e) => ({ kind: "message", event: e }));
    case "gap": return parse(Gap, (d) => ({ kind: "gap", rooms: d.rooms ?? [], allRooms: d.all_rooms ?? false, reason: (d.reason ?? "").slice(0, 200) }));
    case "subscription_changed": return parse(SubscriptionChanged, (d) => ({ kind: "subscription_changed", rooms: d.rooms }));
    case "room_released": return parse(RoomReleased, (d) => ({ kind: "room_released", roomId: d.room_id }));
    default: return { kind: "ignored", event };
  }
}

/**
 * Map a message event to the gate's inbound contract. Raw attribution fields are
 * carried unchanged (an absent field becomes null, never a guessed value); the
 * gate's policy decides what they mean. Returns null when the event cannot be
 * represented faithfully (e.g. an oversized body), so the caller drops it.
 */
export function toInbound(e: MessageEvent): InboundMessage | null {
  const p = e.payload;
  const sequence = e.position?.[`r:${e.room_id}`] ?? e.sequence ?? 0;
  const r = InboundMessage.safeParse({
    eventId: p.message_id,
    roomId: e.room_id,
    sequence,
    messageId: p.message_id,
    sender: p.sender,
    senderKind: p.sender_kind,
    onBehalfOf: p.on_behalf_of,
    senderRole: p.sender_role ?? null,
    addressed: p.addressed,
    body: p.body,
    threadId: p.thread_id ?? null,
    timestamp: p.timestamp,
  });
  return r.success ? r.data : null;
}

/** Merge a frame's position into the running one; positions only move forward. */
export function advance(current: Position, update: Position | undefined): Position {
  if (update === undefined) return current;
  const next: Record<string, number> = { ...current };
  for (const [source, seq] of Object.entries(update)) {
    if (seq > (next[source] ?? -1)) next[source] = seq;
  }
  return next;
}
