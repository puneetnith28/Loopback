# Loopback

Loopback turns a bug report in a team chat room into a verified GitHub pull
request, and merges it only when a maintainer's approval, independent
verification and CI are all bound to the exact same commit SHA.

> **Status: one real bug has gone through the whole flow live.** Case `LB-001` went from a chat
> report to a fixer PR, a signed verifier report, a maintainer approval of the exact commit and a
> merge performed by the gate, with real refusals on the way:
> [evidence and its limits](docs/evidence/phase-08-day2.md). Verification is still advisory, and the
> verifier needed step-by-step human guidance on that run. Section 6 lists what is not yet proven.

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
`addressed` under the restrictive policy, inbound thread ids, the gate's own posts and threaded
replies, both rooms of the two-room design (D26) and real fixer and verifier reports were verified
live ([Day 1](docs/evidence/phase-05.md), [Day 2](docs/evidence/phase-08-day2.md)). Still unexplained:
one `verify` command posted in the maintainers' room never reached the gate's records. Every message passes one admission step (addressed by Switch, not delegated or
platform-generated, exact sender ids) before any handler; privileged commands stay off unless
`LOOPBACK_PRIVILEGED_ENABLED=true`, and the gate refuses to start unless its Switch addressing
policy is the expected restrictive one.

## 3. Architecture and trust boundaries

See [docs/architecture.md](docs/architecture.md). In short: the gatekeeper is the only component
with merge credentials; the fixer and verifier cannot merge; GitHub is the source of truth for
PR, commit, CI and merge state.

## 4. Quickstart

The steps below build and test the code. Running the flow end to end also needs the live GitHub and
Switch setup in [docs/setup.md](docs/setup.md) (on Windows, [docs/windows.md](docs/windows.md)); it has
been done on one machine, and a fresh-clone reproduction has not been attempted.

```bash
npm ci
npm run build
npm run migrate        # reads .env; creates the SQLite schema at DB_PATH
npm test               # unit, integration and security suites
```

Configuration is described in [.env.example](.env.example) and
[docs/operations.md](docs/operations.md).

## 5. Demo walkthrough

The first live run is recorded in [docs/evidence/phase-08-day2.md](docs/evidence/phase-08-day2.md): PR #3
of the demo target, merged by the gate at `02445c3`, with a wrong-commit approval and a merge attempt
refused on the same case. The planned repeatable demo prepares a fresh protected `demo/<run-id>` branch
with [scripts/reset-demo.sh](scripts/reset-demo.sh); its scene-by-scene script and recovery guide are in
[docs/demo-runbook.md](docs/demo-runbook.md), and that form of the demo has not been run live yet.

## 6. Security model and known limits

See [SECURITY.md](SECURITY.md) and the full [threat model](docs/threat-model.md), which maps
each threat to its defence and tests and lists the accepted residual risks. Known limits: single
instance, local only. Verification is advisory until the verifier's isolation is proven in its own
container (`deploy/isolation/`): on the live Windows install the agents run on the host as the desktop
user, and in advisory mode the gate accepts an unsigned report, so a human must review before approving.
Not yet met: the ruleset proof that only the gatekeeper can merge, a merge on a per-run branch, an extra
push turning a live case Stale, two clean end-to-end runs, a fresh-clone test and a verifier that
completes its brief without human guidance. [docs/release-readiness.md](docs/release-readiness.md) has
the item-by-item audit, written before the live run, so this section and the evidence file are newer.

## 7. Tests

Development is described in [CONTRIBUTING.md](CONTRIBUTING.md). Linux and native Windows are both
supported, for the tests and for running the gate; [docs/windows.md](docs/windows.md) covers
Windows, including what is weaker there.

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
- Demo merges are designed to land on disposable per-run `demo/<run-id>` branches. The one live merge so
  far (`LB-001`) landed on the demo target's `main` instead, to meet the submission time. The seeded bug
  remains available from the `demo-reset` tag.
- The fixer's and verifier's GitHub tokens are fine-grained tokens owned by the maintainer's
  personal account, so their pushes and PRs appear on GitHub under that account; the Loopback
  audit log records which agent acted.

## 9. Licence

Apache License 2.0 — see [LICENSE](LICENSE).
