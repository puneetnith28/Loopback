# Operations

## Current status

The gatekeeper's workflow, policy, persistence and GitHub layers are implemented and tested
with fakes. The Switch transport follows the installed switch-core 0.31.0 WebSocket protocol
(see [setup.md](setup.md)); live message flow and sender attribution are not verified yet.

`npm run gate` exit codes: `0` clean shutdown (SIGTERM/SIGINT), `1` configuration or startup
error (including an unreadable stored Switch connection record), `3` the Switch connection stopped
for good (`taken_over`, refused credential or membership, protocol mismatch, room lost, storage
failure, or reconnect attempts exhausted). Exit code 3 needs an operator: do not configure an
automatic restart loop, and never clear the stored connection record to get past a `taken_over`;
that would let a displaced gate take the connection back from the one holding it.

## Prerequisites

Full live setup steps and verification checks: [setup.md](setup.md).

Node.js 22 (`.nvmrc`), a GitHub App installed on the demo repository only (Contents R/W, Pull
requests R/W, Commit statuses R/W, Checks R, Metadata R), its private key at
`secrets/gate.pem` with mode `600`, and the values in `.env.example`.

## Start and stop order

1. `npm ci && npm run build`
2. `npm run migrate` — applies schema migrations to `DB_PATH` (idempotent).
3. Start Switch Console and the agent sessions (fixer and verifier in their isolated users).
4. `npm run gate` — on start the gate reconciles interrupted merges *before* polling or
   accepting commands. Stop with SIGINT/SIGTERM.

## Health

- `GET http://127.0.0.1:$HTTP_PORT/healthz` — process and database.
- `GET http://127.0.0.1:$HTTP_PORT/readyz` — names failing dependencies. Bound to 127.0.0.1;
  never expose it.

## Read-only mode

`MERGE_ENABLED=false` (the default) keeps everything working except merging: `merge` replies
`BLOCKED (MERGE_DISABLED)` and changes nothing. Enable merging only after branch protection is
proven (plan Phase 6 step 6). Privileged commands also stay disabled while
`SWITCH_HUMAN_SENDER_KIND` is unset.

## Inspecting cases

```bash
sqlite3 data/loopback.db "select id,state,blocked_reason,head_sha,updated_at from cases where state <> 'Merged'"
sqlite3 data/loopback.db "select id,case_id,attempt,status from merge_operations where status in ('started','unknown')"
```

In chat: `@loopback-gate status LB-001` and `@loopback-gate audit LB-001`.

## Interrupted or uncertain merges

- `MergeUnknown` cases are reconciled from GitHub automatically every poll interval. An
  uncertain outcome is given 60 s to settle before "not merged" is believed. Nothing is ever
  re-merged automatically: a passing revalidation stops at `Blocked (AWAITING_MERGE_COMMAND)`
  and waits for a maintainer `merge`.
- If `gate_status.correction_failed` appears in the audit, a success status may remain on an
  unmerged commit: set it manually to failure
  (`gh api repos/OWNER/REPO/statuses/SHA -f state=failure -f context=loopback/gate`) and do not
  merge that commit outside Loopback.

## Backup

`scripts/backup-db.sh` takes an online, consistent SQLite backup (safe while the gate runs),
verifies it with `PRAGMA integrity_check`, and keeps the newest `KEEP` (default 14) copies in
`data/backups/` (mode 600 via `umask 077`):

```bash
DB_PATH=./data/loopback.db KEEP=14 scripts/backup-db.sh
```

Daily schedule (systemd user timer; edit `WorkingDirectory` in the service first):

```bash
install -m 644 deploy/systemd/loopback-backup.service deploy/systemd/loopback-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now loopback-backup.timer
systemctl --user list-timers loopback-backup.timer
```

Restore: stop the gate, copy a backup over `DB_PATH`, start the gate (it reconciles on start).
The audit log and approvals are append-only and survive restore.

## Container

```bash
docker build -t loopback-gate .
docker run --rm -v loopback-data:/data loopback-gate node apps/switch-gate/dist/persistence/migrate-cli.js
docker run -d --name loopback-gate --env-file .env -v loopback-data:/data \
  -v "$PWD/secrets/gate.pem:/secrets/gate.pem:ro" -e GH_APP_PRIVATE_KEY_PATH=/secrets/gate.pem loopback-gate
```

The image is multi-stage (the native build toolchain exists only in the build stage), runs as the
unprivileged `node` user, keeps state only in `/data`, and health-checks `/healthz` from inside
the container (the endpoints bind to 127.0.0.1 and are never published). The private key must be
mounted read-only and remain mode 600 on the host.

## Demo reset

`GH_REPO=owner/fork DEMO_RESET_SHA=<sha> RULESET_ID=<id> scripts/reset-demo.sh` — re-checks the
ruleset with your credentials, closes case PRs, creates a fresh `demo/<run-id>` from the recorded
SHA, archives the database and prints `DEMO_RUN_ID`/`BASE_BRANCH` for the run.

## Rotating credentials

- **GitHub App key:** generate a new key in the App settings, replace `secrets/gate.pem`
  (mode 600), restart the gate, then delete the old key in GitHub.
- **Fixer/verifier PATs:** create replacements with the same minimal permissions, update the
  agent environments, revoke the old tokens; confirm revocation returns 401.
- **Switch agent key:** re-register or rotate in Switch, update `SWITCH_AGENT_API_KEY`.
