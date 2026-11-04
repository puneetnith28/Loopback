import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, loadRuntimeConfig } from "../config.js";
import { migrate, openDatabase } from "./db.js";

// `npm run migrate`: apply pending schema migrations to DB_PATH.
try {
  const runtime = loadRuntimeConfig(process.env);
  if (runtime.dbPath !== ":memory:") mkdirSync(dirname(runtime.dbPath), { recursive: true, mode: 0o700 });
  const db = openDatabase(runtime.dbPath);
  const applied = migrate(db);
  db.close();
  process.stdout.write(applied.length > 0 ? `applied migrations: ${applied.join(", ")}\n` : "schema is up to date\n");
} catch (err) {
  // Config errors never contain values; other errors are named (and clipped) so failures are diagnosable.
  const detail = err instanceof ConfigError
    ? err.message
    : `migration failed: ${err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : "unknown error"}`;
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
