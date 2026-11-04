# Loopback

Loopback turns a bug report in a team chat room into a verified GitHub pull
request, and merges it only when a maintainer's approval, independent
verification and CI are all bound to the exact same commit SHA.

> **Status: under active development.** Sections below are filled in as the
> corresponding parts are built and verified. Nothing here should be read as a
> claim that an integration works until its section says it was verified.

## 1. What it does

_To be completed with a short walkthrough once the end-to-end flow is verified._

## 2. How Switch is used

_To be completed after the Switch transport is verified against the installed
Switch version._

## 3. Architecture and trust boundaries

_To be completed._ Summary: the gatekeeper is the only component with merge
credentials; the fixer and verifier agents cannot merge; GitHub is the source of
truth for PR, commit, CI and merge state.

## 4. Quickstart

_To be completed and tested from a fresh clone._

## 5. Demo walkthrough

_To be completed._

## 6. Security model and known limits

See [SECURITY.md](SECURITY.md). The full threat model will live in
`docs/threat-model.md`.

## 7. Tests

```bash
npm ci
npm run typecheck
npm test
```

## 8. Honesty notes

_To be completed: which bug is used in the demo, which agents were used, and
what was built during the event._

## 9. Licence

Apache License 2.0 — see [LICENSE](LICENSE).
