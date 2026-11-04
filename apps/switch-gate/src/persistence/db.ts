import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type Db = Database.Database;

/**
 * Open a database connection with the pragmas every connection needs.
 * foreign_keys is per-connection in SQLite, so it is set here, never assumed.
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    db.close();
    throw new Error("SQLite foreign key enforcement could not be enabled");
  }
  return db;
}

/** Apply pending migrations in order, each in its own transaction. Idempotent. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_version").all() as { version: number }[]).map((r) => r.version),
  );
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    })();
    done.push(m.version);
  }
  return done;
}
