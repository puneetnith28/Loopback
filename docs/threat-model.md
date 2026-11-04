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
| Switch addressing policy widened or removed | Startup self-check reads the gate's own policy and refuses to start (exit 4) unless it is exactly one rule: this room, the configured ExternalUser and agent ids, owner/owner_agents/platform false | `integration/switch-policy-check.test.ts`, `integration/startup.test.ts` | Tested; checked at startup and every 60 s while running (a policy found wrong stops the gate at once; 3 consecutive unreadable checks stop it) |
| Privileged work in flight when the policy check fails | A one-way halt (`cases/halt.ts`) is set the moment the connection stops for a policy failure. Merge, approve/reject, retask and verify check it immediately before every write boundary (including their GitHub error branches) and stop by throwing, as a crash would; the command is audited `GATE_HALTED`, marked processed (never replayed) and not answered. Startup reconciliation then recovers the case (status reset, case blocked). A merge request already sent to GitHub cannot be cancelled | `security/halt.test.ts` | Tested (deterministic: parked GitHub calls); the halt is set in `main.ts`, which is not unit-tested |
| Refusal audit flooding | Ordinary admission refusals (`NOT_ADDRESSED` from a person) are audited at most once per sender per 60 s per code, with a summary row counting the suppressed ones when the window closes; attribution refusals and refusals of the fixer/verifier are always audited; a full tracking table audits instead of suppressing | `integration/router.test.ts` (audit throttle) | Tested |
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
| Unprotected or wrong base branch (D12/D17) | Exact `BASE_BRANCH` comparison; runtime check of exposed rules; demo base commit checked before tasking the fixer | `unit/policy.test.ts`, `security/merge-gate.test.ts`, `integration/workflow.test.ts` (demo base) | Tested; ruleset **Live: unverified** |
| GitHub outage | Undefined snapshot ⇒ block; nothing merges on cached evidence | `unit/policy.test.ts`, `security/merge-gate.test.ts` | Tested |
| Malicious repo content | Prompts mark content untrusted; tokens scoped to one repo; prompt review checklist below | Prompt review (this document) | Reviewed |
| Audit tampering | SQLite triggers reject UPDATE/DELETE on audit and approvals | `integration/persistence.test.ts` | Tested; daily backup **not yet scheduled** |

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
6. **Shutdown and background tasks (follow-up, not fixed).** On a terminal stop, `gate.stop()`
   clears the poll, reconcile and sweep timers and closes the database, but does not wait for a
   background run that is already in progress; such a run can fail against the closed database
   (caught and logged) and could post a gate status during shutdown. These background paths never
   merge. Fix separately: track in-flight background tasks and await them before closing.
7. **In-flight GitHub merge.** A halt (policy failure) stops privileged work at its next write
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
comparison or the reconciliation guard each made the suite fail (7, 4 and 1 tests).

## Dependency audit (`npm audit`, 2026-11-03)

| Advisory | Package | Severity | Scope | Resolution |
|---|---|---|---|---|
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) — memory exhaustion validating oversized constrained collections | `zod` < 4.6.6 | High | Production (validates untrusted chat and agent input) | **Fixed**: upgraded to `zod@4.6.7`. Defence in depth was already present (16 KB report cap, `.max()` on every array). |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) — ReDoS via glob-parts amplification | `minimatch` < 11.0.1 (11 entries via `eslint` / `typescript-eslint`) | Moderate | Development only | **Accepted, open**: no compatible fix (npm suggests downgrading ESLint to 4). Only our own lint globs reach it; never untrusted input, never shipped. Re-check when `eslint` updates `minimatch`. |

Production dependencies: 0 known vulnerabilities after the upgrade (`npm audit --omit=dev`).
