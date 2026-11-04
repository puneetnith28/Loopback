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
  process.stderr.write(`${err instanceof ConfigError ? err.message : "migration failed"}\n`);
  process.exitCode = 1;
}
