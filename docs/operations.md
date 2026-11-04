# Operations

## Current status

The gatekeeper's workflow, policy, persistence and GitHub layers are implemented and tested
with fakes. **The Switch transport is not implemented yet**: it must follow the protocol of the
installed Switch version (decision D23), which has not been installed or verified. Until it
exists, `npm run gate` validates configuration and then refuses to start (exit code 2).

## Prerequisites

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

```bash
sqlite3 data/loopback.db ".backup data/backup-$(date +%F).db"
```

Schedule it daily (for example a user crontab entry). Restore by stopping the gate and copying
the backup over `DB_PATH`; the audit log and approvals are append-only and survive restore.

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
