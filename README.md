# Loopback

[![CI](https://github.com/puneetnith28/Loopback/actions/workflows/ci.yml/badge.svg)](https://github.com/puneetnith28/Loopback/actions/workflows/ci.yml)
[![CodeQL](https://github.com/puneetnith28/Loopback/actions/workflows/codeql.yml/badge.svg)](https://github.com/puneetnith28/Loopback/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen.svg)](.nvmrc)
[![Version](https://img.shields.io/badge/version-0.1.0--dev-orange.svg)](CHANGELOG.md)

Loopback is a commit-bound, auditable verification gate and human-governed AI bug maintenance system. It receives bug reports in a team chat room, tasks an AI fixer to investigate and open a pull request, gathers independent verification and CI evidence, and merges only when a human maintainer's approval, cryptographic verification, and CI are all bound to the exact same 40-character commit SHA.

> **Development Status: Pre-release (`v0.1.0`) — One real bug has completed the live lifecycle.**
> Case `LB-001` transitioned from public chat report to fixer PR, signed verifier evaluation, maintainer approval of the exact commit SHA, and a gate-executed merge on GitHub:
> [Evidence & Analysis](docs/evidence/phase-08-day2.md). Safety invariants remain default-off (`MERGE_ENABLED=false`, `LOOPBACK_PRIVILEGED_ENABLED=false`).

---

## Table of Contents

- [1. What Loopback Is](#1-what-loopback-is)
- [2. The Problem It Solves](#2-the-problem-it-solves)
- [3. Why Human-Controlled AI Maintenance Matters](#3-why-human-controlled-ai-maintenance-matters)
- [4. How the Workflow Operates](#4-how-the-workflow-operates)
- [5. Architecture Overview](#5-architecture-overview)
- [6. Core Capabilities](#6-core-capabilities)
- [7. Security and Trust Model](#7-security-and-trust-model)
- [8. Technology Stack](#8-technology-stack)
- [9. Local Development Setup](#9-local-development-setup)
- [10. Configuration & Environment](#10-configuration--environment)
- [11. Running Tests](#11-running-tests)
- [12. GitHub Actions and CI/CD](#12-github-actions-and-cicd)
- [13. Release & Versioning Process](#13-release--versioning-process)
- [14. Current Limitations & Known Boundaries](#14-current-limitations--known-boundaries)
- [15. Contribution & Community](#15-contribution--community)
- [16. Honesty Notes](#16-honesty-notes)
- [17. License](#17-license)

---

## 1. What Loopback Is

Loopback connects open-source bug intake in team chat (via [Switch](https://switch.chat)) with autonomous coding agents (fixer and verifier) and GitHub pull request workflows. Unlike completely autonomous maintenance bots that auto-merge PRs or post spam, Loopback enforces an infallible cryptographic and commit-bound policy: **nothing merges without human review of the exact commit SHA**.

The system comprises:
- **Switch Gate (`@loopback/switch-gate`)**: Daemon managing intake and maintainer chat rooms, agent tasking, poller tracking, SQLite persistence, and fail-closed merge execution.
- **Evidence Signer**: Cryptographic service generating and verifying Ed25519 signatures over verifier test results.
- **Console API (`@loopback/console-api`)**: Read-only, unprivileged HTTP server exposing case lifecycles, full commit histories, verification runs, and audit feeds.
- **Evidence Console (`@loopback/console`)**: Zero-trust React frontend presenting auditable proof, timeline inspections, and exact approval commands to maintainers.

---

## 2. The Problem It Solves

AI coding assistants can generate code fixes quickly, but deploying autonomous agents to open-source repositories introduces severe risks:
1. **Hallucinated or Flaky Fixes**: Agents claim a test passes when it was never executed or when it introduced silent regressions.
2. **Race Conditions & SHA Drift**: A maintainer reviews commit `A`, but a force-push or new commit `B` is pushed before merge, causing unintended code execution.
3. **Privilege Creep**: Autonomous bots granted broad write or admin permissions can be tricked via prompt injection in public bug reports.
4. **Lack of Verifiable Audit Trails**: Teams cannot discern whether tests ran in isolation or what evidence justified a merge.

Loopback eliminates these vulnerabilities through cryptographic verification, strict role separation, and fail-closed commit binding.

---

## 3. Why Human-Controlled AI Maintenance Matters

Loopback treats AI agents as untrusted proposal generators, not decision makers:
- **Maintainers Retain Total Authority**: Only a designated human maintainer can authorize a merge by approving the explicit full 40-character commit SHA in chat.
- **Independent Verification**: A verifier agent distinct from the fixer independently validates that a reproducer test failed *before* the fix and passes *after* the fix, without high-severity findings.
- **Evidence Bound to Commit**: Approvals and evidence apply strictly to one git commit SHA. If a single commit is added or amended, all prior evidence and approvals are immediately invalidated.

---

## 4. How the Workflow Operates

```
[Developer / User]
       │  !report <bug>
       ▼
[Public Intake Room] ───► [Switch Gate] ───► [Maintainers Room]
                                                   │
                                            !triage accept
                                                   ▼
                                         [Fixer Agent Tasked]
                                                   │
                                            Branch & PR Opened
                                                   ▼
[Verifier Agent] ◄── Verification Request ◄─ [GitHub Poller]
       │
Signed Report
       ▼
[Switch Gate] ───► Validates Signature & Regression Test
       │
       ├─► Maintainer reviews evidence in Read-Only Console
       │
[Maintainer] ─────► !approve LB-042 <40-char-sha>
       │
[Maintainer] ─────► !merge LB-042
       │
       ▼
[Gatekeeper] ─────► Re-verifies live PR head on GitHub
                    Checks CI green & approval quorum
                    Merges PR via GitHub API with sha precondition
                    Updates append-only audit log
```

1. **Intake & Triage**: Anyone writes `!report <bug>` in the public intake room. The gate creates case `LB-001` in state `Reported`. A maintainer reviews and executes `!triage accept LB-001` in the private maintainers' room.
2. **Investigation & PR**: The fixer agent investigates in a restricted sandbox, writes a regression test, implements the fix, and opens a GitHub PR.
3. **GitHub Poller**: Loopback observes the PR, records the branch, base commit, and head commit SHA, and tracks CI checks.
4. **Verification**: The gate dispatches an isolated verification request. The verifier checks that the regression test reproduces on the base and passes on the head. A cryptographic evidence report is signed.
5. **Human Approval**: The maintainer reviews the case in the Console or chat and executes:
   ```text
   @loopback-gate approve LB-001 <40-character-sha>
   ```
6. **Commit-Bound Merge**: On `@loopback-gate merge LB-001`, the gate re-evaluates all evidence against the live GitHub PR head. If unchanged, it executes GitHub's merge API with the commit SHA precondition.
7. **Refusal on Discrepancy**: If the head SHA changed, CI failed, or the signature is invalid, merge is refused with an auditable reason code.

---

## 5. Architecture Overview

```
                               ┌────────────────────────────────────────────────────────┐
                               │                    GitHub Platform                     │
                               │  - Pull Requests  - CI Status Checks  - Rulesets       │
                               └───────────────────────────▲────────────────────────────┘
                                                           │
                                        GitHub API Poller  │  Merge with SHA Precondition
                                                           │
┌──────────────────────────────┐                ┌──────────┴──────────┐                ┌──────────────────────────────┐
│         Switch Chat          │                │    Loopback Gate    │                │      Console Read-Only       │
│  - Public Intake Room        │◄──────────────►│  - State Machine    │◄──────────────►│  - React 19 Frontend         │
│  - Maintainers Room          │  WebSocket     │  - Policy Evaluator │  HTTP / SSE    │  - Audit Timeline & Badges   │
│  - Agent Task Dispatch       │  JSON Frames   │  - SQLite Audit Log │                │  - Zero Write Authority      │
└──────────────────────────────┘                └──────────┬──────────┘                └──────────────────────────────┘
                                                           │
                                                           │ Ed25519 Signature Verification
                                                           ▼
                                                ┌─────────────────────┐
                                                │   Evidence Signer   │
                                                │  - Independent Key  │
                                                │  - Report Attest    │
                                                └─────────────────────┘
```

Detailed architectural specifications and boundary rules are documented in [`docs/architecture.md`](docs/architecture.md).

---

## 6. Core Capabilities

- **Zero-Write Read-Only Console**: Complete visual transparency into case states, evidence seals, agent claims, and audit logs without exposing merge or mutation capabilities to the browser.
- **Fail-Closed Gatekeeper**: The gate merges with GitHub's `sha` precondition. If the commit changes by even one bit, the merge fails instantly.
- **Tamper-Evident Audit Logging**: All actions, transitions, check runs, and decisions append to an SQLite database with trigger-enforced `NO UPDATE` and `NO DELETE` rules.
- **Actionable Diagnostic Guidance**: Built-in operator explanations for all failure modes (`FIXER_TIMEOUT`, `HEAD_MOVED`, `CI_FAILED`, `PROTECTED_PATH_CHANGED`, etc.) and system dependency health checks (`/readyz`).
- **Multi-Platform Support**: Linux container isolation reference harness with full support for native Windows NTFS ACLs and console control handlers.

---

## 7. Security and Trust Model

Loopback enforces five fundamental security invariants:
1. **`MERGE_ENABLED=false` by default**: Autonomous merging is disabled until the repository owner explicitly opts in.
2. **`LOOPBACK_PRIVILEGED_ENABLED=false` by default**: Maintainer commands like `!approve` and `!merge` are refused until explicitly enabled.
3. **Exact Commit SHA Binding**: Approvals require the full 40-character hexadecimal SHA. Short SHAs or branch names are rejected.
4. **Principle of Least Privilege**:
   - Fixer & Verifier agents possess narrow fine-grained tokens (pull request creation only, no merge permission).
   - Only the Loopback Gate's GitHub App has merge permissions.
5. **Input Sanitization**: Untrusted user reports and agent summaries are strictly sanitized, text-clipped, and stripped of bi-directional control characters.

Detailed threat modeling and mitigations are in [`docs/threat-model.md`](docs/threat-model.md) and [`SECURITY.md`](SECURITY.md).

---

## 8. Technology Stack

- **Runtime**: Node.js `>=22.12.0 <23`
- **Languages**: TypeScript 6, Modern ESM JavaScript
- **Frontend**: React 19, Vite 8, IBM Plex typography
- **Data Persistence**: SQLite (via `better-sqlite3`) with trigger-level immutability
- **Validation**: Zod 4 for runtime schema enforcement
- **Cryptography**: Ed25519 asymmetric signatures via Node.js `crypto`
- **Testing**: Vitest 5, Playwright 1.64, Axe-core accessibility auditing
- **Security & CI**: Gitleaks 8.24.3, GitHub CodeQL, Dependency Review

---

## 9. Local Development Setup

### Prerequisites

- Node.js 22.12+ (managed via `.nvmrc`)
- npm 10+
- Git with LF line ending configuration

### Quickstart (Mock Environment — No External Accounts Needed)

```bash
# 1. Clone repository
git clone https://github.com/puneetnith28/Loopback.git
cd Loopback

# 2. Install dependencies
npm ci

# 3. Build workspace packages
npm run build

# 4. Run tests
npm test

# 5. Start read-only Console API mock (Terminal 1)
npm run console-api:mock

# 6. Start Evidence Console frontend (Terminal 2)
npm run dev --workspace apps/console
```
Open [http://localhost:5173](http://localhost:5173) to view the console with pre-seeded demo evidence.

---

## 10. Configuration & Environment

Copy `.env.example` to `.env` to configure a live environment:
```bash
cp .env.example .env
```

Key environment settings (see [`docs/operations.md`](docs/operations.md) for full descriptions):
- `GH_APP_ID`, `GH_APP_INSTALLATION_ID`, `GH_APP_PRIVATE_KEY_PATH`: GitHub App credentials for the gate.
- `SWITCH_SERVER_URL`, `SWITCH_BEARER_TOKEN`: Switch room connection configuration.
- `SWITCH_INTAKE_ROOM_ID`, `SWITCH_MAINTAINERS_ROOM_ID`: Target room identifiers.
- `LOOPBACK_RUN_ISSUER_KEY_PATH`: Ed25519 private key for issuing verification runs.
- `MERGE_ENABLED`: Set to `true` only when ready to allow merges.
- `LOOPBACK_PRIVILEGED_ENABLED`: Set to `true` to enable maintainer chat commands.

> **CRITICAL**: Never commit `.env`, `*.pem`, or database files. These are ignored by `.gitignore`.

---

## 11. Running Tests

```bash
# Typecheck all packages, tests, and console
npm run typecheck

# Lint with module boundary rules
npm run lint

# Run all unit, integration, and security tests
npm test

# Run tests with coverage thresholds (authoritative CI check)
npm run test:coverage

# Verify version consistency across all workspace packages
npm run release:check

# Run end-to-end console accessibility and browser tests
npm --prefix apps/console run test:e2e
```

---

## 12. GitHub Actions and CI/CD

Loopback maintains a strict GitHub Actions pipeline:

- **`.github/workflows/ci.yml`**:
  - `check`: Runs on Ubuntu Latest with Node 22; executes `typecheck`, `lint`, `release:check`, `test:coverage`, production builds, and full-history `gitleaks` secret scanning.
  - `windows-portable`: Runs natively on Windows 2022; validates NTFS ACL verification, Windows console signals, and cross-platform builds.
- **`.github/workflows/codeql.yml`**: Scheduled and PR-triggered CodeQL security analysis for JavaScript and TypeScript.
- **`.github/workflows/dependency-review.yml`**: Scans PRs for vulnerable dependencies and invalid licenses.
- **`.github/workflows/release.yml`**: Automated packaging and release verification triggered on tags (`v*`).

---

## 13. Release & Versioning Process

Loopback adheres to [Semantic Versioning](https://semver.org/).

### Versioning Rules
- `0.x.y`: Pre-release development. Breaking changes may occur between minor versions.
- `1.0.0`: Production stability milestone (requires proven verifier isolation and production gate deployment).

### Release Automation
Releases are triggered exclusively by pushing an authorized git tag:
```bash
# 1. Verify all workspace manifests match
npm run release:check -- v0.1.0

# 2. Tag and push (maintainers only)
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```
The [Release Workflow](.github/workflows/release.yml) validates dependencies, tests, builds, packages compiled console distributions with SHA-256 checksums, and publishes a GitHub Release.

---

## 14. Current Limitations & Known Boundaries

- **Single Instance**: The per-case lock is currently in-process; horizontal multi-node scaling is not yet supported.
- **Advisory Verification**: Until the verifier agent runs in its own isolated Docker container (`deploy/isolation/`) with dedicated credentials, verification remains marked **advisory**.
- **Local Health Endpoints**: Diagnostic and readiness endpoints (`/healthz`, `/readyz`) bind strictly to `127.0.0.1` and must not be exposed to public networks without authentication.
- **Direct GitHub Admin Bypasses**: Repository administrators can still bypass branch rules directly on GitHub; Loopback detects, alerts, and records such merges, but cannot restrict organization owners.

---

## 15. Contribution & Community

We welcome contributions aligned with Loopback's security invariants!

- Please review [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, coding style, and testing requirements.
- Review our [Code of Conduct](CODE_OF_CONDUCT.md).
- To report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
- For help or feature ideas, see [SUPPORT.md](SUPPORT.md).

---

## 16. Honesty Notes

- Initial code scaffolding was developed with Claude Code assistance.
- Core development started on 3 November 2026.
- The demo target repository is an independent repository (`loopback-demo-target`) containing a reproducible bug (Issue #1).
- The fixer's and verifier's GitHub tokens are fine-grained tokens owned by the maintainer's account; Loopback's durable audit log records which agent acted.

---

## 17. License

Distributed under the **Apache License 2.0**. See [`LICENSE`](LICENSE) for full details.
