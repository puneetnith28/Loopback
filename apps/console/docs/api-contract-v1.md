# Read API v1 — contract proposal from the console

Status: **proposal, not implemented.** The gate exposes only `/healthz` and `/readyz`; no read API exists yet.
This extends `backend-api-requirements.md` (R2/R3) with exact field mappings. The console validates every response
against `src/api/schemas.ts` (zod). The schemas belong in `packages/contracts` once the backend team adopts them;
moving them there needs the owner's approval.

Every field below maps to data the gate already stores (`apps/switch-gate/src/persistence/migrations.ts`) or
records in audit payloads (`apps/switch-gate/src/workflow/verification.ts`). Fields marked **R3** are not stored
today; the console accepts `null` and says "not available from the read API" instead of guessing.

## Envelope

```jsonc
{ "success": true, "data": <payload>, "meta": { "generatedAt": "<ISO>", "nextCursor": "<opaque>|null", "unavailable": ["<source>"] } }
{ "success": false, "error": { "code": "UPPER_SNAKE", "message": "<never shown to users>" } }
```

- `unavailable` lists sources that failed while assembling a response (`github-snapshot`, `verification-runs`,
  `audit`, `config`, `status`, `github`); the console renders the data it got plus a "partial data" notice.
- HTTP 401/403 → permission state; 404 → not found; 5xx → retried twice, then an error state. Error messages are
  never displayed; only the code is kept.
- Unknown keys are stripped by the console; nothing outside the schema can reach the screen.

## Provenance (required on every fact)

`github` (observed by the gate on GitHub) · `gate` (decided/recorded by the gate) · `signed-verifier` (verifier
report with signature `valid`) · `agent-claim` (an agent's own statement). `demo` is rejected. A run marked
`signed-verifier` without `signature: "valid"` is rejected as a contract violation.

## Endpoints (GET only)

| Endpoint | Payload | Source tables |
|---|---|---|
| `/api/v1/overview` | `Overview` | `cases` (counts over all 14 states), attention selection (server-side), `verification_runs` window counts, latest `audit_events` |
| `/api/v1/cases?state=&cursor=&limit=` | `CaseSummary[]` | `cases` |
| `/api/v1/cases/:id` | `CaseDetail` | `cases`, `case_commits`, `ci_evidence`, `verification_runs` (+ `report_json`), `approvals`, `merge_operations`, last merge evaluation from `audit_events` |
| `/api/v1/cases/:id/audit?cursor=&limit=` | `AuditEvent[]` | `audit_events` where `case_id = :id` |
| `/api/v1/audit?case=&types=&cursor=&limit=` | `AuditEvent[]` | `audit_events` (`types` is a comma-separated allowlist) |
| `/api/v1/verification-runs?cursor=&limit=` | `VerificationRunListItem[]` | `verification_runs` joined to `cases` (`caseState`, `caseHeadSha`) |
| `/api/v1/config/summary` | `ConfigSummary` | allowlisted runtime configuration (below) |
| `/api/v1/status` | `SystemStatus` | proxy of the gate's `/readyz` (`failing` names only) |

## Field mapping

| Model.field | Source |
|---|---|
| `CaseSummary.id/state/repo/prNumber/headSha/blockedReason` | `cases.id/state/repo/pr_number/head_sha/blocked_reason` |
| `CaseSummary.reportExcerpt` | first ≤500 chars of `cases.report_text` (untrusted) |
| `CaseSummary.stateEnteredAt/createdAt/updatedAt` | `cases.state_entered_at/created_at/updated_at` |
| `CaseDetail.branch/reportText` | `cases.branch/report_text` (≤4000 chars, untrusted) |
| `Commit.*` | `case_commits.head_sha/base_sha/observed_at`, provenance `github` |
| `CiCheck.*` | `ci_evidence.id/head_sha/check_name/app_slug/status/conclusion/html_url/observed_at`, provenance `github` |
| `VerificationRun.id/headSha/status/requestedAt/completedAt` | `verification_runs.*` |
| `VerificationRun.mode/signature` | audit payload `verification` ("advisory"/"isolated") and `signature` recorded with the run's verification event |
| `VerificationRun.summary/findings/regressionTestFailsBeforeFix` | `verification_runs.report_json` (validated `VerifierReport`) |
| `Approval.*` | `approvals.id/approver_id/head_sha/decision/reason/created_at`, provenance `gate` |
| `MergeOperation.*` | `merge_operations.*`; `error` mapped to a reason code (raw GitHub text never sent) |
| `CaseDetail.evidence` | **R3** — the gate's own selection of the latest passing run for the case (the rule the policy uses); `null` when none. Never selected in the browser. |
| `CaseDetail.lastGateDecision` | latest merge evaluation recorded in `audit_events` (`merge.blocked` reason codes, or allowed) |
| `CaseDetail.fixerClaim` | **R3** — `fixer.reported` payload (outcome, tests, regression test, limitations, summary) |
| `CaseDetail.prSnapshot` | **R3** — not stored; the read API holds no GitHub token |
| `AuditEvent.*` | `audit_events.id/case_id/actor_id/event_type/target_sha/reason_code/payload_json/created_at`; payload already redacted |
| `ConfigSummary` | `GH_REPO`, `GH_BASE_BRANCH`, required checks, verification mode (from `VERIFIER_ISOLATION_PROVEN`), `MERGE_ENABLED`, `LOOPBACK_PRIVILEGED_ENABLED`, `VERIFIER_ISOLATION_PROVEN`, quorum, gate mention, schema version, poll/verify/fix timeouts. **Never**: keys, tokens, key paths, participant ids, room ids, internal URLs. |

## Not requested

No write endpoints of any kind (approve, reject, merge, retry, retask). Approval stays in Switch.
