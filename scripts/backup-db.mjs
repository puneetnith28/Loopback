#!/usr/bin/env node
// Online, consistent backup of the Loopback SQLite database (safe while the gate runs), on any
// platform: it needs no sqlite3 command-line tool.
//   DB_PATH=./data/loopback.db BACKUP_DIR=./data/backups KEEP=14 node scripts/backup-db.mjs
// Verifies the copy with PRAGMA integrity_check and keeps the newest $KEEP backups.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";

function die(message) {
  process.stderr.write(`backup-db: ${message}\n`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || "./data/loopback.db";
const backupDir = process.env.BACKUP_DIR || join(dirname(dbPath), "backups");
const keepText = process.env.KEEP || "14";

// A backup holds the same audit data as the database, which the gate refuses to keep in OneDrive.
function inCloudSync(path) {
  const target = resolve(path).toLowerCase();
  return ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].some((name) => {
    const root = process.env[name];
    if (!root) return false;
    const prefix = resolve(root).toLowerCase();
    return target === prefix || target.startsWith(prefix + sep);
  });
}

if (!existsSync(dbPath)) die(`database not found: ${dbPath}`);
if (inCloudSync(backupDir)) die(`BACKUP_DIR is in a cloud-synced folder: ${backupDir}`);
if (!/^[1-9][0-9]*$/.test(keepText)) die("KEEP must be a positive integer");
const keep = Number(keepText);

mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, ""); // UTC with milliseconds; sorts by age
const target = join(backupDir, `loopback-${stamp}.db`);
if (existsSync(target)) die(`backup already exists: ${target}`);

const source = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  await source.backup(target);
} finally {
  source.close();
}
chmodSync(target, 0o600); // no effect on Windows, where the file inherits its folder's ACL

const copy = new Database(target, { readonly: true, fileMustExist: true });
const result = copy.pragma("integrity_check", { simple: true });
copy.close();
if (result !== "ok") {
  renameSync(target, `${target}.corrupt`);
  die(`integrity check failed for ${target} (kept as .corrupt)`);
}

// Retention: the newest $KEEP verified backups stay. Names carry a UTC stamp, so they sort by age.
const backups = readdirSync(backupDir).filter((f) => /^loopback-.*\.db$/.test(f)).sort().reverse();
for (const old of backups.slice(keep)) rmSync(join(backupDir, old), { force: true });

process.stdout.write(`backup ok: ${target}\n`);
