# Loopback Console (frontend)

Read-only evidence UI for Loopback. It shows what the gate recorded and never approves, rejects or merges:
approval stays a human action in Switch. Design contract: `DESIGN.md`. API contract proposal:
`docs/api-contract-v1.md`; backend requirements: `docs/backend-api-requirements.md`.

```bash
npm run dev -w @loopback/console            # dev server (includes /design)
npm run build -w @loopback/console          # production build: /design, demo and test fixtures excluded
npm run build:design -w @loopback/console   # design-reference build (dist-design/)
npx vitest run --project console            # unit + RTL + axe tests (from the repo root)
npm run test:e2e -w @loopback/console       # Playwright against the production build (system Chrome)
```

## Screens

| Route | Screen |
|---|---|
| `/` | Overview: cases waiting on a maintainer, verification counts, cases by state, recent activity |
| `/cases?state=` | Case management: filter by state, cursor pagination |
| `/cases/:id` | Case evidence: lifecycle + commit seal, head-moved alert, gate decision, approval command (only in “Awaiting approval” with evidence for the current head), CI, verification, commits, agent claims, approvals, merges, activity |
| `/agents` | Agent activity (fixer, verifier, rejected output) |
| `/gate` | Verification mode, every verification run (signature, mode, applies to current head?), gate decisions |
| `/audit?case=&type=` | Audit history with filters |
| `/system` | Gate readiness, safety flags (read-only), allowlisted non-secret configuration |

## Structure

- `src/api/` — typed read-API client: `schemas.ts` (zod, runtime validation), `client.ts` (same-origin GET only,
  error kinds, cancellation), `queries.ts` (TanStack Query: polling, pagination, retry policy), `loadable.ts`
  (query → six content states, stale/partial handling).
- `src/app/` — shell, theme, typed router, error boundary. `src/features/<screen>/` — screens.
- `src/design-system/` — tokens and primitives (Phase 1). `src/lib/` — provenance, lifecycle, labels, untrusted text.
- `src/demo/` — DEMO fixtures for `/design` only. `test-fixtures/` — API response builders for tests only.
  Neither can reach a production build (ESLint boundaries + `tests/demo-isolation.test.ts`).
- No read API exists yet: without one, every screen shows “Cannot reach the read API”. Nothing is simulated.
- Rendered evidence (screenshots + checked record): `evidence/`.

## Deployment notes
- Serve only `dist/`, same-origin with the read API under `/api/v1`. `dist-design/` contains the DEMO design
  reference and must never be deployed.
- CSP is set by whatever serves the console (see `docs/backend-api-requirements.md` R1); it is not delivered here.
- Clipboard copy needs a secure context (HTTPS or localhost); without it the copy buttons report “Copy failed”.
