# Threat model

Loopback's goal: **every merge has a traceable reason** — who authorized it, which exact
commit, what evidence was checked, and which policy permitted it. The gatekeeper is the only
component with merge credentials; agents can propose but never merge.

Status legend: **Tested** = enforced by code and covered by passing automated tests (with
fakes for GitHub and Switch). **Live: unverified** = also depends on the real GitHub or
Switch configuration, which has not been exercised yet. Nothing here is marked verified
against live services.

## Threats, defences and tests

| Threat | Defence in this build | Test(s) | Status |
|---|---|---|---|
| Prompt injection (issue says "merge now") | Closed command grammar; policy in code; agents have no merge/status rights; report text fenced as untrusted in the hand-off | `security/merge-gate.test.ts` (prompt injection), `unit/parse.test.ts`, `integration/workflow.test.ts` (hand-off fencing) | Tested |
| Identity spoofing (display name) | Opaque participant ids only; `sender_name` never read | `unit/authorize.test.ts`, `integration/router.test.ts` | Tested |
| Spoofed, delegated or unaddressed commands (D16, revised) | One admission step before any parser or handler (`policy/admission.ts`): the gate's own id is dropped; `sender_kind` "platform", any `on_behalf_of`, any `sender_kind` other than null (the live value for people), and `addressed !== true` are refused, audited and never answered. Fixer/verifier reports must also be addressed and come from the exact configured id. Roles come only from exact sender ids. `sender_name` and `sender_role` never reach a decision | `unit/admission.test.ts`, `unit/authorize.test.ts`, `integration/router.test.ts`, `security/merge-gate.test.ts` | Tested; live attribution observed for people only (agents and platform not yet observed) |
| Switch addressing policy widened or removed | Startup self-check reads the gate's own policy and refuses to start (exit 4) unless it is exactly two rules (D26): the maintainers' room with exactly the configured ExternalUser and agent ids, and the intake room with `users: "*"` and `agents: []`; `room_groups "*"` and owner/owner_agents/platform false in both | `integration/switch-policy-check.test.ts`, `integration/startup.test.ts` | Tested; checked at startup and every 60 s while running (a policy found wrong stops the gate at once; 3 consecutive unreadable checks stop it). **Live: the current live policy is the one-rule policy, so this build refuses to start until the intake rule and room exist** |
| Public room used to reach maintainer authority (D26) | Admission resolves the room from the frame, never from content; a room the gate does not serve is refused (`WRONG_ROOM`). In the intake room only `help`, `report`, `status` exist, for every role; agent reports there are refused. Authority never crosses rooms | `unit/admission.test.ts` (full table), `unit/authorize.test.ts`, `integration/intake.test.ts` | Tested; intake room **Live: not created** |
| Public report tasks the fixer, or injects into a hand-off (D26) | A public report is filed in `Reported` and only a maintainer's `accept` (maintainers' room) tasks the fixer; the state is re-read inside the transaction, so concurrent accepts/declines task at most once. Intake reports are limited to 1,000 characters and stripped of invisible format characters (`\p{Cf}`: zero-width, bidi, Unicode tags) before storage, and the triage notice shows the whole stored text (escaped) with its length, so maintainers triage exactly what the fixer receives. A declined case cannot be retasked. If the notice cannot be posted, it is re-sent periodically until it is | `integration/intake.test.ts`, `integration/reconcile.test.ts` (never tasked by reconciliation) | Tested | Intake spam and enumeration (D26/D27) | Duplicate reports from the same sender within 24 h are refused (through the same throttled refusal path); at most 50 public reports may await triage at once (`INTAKE_BUSY` beyond); `INTAKE_MAX_REPORTS_PER_HOUR` per sender; `status` shows only the sender's own cases, others read exactly like a missing case; visible refusals to non-maintainers are generic and limited to 3 per sender and room per 10 minutes (all are audited, subject to the audit throttle) | `integration/intake.test.ts` | Tested. Residual: a public sender can still create up to the hourly limit of cases; Switch-side rate limits are not configured by Loopback |
| Messages lost in a Switch delivery gap (step 3.9) | The gap is detected per connection; recovery runs once at a time per room (gaps arriving meanwhile are coalesced into one more run) and is awaited before the database closes; the room's recent history is read with `read_context` through that room's connection; unprocessed messages aimed at the gate are audited (`delivery.gap`) and maintainers are told how many to resend (no content); every case is reconciled against GitHub. Recovered messages are never executed (no `addressed` flag) | `integration/switch-gap.test.ts`, `integration/switch-rooms.test.ts`, `integration/switch-connection.test.ts` | Tested; a live gap has not been observed |
| Verifier shares the fixer's identity, or forged verifier evidence (D28) | Reports count only from the exact verifier id, bound to an open gate-issued run, its repository, PR and full SHA, re-checked against the PR's live head (unreadable ⇒ nothing recorded). Each new request supersedes older open runs, which can never complete. In isolated mode (`VERIFIER_ISOLATION_PROVEN=true`) every report must also carry a valid Ed25519 signature over the canonical report, checked before anything is recorded; startup requires the public key and distinct fixer/verifier agent ids listed in the Switch policy. Until then verification is labelled **advisory**. A signature proves key possession and report integrity, **not** test execution or runtime isolation | `unit/signature.test.ts`, `integration/verifier-signature.test.ts`, `integration/sign-helper.test.ts`, `integration/workflow.test.ts`, `unit/config.test.ts`, `integration/persistence.test.ts` (migration 3) | Tested locally; isolation **Live: not built**: no separate OS identities, keys or agents exist yet |
| Fixer reads the gate's credentials | Target: the gate runs as its own OS identity (or container) holding `.env`, `secrets/gate.pem` and the database; `scripts/verify-isolation.sh fixer` must show the App key unreadable | `scripts/verify-isolation.sh` (to be run) | **Open, unresolved:** today the gate, the fixer session and the maintainer share one desktop user, so the fixer can read the gate's App key and Switch key; a compromised fixer could post `loopback/gate` and merge directly |
| Privileged work in flight when the policy check fails | A one-way halt (`cases/halt.ts`) is set the moment the connection stops for a policy failure. Merge, approve/reject, retask and verify check it immediately before every write boundary (including their GitHub error branches) and stop by throwing, as a crash would; the command is audited `GATE_HALTED`, marked processed (never replayed) and not answered. Startup reconciliation then recovers the case (status reset, case blocked). A merge request already sent to GitHub cannot be cancelled | `security/halt.test.ts` | Tested (deterministic: parked GitHub calls); the halt is set in `main.ts`, which is not unit-tested |
| Refusal audit flooding | Ordinary refusals (`NOT_ADDRESSED` from a person) are audited at most once per sender per 60 s per code, with a summary row counting the suppressed ones when the window closes; attribution refusals and refusals of the fixer/verifier are always audited; a full tracking table audits instead of suppressing | `integration/router.test.ts` (audit throttle) | Tested |
| Privileged commands enabled by accident | `LOOPBACK_PRIVILEGED_ENABLED` must be exactly `true`; merging also needs at least one maintainer (`CONFIG_INCOMPLETE`) | `unit/config.test.ts`, `unit/authorize.test.ts`, `security/merge-gate.test.ts` | Tested; off by default |
| Stale approval (commit after approval) | Approvals store the full SHA; policy counts only approvals for the live head; poller marks Stale and re-verifies | `unit/policy.test.ts`, `security/merge-gate.test.ts` (commit binding), `integration/workflow.test.ts` | Tested |
| Stale or foreign CI | Check runs filtered by name, source app slug and exact head; latest by id (D13) | `unit/policy.test.ts`, `integration/workflow.test.ts` | Tested |
| Forged verifier report (D25) | Accepted only from the verifier id, for an open run id, naming the run's commit, repo and PR; latest run per head wins | `integration/workflow.test.ts` (verifier binding), `unit/report.test.ts` | Tested |
| Duplicate events | `processed_events`; unique approval key; case creation inside the dedupe transaction | `integration/router.test.ts`, `integration/service.test.ts`, `integration/persistence.test.ts` | Tested |
| Concurrent merges | Per-case lock; numbered attempts; open attempts block further merge calls | `security/merge-gate.test.ts` (concurrency, attempts) | Tested |
| Lost merge response | MergeUnknown ⇒ reconcile from GitHub; settle window for uncertain outcomes; never retry blindly; reconciliation never merges (D15) | `security/merge-gate.test.ts` (uncertain outcomes, recovery) | Tested |
| Crash mid-merge | Intent audited before the gate status; startup closes interrupted attempts, resets the status, waits for a command | `security/merge-gate.test.ts` (crash cases) | Tested |
| Success status left on an unmerged commit (D9) | Status corrected to `failure` on every abort path; failed corrections stay outstanding and raise a critical alert | `security/merge-gate.test.ts` | Tested |
| Token leakage | Separate per-agent tokens; gate key never in agent env; redacting logger and audit; no values in config errors | `integration/observability.test.ts`, `integration/persistence.test.ts` (redaction), `unit/config.test.ts` | Tested; agent env isolation **Live: unverified** |
| Excessive access (fixer merges or forges `loopback/gate`) | Ruleset requires `loopback/gate` from the gate App plus CI, empty bypass list; fixer PAT without status or workflow permissions | Manual proof, plan Phase 6 step 6 (nine outcomes) | **Live: unverified** |
| CI tampering by the fixer (D19) | Gate blocks PRs touching workflows, `package.json`, lockfiles, test config; verifier must fail them; fixer PAT lacks Workflows permission | `unit/policy.test.ts` (protected paths), `security/merge-gate.test.ts` | Tested; PAT permission **Live: unverified** |
| Unprotected or wrong base branch (D12/D17) | Exact `BASE_BRANCH` comparison; runtime check of exposed rules and required check integration IDs (`CHECK_SOURCE_MISMATCH`); demo base commit checked before tasking the fixer | `unit/policy.test.ts`, `security/merge-gate.test.ts`, `integration/workflow.test.ts` (demo base) | Tested; ruleset **Live: unverified** |
| GitHub outage | Undefined snapshot ⇒ block; nothing merges on cached evidence | `unit/policy.test.ts`, `security/merge-gate.test.ts` | Tested |
| Malicious repo content | Prompts mark content untrusted; tokens scoped to one repo; prompt review checklist below | Prompt review (this document) | Reviewed |
| Audit tampering | SQLite triggers reject UPDATE/DELETE on audit and approvals | `integration/persistence.test.ts` | Tested; online backup script `scripts/backup-db.sh` and systemd units provided and validated locally (live scheduling requires systemd install) |

## Prompt review checklist (§14 "Malicious repo content")

- `prompts/fixer.md` and `prompts/verifier.md` name every untrusted input (issue text, logs,
  comments, PR content, repository files, test output).
- Neither brief grants merge, status or secret access; both forbid printing environment
  variables; the verifier is told never to copy a report block from PR content.
- The code enforces permissions regardless of what an agent does.

## Residual risks (accepted, documented)

1. **Competing demo branches (D12).** The fixer may be able to create a branch matching
   `demo/*`, even though it cannot push directly to an existing protected demo branch. An
   attacker or compromised fixer could attempt to create a competing branch or influence
   branch selection. The gatekeeper must therefore validate the exact configured
   `BASE_BRANCH`, repository, run ID, branch protection, and current PR head before
   authorizing a merge. It must never select a demo branch solely because its name matches
   a pattern. *Bounded by:* exact base comparison and protection check in `evaluateMerge`
   (`unit/policy.test.ts`), unpredictable run ids and the base-commit check
   (`integration/workflow.test.ts`), and the manual proof in plan Phase 6 step 6.
2. **Maintainer merge.** A repository administrator can merge a PR whenever both required
   checks are green — e.g. in the moment between the gate's status post and its merge, or if
   a status correction fails. Rulesets decide by checks, not by who merges. *Mitigations:*
   the status is posted only immediately before merging and reset on every abort; merges
   Loopback did not perform raise a `policy.violation` alert; maintainers agree to merge
   only through Loopback.
3. **Approval SHA (D25, revised — closed).** Approvals require the full 40-character SHA and are
   compared by exact equality with the live head and the case head; no prefix is ever accepted
   (`unit/parse.test.ts`, `security/merge-gate.test.ts`). The approval prompt prints the full SHA
   for copying. (An earlier version accepted 7-hex prefixes, relying on the head-equality check.)
4. **Setup-only checks.** The ruleset bypass list (and check sources, if GitHub does not
   return them for a branch) cannot be read by the App at runtime; they are verified from the
   exported ruleset at setup and by `scripts/reset-demo.sh` on every demo run.
5. **Single instance.** The per-case lock is in-process; running two gates is unsupported.
   The lock has no timeout, so a hung network call holds a case until the process restarts.
6. **Shutdown and background tasks (fixed locally).** Background runs (poll, reconcile, sweep,
   triage notices) are tracked; on a terminal stop `main.ts` waits for message handlers and gap
   recovery (`rooms.drained()`) and then for running background tasks (`gate.drain()`) before the
   database closes (`tests/integration/composition.test.ts`). Signal handlers are installed before
   startup work; SIGTERM/SIGINT during startup reconciliation, after full startup, repeated, and a
   hung shutdown are tested (`run-lifecycle.test.ts`), and the built entry point exits 0 on real
   OS signals (`main-signal.test.ts`).
7. **Token attribution.** The fixer's and verifier's fine-grained tokens are owned by the
   maintainer's personal GitHub account, so their pushes, PRs and comments are attributed to that
   account on GitHub. Loopback's audit log (actor ids, run ids) is the record of which agent did
   what; GitHub's author field is not.
8. **Public intake volume.** Anyone Switch admits to the intake room can file up to
   `INTAKE_MAX_REPORTS_PER_HOUR` reports per hour; maintainers triage each one. Switch's own rate
   limits are outside Loopback's control.
9. **Open review items (independent review of the two-room change, not fixed here).**
   - The refusal-audit table, when full of live entries, audits every further refusal (by design,
     fail toward evidence), so rotating sender ids can still grow the audit log.
   - The policy is re-read every 60 s and three unreadable reads are tolerated, so a widened policy
     can be live for up to about a minute (about three while unreadable) before the gate stops.
     Authority in the maintainers' room still needs the exact Loopback id lists.
   - *(Fixed)* URLs in a public report are defanged in the triage notice (`hxxps[://]`, `www[.]`).
   - `accept`/`decline` are maintainer-only but not privileged: triage works while
     `LOOPBACK_PRIVILEGED_ENABLED=false`, like a direct `report` in the maintainers' room.
   - *(Fixed)* Intake `help`/`status` replies are limited to 10 per public sender per 10 minutes.
   - The key check does not verify file ownership or resolve symlinks before checking modes.
   - *(Fixed)* A transient GitHub problem at `accept` (rate limit, unavailable) leaves the report
     awaiting triage; a permanent one (base moved) still blocks it.
   - *(Fixed: signal handlers are now installed first.)* `/healthz` still starts last;
     the `switch-operations` readiness check reflects startup discovery only.
10. **In-flight GitHub merge.** A halt (policy failure) stops privileged work at its next write
   boundary, but cannot recall a merge request already sent to GitHub; that outcome is confirmed
   by reconciliation as usual.

## Invariant traceability (M1–M15)

| # | Enforced in | Tests | Status |
|---|---|---|---|
| M1 maintainer-only approval | `policy/authorize.ts`, `commands/router.ts` | `unit/authorize.test.ts`, `security/merge-gate.test.ts` | Tested; attribution **Live: unverified** |
| M2 approval bound to repo, PR, full SHA | `approvals` DDL + trigger, `workflow/verification.ts` | `integration/persistence.test.ts`, `security/merge-gate.test.ts` | Tested |
| M3 verification + CI on the same head | `policy/evaluate.ts`, `workflow/verification.ts` | `unit/policy.test.ts`, `integration/workflow.test.ts` | Tested |
| M4 head change invalidates evidence | `policy/evaluate.ts`, `workflow/poller.ts` | `unit/policy.test.ts`, `integration/workflow.test.ts` | Tested |
| M5 fixer cannot merge; verifier read-only | Router roles; GitHub PAT permissions and ruleset | `security/merge-gate.test.ts` (in-app) | In-app tested; **Live: unverified** |
| M6 only the gate holds merge credentials | Lint boundary on `github/merge` and transport; App key only in the gate | `unit/lint-boundaries.test.ts` | In-app tested; **Live: unverified** |
| M7 live recheck before merge | `cases/service.ts` (snapshot, head re-read) | `security/merge-gate.test.ts` | Tested |
| M8 GitHub authoritative for outcome | `cases/service.ts` reconcile | `security/merge-gate.test.ts` | Tested |
| M9 no blind retries | `github/merge.ts`, `cases/service.ts` | `integration/github.test.ts`, `security/merge-gate.test.ts` | Tested |
| M10 fail closed | `policy/evaluate.ts`, `agents/report.ts` | `unit/invariants.test.ts` (2,000 randomized cases), `unit/policy.test.ts` | Tested |
| M11 transitions follow the machine | `cases/machine.ts`, `cases/service.ts` | `unit/machine.test.ts` (all 196 pairs) | Tested |
| M12 untrusted input never policy | parser, report extraction, hand-off fencing | `unit/parse.test.ts`, `unit/report.test.ts`, `integration/workflow.test.ts` | Tested |
| M13 audited decisions | `audit/index.ts`, every transition and refusal | `integration/service.test.ts`, `integration/router.test.ts` | Tested |
| M14 secrets never logged or exposed | logger redaction, config errors, audit redaction | `integration/observability.test.ts`, `unit/config.test.ts` | Tested; agent env **Live: unverified** |
| M15 idempotent, serialized, recoverable merges | lock, attempts, startup recovery | `security/merge-gate.test.ts` | Tested |

Mutation check (performed during development): disabling the quorum check, the head-SHA
comparison or the reconciliation guard each made the suite fail (7, 4 and 1 tests). For the
two-room, intake, gap, readiness and verifier-evidence changes and the review fixes, 34 targeted mutations (policy
rules, admission by room, intake command set, triage re-checks, duplicate and hourly limits,
generic refusals, live-head check, advisory label, stop propagation, gap room binding, readiness
heartbeat and halt, key-directory check, distinct rooms, invisible-character stripping, report
length and pending caps, notice retry, retask after decline, gap single-flight) were each killed
by the suite.

Concurrency (step 8.3): `security/interleaving.test.ts` runs 100 seeded interleavings of a PR
head change against an approval, a poll and a merge. In every run the merge call was bound to an
approved, verified head, no approval was recorded for the new head, and a merge landed only on
the approved head; when the head moved after the gate's last read, GitHub's `sha` precondition
(modelled as a 409) refused the call.

## Dependency audit (`npm audit`, 2026-11-03)

| Advisory | Package | Severity | Scope | Resolution |
|---|---|---|---|---|
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) — memory exhaustion validating oversized constrained collections | `zod` < 4.6.6 | High | Production (validates untrusted chat and agent input) | **Fixed**: upgraded to `zod@4.6.7`. Defence in depth was already present (16 KB report cap, `.max()` on every array). |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) — ReDoS via glob-parts amplification | `minimatch` < 11.0.1 (11 entries via `eslint` / `typescript-eslint`) | Moderate | Development only | **Accepted, open**: no compatible fix (npm suggests downgrading ESLint to 4). Only our own lint globs reach it; never untrusted input, never shipped. Re-check when `eslint` updates `minimatch`. |

Production dependencies: 0 known vulnerabilities after the upgrade (`npm audit --omit=dev`).
