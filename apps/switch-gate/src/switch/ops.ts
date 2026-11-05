import { z } from "zod";

/**
 * Switch agent operations (switch-core 0.31.0, `bridges/agent/api/operations.py`).
 * `GET /agents/{id}/ops` lists every operation (verified live: `{"operations": {...}}`);
 * `POST /agents/{id}/ops/{name}` runs one and answers `{"result": ...}`.
 */

/** Operations the gate depends on (step 3.6): threaded replies and gap recovery. */
export const REQUIRED_OPERATIONS = ["post_message", "read_context"] as const;

export type OpsDiscovery =
  | { readonly ok: true; readonly operations: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] };

export interface OpsClientOptions {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

const OpsList = z.object({ operations: z.record(z.string(), z.unknown()) });

const base = (o: OpsClientOptions) => `${o.bridgeUrl.replace(/\/+$/, "")}/agents/${encodeURIComponent(o.agentId)}`;

/** Discover the agent's operations and require REQUIRED_OPERATIONS. Any failure is a named, failed discovery. */
export async function discoverOperations(o: OpsClientOptions): Promise<OpsDiscovery> {
  let res: Response;
  try {
    res = await o.fetch(`${base(o)}/ops`, {
      method: "GET",
      headers: { Authorization: `Bearer ${o.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e) {
    return { ok: false, reason: `could not list Switch operations (${e instanceof Error ? e.name : "unknown"})`, missing: [...REQUIRED_OPERATIONS] };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, reason: `could not list Switch operations (HTTP ${res.status})`, missing: [...REQUIRED_OPERATIONS] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the Switch operations list is not JSON", missing: [...REQUIRED_OPERATIONS] };
  }
  const parsed = OpsList.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "the Switch operations list has an unexpected shape", missing: [...REQUIRED_OPERATIONS] };
  const operations = new Set(Object.keys(parsed.data.operations));
  const missing = REQUIRED_OPERATIONS.filter((op) => !operations.has(op));
  if (missing.length > 0) return { ok: false, reason: `required Switch operations missing: ${missing.join(", ")}`, missing };
  return { ok: true, operations };
}

export type OpResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly status: number | null; readonly reason: string };

/**
 * Run one operation. A room-bound operation names the connection that claimed the room. A failure
 * is reported by status only: Switch's answer is not echoed into logs.
 */
export async function callOperation(o: OpsClientOptions, operation: string, body: Record<string, unknown>, connectionId?: string): Promise<OpResult> {
  let res: Response;
  try {
    res = await o.fetch(`${base(o)}/ops/${encodeURIComponent(operation)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", ...(connectionId === undefined ? {} : { "X-Switch-Connection-Id": connectionId }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e) {
    return { ok: false, status: null, reason: `no answer (${e instanceof Error ? e.name : "unknown"})` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
  try {
    return { ok: true, result: (JSON.parse(text) as { result?: unknown }).result ?? null };
  } catch {
    return { ok: false, status: res.status, reason: "the answer is not JSON" };
  }
}

const RoomStatuses = z.object({ agent_statuses: z.record(z.string(), z.string().nullable()) });

/** Each agent's status in a room, as Switch reports it (`get_room_detail`). Null when unavailable. */
export async function readRoomStatuses(o: OpsClientOptions, roomId: string): Promise<ReadonlyMap<string, string> | null> {
  const res = await callOperation(o, "get_room_detail", { room_id: roomId });
  if (!res.ok) return null;
  const parsed = RoomStatuses.safeParse(res.result);
  if (!parsed.success) return null;
  return new Map(Object.entries(parsed.data.agent_statuses).map(([name, status]) => [name, status ?? "unknown"]));
}

/** One timeline entry from `read_context` (no `addressed` flag: never usable as a command). */
export interface ContextEntry {
  readonly id: string;
  readonly kind: string;
  readonly sender: string;
  readonly body: string;
  readonly timestamp: number;
}

const Entry = z.object({
  id: z.string().min(1),
  kind: z.string(),
  sender: z.string().min(1),
  body: z.string().optional(),
  timestamp: z.number(),
});
const Context = z.object({
  result: z.object({
    threads: z.array(z.object({ root: Entry, replies: z.array(Entry) })),
    truncated: z.boolean(),
  }),
});

export type ContextRead =
  | { readonly ok: true; readonly entries: readonly ContextEntry[]; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a room's recent timeline (`read_context`), bound to that room's connection.
 * Membership is enforced by Switch; the room is named explicitly so a gap in one room
 * is never recovered from another.
 */
export async function readContext(o: OpsClientOptions, roomId: string, connectionId: string, limit = 100): Promise<ContextRead> {
  let res: Response;
  try {
    res = await o.fetch(`${base(o)}/ops/read_context`, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", "X-Switch-Connection-Id": connectionId },
      body: JSON.stringify({ limit, room_id: roomId }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e) {
    return { ok: false, reason: `read_context failed (${e instanceof Error ? e.name : "unknown"})` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, reason: `read_context failed (HTTP ${res.status})` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "read_context answered with a body that is not JSON" };
  }
  const parsed = Context.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "read_context answered with an unexpected shape" };
  const entries: ContextEntry[] = [];
  for (const t of parsed.data.result.threads) {
    for (const e of [t.root, ...t.replies]) {
      if (e.kind === "message") entries.push({ id: e.id, kind: e.kind, sender: e.sender, body: e.body ?? "", timestamp: e.timestamp });
    }
  }
  return { ok: true, entries, truncated: parsed.data.result.truncated };
}
