# Backend requirements discovered by the console (for the backend team)

The console implements no backend. Everything below is a request, not an implementation. Today the gate exposes
only `/healthz` and `/readyz` on 127.0.0.1, so the production console shows "No data source connected".

## R1. A separate, read-only API process
- Not inside the gate process (which holds the GitHub App key and the merge capability). Opens SQLite read-only
  (`PRAGMA query_only`), holds no GitHub, Switch or signer credentials, serves the built console same-origin.
- GET only; Host-header allowlist (DNS rebinding); no CORS; strict CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` — no inline
  script: the theme script is an external file; React `style` attributes need `'unsafe-inline'` for styles only); `Cache-Control: no-store`; rate limit;
  auth token or `HttpOnly; SameSite=Strict` session; published on 127.0.0.1 only.
- Versioned zod response schemas in `packages/contracts` (`api/v1`), envelope `{ success, data, error, meta }`.

## R2. Endpoints the screens need

The console now calls these (Phase 2). Exact payloads and the field-to-table mapping: `api-contract-v1.md`.
| Endpoint | Data | Notes |
|---|---|---|
| `GET /api/v1/overview` | counts by state, open cases, verification pass/fail/timeout, recent activity | numbers derived server-side only |
| `GET /api/v1/cases?state=&cursor=` | case list | cursor pagination |
| `GET /api/v1/cases/:id` | case, commits, CI evidence, verification runs (with **signature status** and **advisory/isolated mode**), approvals, merge operations (errors mapped to reason codes), last gate decision with `observedAt` | the console never computes merge readiness |
| `GET /api/v1/cases/:id/audit`, `GET /api/v1/audit?case=&types=&cursor=` | audit events | redacted payload; `types` comma-separated allowlist; polling is enough |
| `GET /api/v1/verification-runs?cursor=` | verification runs across cases, with the case's current head | signature status and mode per run |
| `GET /api/v1/config/summary` | allowlisted non-secret config: safety flags, verification mode, required checks, schema version | no ids, paths or keys |
| `GET /api/v1/status` | proxy of the gate's `/readyz` | failing check names only |

## R3. Fields the UI needs that are not stored today
- `evidenceSha` per case (the full SHA the latest passing verification is bound to) and `headSha` — drives the
  StateTrack seal and `ApprovalCommand`, which shows a command only when `verifiedSha === headSha` (compared in
  the component, not trusted as a boolean) and the case id and SHA validate against the contracts schemas.
- PR title, author, changed files, check list (a gate-side snapshot; the read API has no GitHub token).
- Fixer `limitations` / `not_reproduced.summary` (not persisted today).
- Provenance per fact: the API must say whether a fact was observed on GitHub, decided by the gate, signed by the
  verifier or claimed by an agent — the UI must not infer it.

## R4. Not requested (by design)
No approve, reject, merge or other write endpoint. Approval stays in Switch (decision recorded in the architecture
assessment); a web approval path would need its own identity-binding security design first.
