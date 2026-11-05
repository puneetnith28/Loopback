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

There are two ways to use Loopback. Both need Node 22 and a clone of this repository.

### Try it in a few minutes, with no accounts

This builds the code, runs the tests and shows the console on sample data. Nothing touches GitHub
or a chat room.

```bash
npm ci
npm run build
npm test
npm run console-api:mock                # terminal 1: a read-only API serving sample data
npm run dev --workspace apps/console    # terminal 2: the console, on http://localhost:5173
```

[docs/console-api.md](docs/console-api.md) has the mock's token and address.

### Run the real flow on your own repository

This lets your team report a bug in chat and merge its fix only through the gate. It takes several
hours the first time, because each role gets its own credentials. It has been done on one Windows
machine so far; **a setup from a fresh clone by someone else has not been tried yet**, so expect rough edges.

You need:

- **A GitHub repository you own**, with CI, and permission to add rulesets to it.
- **A GitHub App** for the gate (the only identity that can merge) and **two fine-grained tokens**, one
  each for the fixer and the verifier.
- **Switch Console** with Mattermost, for the two chat rooms and the agents (tested with Console 0.40.1,
  switch-core 0.31.0 and Mattermost 11.9.0).
- **Docker** for the agent containers, and an AI model for the agents. Free models work but hit usage
  limits and need close supervision.

Then:

1. Follow [docs/setup.md](docs/setup.md) for GitHub and Switch (on Windows, also
   [docs/windows.md](docs/windows.md)). Give the agents `prompts/` as their room documents.
2. Copy [.env.example](.env.example) to `.env` and fill it in. Keep keys outside any synced folder, and
   never commit them. [docs/operations.md](docs/operations.md) explains the settings.
3. Prepare and check:
   ```bash
   npm ci
   npm run build
   npm run migrate
   npm run readiness    # lists anything still missing
   npm run gate
   ```
4. In the public room: `@loopback-gate report <the bug>`. In the maintainers' room:
   `@loopback-gate accept LB-001`, then `approve LB-001 <full commit sha>` and `merge LB-001`.

Merging stays off until you set `LOOPBACK_PRIVILEGED_ENABLED=true` and `MERGE_ENABLED=true`. Review each
change yourself before approving, because verification is advisory unless the verifier's isolation is proven.

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
user, so they can reach that user's files. A signature proves a report wasn't altered, not that its tests
ran, so a human must review before approving.
[Proved live](docs/evidence/phase-06-ruleset-proof.md): GitHub's rules refuse a merge without the gate's own
status, even from the maintainer's account with green CI. Not yet met: a merge on a per-run branch, an extra
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
