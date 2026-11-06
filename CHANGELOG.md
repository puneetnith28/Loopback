# Changelog

All notable changes to Loopback will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on stability**: Loopback is currently in active pre-1.0 development (`v0.1.0`).
> Safety invariants (`MERGE_ENABLED=false`, `LOOPBACK_PRIVILEGED_ENABLED=false`) remain default-off.

---

## [Unreleased]

### Added

- **`why <case>`**: every merge requirement, read live from GitHub, and what to do next. It can never report ready unless the merge policy agrees.
- **`board` and room documents**: the gate keeps a case board and a decision log in the maintainers' room. They hold only the gate's own values, never report text.
- **`team` and absence warnings**: shows each agent's status as Switch reports it, and warns when a task goes to an agent that isn't connected.
- **`npm run demo`**: a self-checking rehearsal of the whole flow with no accounts.
- **The gate's settings in the console**: the gate records its non-secret settings when it starts, and the console API serves them at `/api/v1/config/summary`. The console no longer fills in defaults, which had shown "Verification is isolated" and "Merging: Off" whatever the gate's real settings. If the gate hasn't recorded them, the console says the configuration is unavailable.
- **Documentation**: the README is rewritten around Switch, with what is verified and what is not; `TESTING.md` takes a reviewer from a web page with no install to a local run; `docs/README.md` indexes every page.
- **Node range**: `package.json` now requires Node `>=22.13.0 <23`, which the installed dependencies need, instead of 22.12.
- **Dependency audit**: an override moves the lint tools to `minimatch` 11.0.5, which clears the one advisory `npm audit` reported.
- **`npm run test:linux` without Docker**: says that Docker is not running, instead of crashing on a closed pipe.
- **`npm run demo:page`**: builds a single web page where someone can do the same run with no install. It uses the rehearsal's recorded messages, the real evidence console reading responses recorded from its real API, and a button that shows what happens with Switch off. The page puts Switch at the centre of an animated circuit, with a title page, a floating chapter bar and a guided 21-step run.
- **`templates/loopback.template.yaml`**: a Switch template, generated from `prompts/`, that creates both agents and both rooms. It replaces the earlier hand-written room file.

### Changed

- **README**: rewritten around how Switch is used. Corrected its commands, setting names and Switch link, which did not match the code.

## [0.1.0] - 2026-11-05

Initial pre-release of Loopback: commit-bound, auditable verification gate and human-controlled AI bug maintenance system for GitHub and Switch.

### Added

#### Core Verification & Gate Architecture
- **Commit-bound merge gate**: The gate re-reads live GitHub state, re-verifies CI checks, cryptographic signatures, and maintainer approvals against the exact 40-character commit SHA before every merge attempt.
- **Fail-closed merge operations**: Strict precondition check prevents orphan approvals, race conditions, or merging when the PR head has moved.
- **Cryptographic verification evidence**: Ed25519-signed verification reports proving report integrity and run identity.
- **Append-only SQLite audit log**: Tamper-evident, SQLite trigger-enforced audit event log recording every state transition, triage decision, check run, and merge attempt.
- **Switch room integration**: Two-room transport design separating public intake (`@loopback-gate report`) from maintainer commands (`accept`, `approve`, `merge`, `retask`).
- **Isolation tests and the Windows runtime**: a Linux container isolation test run under Docker, alongside native Windows NTFS ACL checks and console control signal handling.

#### Console & Operational Intelligence
- **Read-only evidence console**: React 19 + TypeScript + Vite frontend with IBM Plex typography, WCAG AAA contrast, and strict provenance badging.
- **Full verification & merge history**: Sub-resource integration concurrently displaying all historical verification runs, earlier head commits, and all merge attempts.
- **Agent claims tab**: Fixer self-reported tests, regression test locations, limitations, and summaries with explicit `agent-claim` provenance.
- **Actionable operator guidance**: In-console diagnostic explanations for blocked reason codes and failing `/readyz` dependency checks.

#### CI/CD & Repository Engineering
- **Multi-platform CI pipeline**: GitHub Actions automated pipeline covering Linux and native Windows 2022.
- **Security scanning**: Integrated Gitleaks secret scanning across full Git history, GitHub CodeQL semantic analysis, and automated dependency review.
- **Release management**: Automated release workflow triggered by version tags (`v*`) with manifest consistency checks (`scripts/release-check.mjs`) and reproducible release artifact packaging.
- **Community governance**: Added Contributor Covenant Code of Conduct, security advisory policy, support documentation, and structured issue and pull request templates.
