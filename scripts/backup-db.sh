#!/usr/bin/env bash
# Online, consistent backup of the Loopback SQLite database (safe while the gate runs).
#   DB_PATH=./data/loopback.db BACKUP_DIR=./data/backups KEEP=14 scripts/backup-db.sh
# Verifies the copy with PRAGMA integrity_check and keeps the newest $KEEP backups.
set -euo pipefail

DB_PATH="${DB_PATH:-./data/loopback.db}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB_PATH")/backups}"
KEEP="${KEEP:-14}"

die() { printf 'backup-db: %s\n' "$*" >&2; exit 1; }
command -v sqlite3 >/dev/null || die "sqlite3 is required"
[[ -f "$DB_PATH" ]] || die "database not found: $DB_PATH"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "KEEP must be a positive integer"

umask 077
mkdir -p "$BACKUP_DIR"
target="$BACKUP_DIR/loopback-$(date -u +%Y%m%dT%H%M%SZ).db"
[[ -e "$target" ]] && die "backup already exists: $target"

sqlite3 "$DB_PATH" ".backup '$target'"
check="$(sqlite3 "$target" 'PRAGMA integrity_check;')"
if [[ "$check" != "ok" ]]; then
  mv "$target" "$target.corrupt"
  die "integrity check failed for $target (kept as .corrupt)"
fi

# Retention: newest $KEEP verified backups stay; older ones are removed.
mapfile -t old < <(ls -1t "$BACKUP_DIR"/loopback-*.db 2>/dev/null | tail -n +"$((KEEP + 1))")
for f in "${old[@]}"; do rm -f -- "$f"; done

printf 'backup ok: %s\n' "$target"
