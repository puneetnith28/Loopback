# Changelog

All notable changes to Loopback will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on stability**: Loopback is currently in active pre-1.0 development (`v0.1.0`).
> Safety invariants (`MERGE_ENABLED=false`, `LOOPBACK_PRIVILEGED_ENABLED=false`) remain default-off.

---

## [0.1.0] - 2026-11-05

Initial pre-release of Loopback: commit-bound, auditable verification gate and human-controlled AI bug maintenance system for GitHub and Switch.

### Added

#### Core Verification & Gate Architecture
- **Commit-bound merge gate**: The gate re-reads live GitHub state, re-verifies CI checks, cryptographic signatures, and maintainer approvals against the exact 40-character commit SHA before every merge attempt.
- **Fail-closed merge operations**: Strict precondition check prevents orphan approvals, race conditions, or merging when the PR head has moved.
- **Cryptographic verification evidence**: Ed25519-signed verification reports proving report integrity and run identity.
- **Append-only SQLite audit log**: Tamper-evident, SQLite trigger-enforced audit event log recording every state transition, triage decision, check run, and merge attempt.
- **Switch room integration**: Two-room transport design separating public intake (`!report`) from maintainer commands (`!triage`, `!approve`, `!merge`, `!retask`).
- **Isolation test harnesses & Windows portable runtime**: Reference Linux container isolation harness with Docker alongside native Windows NTFS ACL and console control signal handling.

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
