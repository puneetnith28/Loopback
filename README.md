# Loopback

Loopback turns a bug report in a team chat room into a verified GitHub pull
request, and merges it only when a maintainer's approval, independent
verification and CI are all bound to the exact same commit SHA.

> **Status: under active development.** Sections below are filled in as the
> corresponding parts are built and verified. Nothing here should be read as a
> claim that an integration works until its section says it was verified.

## 1. What it does

1. A reporter writes `@loopback-gate report <bug>` in the team room; the gate opens case `LB-001`
   and tasks the fixer agent (the report is passed as fenced, untrusted data).
2. The fixer reproduces the bug with a failing test, fixes it and opens a PR.
3. The gate reads GitHub itself: it finds the PR, records the full head SHA and collects CI.
4. An independent verifier reviews exactly that SHA and answers with a structured report bound
   to the verification run.
5. A maintainer approves that exact commit by its full SHA: `@loopback-gate approve LB-001 <40-character sha>`.
6. On `@loopback-gate merge LB-001` the gate re-reads live GitHub state, re-evaluates every piece
   of evidence against the current head, posts its `loopback/gate` status and merges with GitHub's
   `sha` precondition, then confirms the result from GitHub.
7. Any change in between — a new commit, a failed check, a missing approval — is refused visibly
   with a reason code and recorded in the append-only audit log.

## 2. How Switch is used

Switch hosts the room where people and the three agents meet: the gate (a custom agent), the
fixer and the verifier (provider agents), with mention-based commands and room documents as the
agents' briefs (`prompts/`, `templates/loopback-room.yaml`).

**Status:** the gate's Switch transport is implemented against the installed switch-core 0.31.0
WebSocket protocol (decision D23) and tested with a scripted socket; registration, authentication,
heartbeat, takeover fencing, reconnect, the room claim, delivery of real messages from people,
`addressed` under the restrictive policy and inbound thread ids were verified live. Still to verify
live: agent and platform message attribution, the gate's own posts and threaded replies, echo
behaviour, and a Switch restart. Every message passes one admission step (addressed by Switch, not delegated or
platform-generated, exact sender ids) before any handler; privileged commands stay off unless
`LOOPBACK_PRIVILEGED_ENABLED=true`, and the gate refuses to start unless its Switch addressing
policy is the expected restrictive one.

## 3. Architecture and trust boundaries

See [docs/architecture.md](docs/architecture.md). In short: the gatekeeper is the only component
with merge credentials; the fixer and verifier cannot merge; GitHub is the source of truth for
PR, commit, CI and merge state.

## 4. Quickstart

Not yet runnable end to end (see section 2). What works today:

```bash
npm ci
npm run build
npm run migrate        # creates the SQLite schema at DB_PATH
npm test               # unit, integration and security suites
```

Configuration is described in [.env.example](.env.example) and
[docs/operations.md](docs/operations.md). Live GitHub and Switch setup (not yet performed) is in
[docs/setup.md](docs/setup.md).

## 5. Demo walkthrough

Not recorded yet. The planned demo prepares a fresh protected `demo/<run-id>` branch with
[scripts/reset-demo.sh](scripts/reset-demo.sh), runs the flow above, then shows a refusal when a
commit lands after approval.

## 6. Security model and known limits

See [SECURITY.md](SECURITY.md) and the full [threat model](docs/threat-model.md), which maps
each threat to its defence and tests and lists the accepted residual risks. Known limits: single
instance, local only, live Switch messaging and live GitHub configuration not yet exercised.

## 7. Tests

```bash
npm ci
npm run typecheck
npm run lint      # type-aware ESLint over sources and tests, with module-boundary rules
npm test          # unit, integration and security suites
```

## 8. Honesty notes

- Code was written with Claude Code (with the Everything Claude Code plugin's review agents).
- Development started on 3 November 2026; the user reports the organiser confirmed in
  conversation that building before 4 November is allowed (no written confirmation). The
  repository was created on 3 November and is planned to move to a new repository with its
  history preserved; eligibility questions are tracked separately and are not resolved here.
- The intended demo bug is a real, unseeded bug in the MIT-licensed `simov/slugify`
  (issue #177: `extend()` with a `null` value throws). It has not been reproduced in a fork yet.
- Demo merges will land on per-run `demo/<run-id>` branches of the fork, not on `main`.

## 9. Licence

Apache License 2.0 — see [LICENSE](LICENSE).
