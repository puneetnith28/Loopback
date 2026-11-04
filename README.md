# Loopback

Loopback turns a bug report in a team chat room into a verified GitHub pull
request, and merges it only when a maintainer's approval, independent
verification and CI are all bound to the exact same commit SHA.

> **Status: under active development.** Sections below are filled in as the
> corresponding parts are built and verified. Nothing here should be read as a
> claim that an integration works until its section says it was verified.

## 1. What it does

1. Anyone writes `@loopback-gate report <bug>` in the public intake room; the gate opens case
   `LB-001` and asks the maintainers to triage it. A maintainer's `@loopback-gate accept LB-001`
   in the private maintainers' room tasks the fixer agent (the report is passed as fenced,
   untrusted data); `decline` closes it. Maintainers and listed reporters can also report directly
   in the maintainers' room, which tasks the fixer at once.
2. The fixer reproduces the bug with a failing test, fixes it and opens a PR.
3. The gate reads GitHub itself: it finds the PR, records the full head SHA and collects CI.
4. A verifier reviews exactly that SHA and answers with a structured report bound to the
   verification run and to the PR's live head. Until the verifier runs under its own OS user and
   credentials, its result is labelled **advisory** (decision D28).
5. A maintainer approves that exact commit by its full SHA: `@loopback-gate approve LB-001 <40-character sha>`.
6. On `@loopback-gate merge LB-001` the gate re-reads live GitHub state, re-evaluates every piece
   of evidence against the current head, posts its `loopback/gate` status and merges with GitHub's
   `sha` precondition, then confirms the result from GitHub.
7. Any change in between — a new commit, a failed check, a missing approval — is refused visibly
   with a reason code and recorded in the append-only audit log.

## 2. How Switch is used

Switch hosts two rooms: a public intake room, where anyone can report a bug to the gate, and a
private maintainers' room, where maintainers and the three agents meet: the gate (a custom
agent), the fixer and the verifier (provider agents), with mention-based commands and room
documents as the agents' briefs (`prompts/`, `templates/loopback-room.yaml`). The gate holds one
Switch connection per room.

**Status:** the gate's Switch transport is implemented against the installed switch-core 0.31.0
WebSocket protocol (decision D23) and tested with a scripted socket; registration, authentication,
heartbeat, takeover fencing, reconnect, the room claim, delivery of real messages from people,
`addressed` under the restrictive policy and inbound thread ids were verified live. Still to verify
live: agent and platform message attribution, the gate's own posts and threaded replies, echo
behaviour, and a Switch restart. The two-room design (D26) is implemented and tested with fakes
only; the intake room and its addressing rule do not exist on the live install yet, and the gate
refuses to start (exit code 4) until they do. Every message passes one admission step (addressed by Switch, not delegated or
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
commit lands after approval. The complete scene-by-scene recording script, happy path, negative
refusal paths and recovery guide are documented in [docs/demo-runbook.md](docs/demo-runbook.md).

## 6. Security model and known limits

See [SECURITY.md](SECURITY.md) and the full [threat model](docs/threat-model.md), which maps
each threat to its defence and tests and lists the accepted residual risks. Known limits: single
instance, local only, live Switch messaging and live GitHub configuration not yet exercised.
Verification is advisory until the verifier's isolation is proven on separate OS identities.
Not yet met (they need the live setup): a real human-and-agent task through Switch, a genuine
fixer PR with its regression test, the ruleset proof that only the gatekeeper can merge, and a
recorded demo. The item-by-item status is in [docs/release-readiness.md](docs/release-readiness.md).

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
- The demo target repository is a dedicated, independent repository (`loopback-demo-target`)
  under the maintainer's account containing a small utility application with a deliberately seeded,
  reproducible bug (Issue #1).
- Demo merges land on disposable per-run `demo/<run-id>` branches of the demo target, not on `main`.
- The fixer's and verifier's GitHub tokens are fine-grained tokens owned by the maintainer's
  personal account, so their pushes and PRs appear on GitHub under that account; the Loopback
  audit log records which agent acted.

## 9. Licence

Apache License 2.0 — see [LICENSE](LICENSE).
