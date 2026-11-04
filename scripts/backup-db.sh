#!/usr/bin/env bash
# Kept for the systemd unit and existing commands; the backup itself is scripts/backup-db.mjs.
#   DB_PATH=./data/loopback.db BACKUP_DIR=./data/backups KEEP=14 scripts/backup-db.sh
set -euo pipefail
umask 077
exec node "$(dirname "${BASH_SOURCE[0]}")/backup-db.mjs"
