import { z } from "zod";
import type { Db } from "../persistence/db.js";
import { kvGet, kvSet } from "../persistence/repos.js";
import type { ConnectionRecord, ConnectionStore } from "./connection.js";
import { Position, SafeCount } from "./frames.js";

const KEY = "switch_connection";

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
 */
export function sqliteConnectionStore(db: Db): ConnectionStore {
  return {
    load(): ConnectionRecord | null {
      const raw = kvGet(db, KEY);
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
