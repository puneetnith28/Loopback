import { z } from "zod";
import type { Db } from "../persistence/db.js";
import { kvGet, kvSet } from "../persistence/repos.js";
import type { ConnectionRecord, ConnectionStore } from "./connection.js";
import { Position, SafeCount } from "./frames.js";

/** One record per room (D26): each room's connection has its own id, generation and position. */
export const connectionKey = (roomId: string): string => `switch_connection:${roomId}`;
/** The single-room key used before D26; adopted by the maintainers' room so an upgrade reattaches fenced. */
export const LEGACY_CONNECTION_KEY = "switch_connection";

const Stored = z.object({
  connectionId: z.string().min(1).max(256),
  generation: SafeCount.nullable(),
  position: Position.nullable(),
});

export class StoredConnectionError extends Error {
  constructor() {
    super("the stored Switch connection record is unreadable; refusing to guess a connection or generation");
    this.name = "StoredConnectionError";
  }
}

/**
 * Keeps the connection id, the generation last held and the resume position in the
 * gate's database, so a restarted gate reattaches fenced on that generation and
 * resumes where it stopped. A corrupt record fails closed: it is never replaced
 * by a fresh connection, which would silently take over from a live holder.
 * With `adoptLegacy`, a record saved under the pre-D26 single key is used until this
 * room saves its own (the maintainers' room is the room the single connection held).
 */
export function sqliteConnectionStore(db: Db, roomId: string, opts: { readonly adoptLegacy?: boolean } = {}): ConnectionStore {
  const KEY = connectionKey(roomId);
  return {
    load(): ConnectionRecord | null {
      const raw = kvGet(db, KEY) ?? (opts.adoptLegacy === true ? kvGet(db, LEGACY_CONNECTION_KEY) : undefined);
      if (raw === undefined) return null;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new StoredConnectionError();
      }
      const r = Stored.safeParse(json);
      if (!r.success) throw new StoredConnectionError();
      return r.data;
    },
    save(record: ConnectionRecord): void {
      kvSet(db, KEY, JSON.stringify(record));
    },
  };
}
