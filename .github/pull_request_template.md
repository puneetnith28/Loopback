## Description

Please include a summary of the change, motivation, and relevant context.

Fixes #(issue)

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Refactoring / performance improvement
- [ ] Documentation update
- [ ] CI / repository engineering

## Invariant and Security Checklist

- [ ] I have not weakened or altered Loopback safety flags (`MERGE_ENABLED`, `LOOPBACK_PRIVILEGED_ENABLED`, `VERIFIER_ISOLATION_PROVEN`).
- [ ] Human maintainer approval of the exact 40-character commit SHA remains mandatory.
- [ ] The console remains strictly read-only; no mutation endpoints or write paths added.
- [ ] No secrets, credentials, tokens, private keys (`*.pem`), or database files are committed.
- [ ] Untrusted inputs (Switch message text, PR bodies, agent outputs) are sanitized and validated with Zod schemas.

## Verification Checklist

- [ ] `npm run typecheck` passes with 0 errors.
- [ ] `npm run lint` passes with 0 warnings/errors.
- [ ] `npm test` passes (all unit, integration, and security tests).
- [ ] `npm run release:check` confirms version consistency.
- [ ] Production build succeeds (`npm run build` and `npm --prefix apps/console run build`).
- [ ] Line endings remain LF across all files (`tests/unit/line-endings.test.ts`).
