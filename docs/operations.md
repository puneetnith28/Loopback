# Operations

## Current status

The gatekeeper's workflow, policy, persistence and GitHub layers are implemented and tested
with fakes. The Switch transport follows the installed switch-core 0.31.0 WebSocket protocol
(see [setup.md](setup.md)). The two-room design (private maintainers' room, public intake room,
one connection each) is implemented and tested with fakes only: the intake room and the two-rule
addressing policy do not exist on the live install yet, so this build exits with code 4 there
until they are set up.

`npm run gate` exit codes: `0` clean shutdown (SIGTERM/SIGINT), `1` configuration or startup
error (including an unreadable stored Switch connection record), `3` the Switch connection stopped
for good (`taken_over`, refused credential or membership, protocol mismatch, room lost, storage
failure, or reconnect attempts exhausted) — in either room; both rooms stop together — `4` the
addressing policy is not the expected one (below), `5` Switch does not offer the `post_message`
and `read_context` operations the gate needs. Exit code 3 needs an operator: do not configure an
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
4. `npm run gate` — on start the gate checks the Switch policy and operations, reconciles
   interrupted merges and every open case against GitHub *before* polling or accepting commands,
   then connects to both rooms and serves the health endpoints. Stop with SIGINT/SIGTERM: the
   handlers are installed before any startup work, so a signal during startup reconciliation
   finishes the running work and exits 0 without connecting; a second signal changes nothing; a
   shutdown still running after 30 s exits with code 1.

## Health

- `GET http://127.0.0.1:$HTTP_PORT/healthz` — process and database (`SELECT 1`).
- `GET http://127.0.0.1:$HTTP_PORT/readyz` — 200 only when: each room's connection is open with a
  heartbeat in the last 6 s (`switch-maintainers`, `switch-intake`), the required Switch operations
  were found (`switch-operations`), GitHub has core API quota left (`github`, cached 30 s), and the
  gate is not halted (`not-halted`). A 503 names only the failing checks. Bound to 127.0.0.1;
  never expose it.

## Read-only mode

`MERGE_ENABLED=false` (the default) keeps everything working except merging: `merge` replies
`BLOCKED (MERGE_DISABLED)` and changes nothing. Enable merging only after branch protection is
proven (plan Phase 6 step 6). Privileged commands (verify, approve, reject, merge, retask) are
refused with `PRIVILEGED_DISABLED` unless `LOOPBACK_PRIVILEGED_ENABLED=true`; it defaults to false.

Exit code `4` means the gate's Switch addressing policy is not the expected restrictive one (see
[setup.md](setup.md)); the gate starts nothing until it matches, and it re-checks the policy
every 60 s while running: a policy found wrong, or one unreadable three times in a row, stops the
gate with the same exit code. Privileged work already running stops at its next write boundary
(audited `GATE_HALTED`, not retried); re-send the command once the gate is back. The next start
reconciles any case left mid-merge.

## Public intake and triage

Public reports arrive in the intake room and wait in `Reported`; each posts a triage notice in
the maintainers' room. `@loopback-gate accept LB-xxx` tasks the fixer; `@loopback-gate decline
LB-xxx <reason>` closes it (`Blocked`, `TRIAGE_DECLINED`). Nothing is tasked automatically,
including by reconciliation. A reporter can check their own report with `status LB-xxx` in the
intake room. Limits: one copy of the same report per sender per 24 h, `INTAKE_MAX_REPORTS_PER_HOUR` per
sender per hour, at most 1,000 characters per report (invisible format characters removed), and
at most 50 public reports awaiting triage at once (further reports get `INTAKE_BUSY` until some
are triaged). The triage notice shows the whole report; if it cannot be posted, the gate re-sends
it every poll interval. A declined report cannot be retasked.

## Delivery gaps

If Switch reports undelivered events, the maintainers' room gets a notice with a count (no
content) and the audit log a `delivery.gap` entry listing the missed message ids and senders. The
missed messages were **not** executed: ask the senders to re-send. Every case is reconciled
against GitHub at the same time.

## Verification modes (D28)

`VERIFIER_ISOLATION_PROVEN=false` (current): verification is **advisory**; chat and the audit
(`verification: "advisory"`, `signature: "absent" | "unverified" | "valid"`) say so. With `true`,
every verifier report must be signed with the verifier's Ed25519 key; an unsigned or wrongly
signed report is refused with `VERIFIER_SIGNATURE_INVALID`, audited, and the run stays open (a
correct report can still complete it). A signature proves the report's origin and integrity, not
that tests were run.

Each new verification request supersedes the case's older open runs (audited
`verification.superseded`); a superseded run can never complete, so a late report for an old
request or an old head is refused.

## Inspecting cases

```bash
sqlite3 data/loopback.db "select id,state,blocked_reason,head_sha,updated_at from cases where state <> 'Merged'"
sqlite3 data/loopback.db "select id,case_id,attempt,status from merge_operations where status in ('started','unknown')"
```

In chat: `@loopback-gate status LB-001` and `@loopback-gate audit LB-001`.

## GitHub rate limits and outages

The poller pauses until GitHub's reset after a rate limit, and backs off (10 s, doubling to
5 min) after a pass in which GitHub failed for every case; one successful read resets it. Cases
are never moved on missing data meanwhile. `/readyz` re-checks a failed GitHub probe after 5 s
and keeps a good one for 30 s.

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

On Windows, see [windows.md](windows.md) for stopping the gate and scheduling backups
(`npm run backup` with Task Scheduler).

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
mounted read-only and remain mode 600 on the host. (Docker creates the container's `/secrets`
directory as 755; the gate accepts that because it only refuses key directories others can
*write* to.)

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
