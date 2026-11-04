# Phase 6 — M1 read-only evidence (2026-11-04)

All checks below are GET-only against `puneetnith28/loopback-demo-target`, made with the
maintainer's `gh` session. Nothing was created, changed or merged.

## Repository and seeded bug (1.5, 6.1)

| Fact | Evidence |
|---|---|
| Repository exists, public | `gh api repos/puneetnith28/loopback-demo-target` |
| `demo-reset` tag = `main` = `70a5362de6f0ae97b11b83c4406d6316433daa8d` | `GET /tags`, `GET /branches/main` |
| `DEMO_RESET_SHA` in local `.env` equals that SHA | exact-line match (value is not secret) |
| CI workflow `.github/workflows/ci.yml` runs `npm test` on `pull_request` to `main` and `demo/**`; `permissions: contents: read`; actions pinned by SHA | `GET /contents/.github/workflows/ci.yml` |
| Issue #1 open: "formatToken throws TypeError when custom replace mapping contains null" | `gh issue list` |
| Seeded test `formatToken - Issue #1: handles null replacement without throwing TypeError` exists at `demo-reset` (`test/index.test.js:34`) and the code at `demo-reset` calls `value.toString()` on `null` (`src/index.js`), so the test fails there | static read of the tree at `70a5362` |
| PR #2 (head `e804775`) changes only `src/index.js` (+2/−5) to treat `null`/`undefined` as `""` | `git diff 70a5362 e804775` |
| `test` check run on `e804775`: completed / success, app id 15368 (GitHub Actions) | `GET /commits/e804775/check-runs` |

The seeded test was **not** executed locally in this session (running fetched code was refused by
the session's permission classifier). Runtime evidence is the GitHub Actions `test` run on PR #2;
the failure at `demo-reset` is established by reading the code, not by a run.

Not yet present (6.1 stays partial): a tag ruleset protecting `demo-reset`, and a first
`demo/<run-id>` branch created by `scripts/reset-demo.sh`.

## GitHub App (6.2)

- `secrets/gate.pem` present, mode 0600.
- Commit status `loopback/gate` = `pending` on `e804775` (created 2026-11-03T19:44:59Z). Only the
  installed App can write a status that satisfies the ruleset pin below, and writing one needs a
  working installation token.
- Ruleset pins `loopback/gate` to integration id 5598944, which equals `GH_APP_ID` in `.env`.

## Ruleset (1.6, 6.5)

Exported to [`demo-target-ruleset-26472069.json`](demo-target-ruleset-26472069.json)
(`_links` and the caller-specific `current_user_can_bypass` removed).

- Enforcement `active`; targets `~DEFAULT_BRANCH` and `refs/heads/demo/*`; `bypass_actors: []`.
- Rules: `deletion`, `non_fast_forward`, `pull_request` (squash only, 0 approvals),
  `required_status_checks` (strict) with `test` → 15368 and `loopback/gate` → 5598944.

This answers Q6 (1.6) in the affirmative at configuration level: GitHub accepts a required check
pinned to the App. That a status from any other source does **not** satisfy it is part of the
nine-outcome proof (6.6), which needs the fixer/verifier tokens and is not run.

## Live read-only checks with the gate's App (6.7) and the setup script

- `LOOPBACK_LIVE_GITHUB=1 LOOPBACK_LIVE_PR=2 npx vitest run --project e2e tests/e2e/github-live.test.ts`
  (gate configuration from `.env`): **3 passed**. The App reads `GET /rules/branches` for `main` with
  `test` and `loopback/gate` required, PR required, up-to-date, force-push blocked, deletion
  restricted; the base head equals `DEMO_RESET_SHA`; PR #2 yields a consistent snapshot.
- `scripts/verify-github-setup.sh` (maintainer's `gh`, read-only): every branch-ruleset check PASS;
  `DEMO_RESET_SHA exists` PASS; **FAIL** `tag ruleset active, targets demo-reset` (no tag ruleset
  exists yet: owner step).
- Script bug found and fixed: `demo-reset` is an annotated tag, so its ref names a tag object
  (`bce9efd…`), not the commit; the check compared without peeling and failed for the correct SHA
  (and would have passed for the tag-object SHA). After the fix: PASS for `70a5362…`, FAIL for `bce9efd…`.
