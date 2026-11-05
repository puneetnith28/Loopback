# @puneetnith28/loopback-contracts

Core TypeScript vocabulary, Zod runtime schemas, state machine definitions, and security invariants for the [Loopback](https://github.com/puneetnith28/Loopback) autonomous agent orchestration gate.

## Purpose

Loopback orchestrates autonomous AI fixers and independent verifiers under strict human maintainer supervision. This package defines the foundational domain contracts and wire primitives shared across:

- **Fixer and Verifier agent authors**: Construct and validate structured task briefs, run reports, and cryptographic verification evidence.
- **Switch Gatekeeper**: Enforce parse invariants, admission policies, and tamper-evident state transitions.
- **Maintainer Console**: Inspect signed evidence, audit trails, and case lifecycles.

## Installation

This package is distributed via the **GitHub Packages npm registry** under the `@puneetnith28` scope.

### 1. Configure `.npmrc`

GitHub Packages requires authentication for package installation. Add the following to your project's `.npmrc` (or `~/.npmrc`):

```ini
@puneetnith28:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Ensure your `GITHUB_TOKEN` (or GitHub Personal Access Token) includes the `read:packages` permission.

### 2. Install

```bash
npm install @puneetnith28/loopback-contracts
```

## Public API & Exports

### Primitives & Invariants
- `CaseId`: Validates case identifiers matching `^LB-[0-9]{3,}$`.
- `FullSha`: Enforces strict 40-character lowercase hexadecimal git commit SHAs (no short SHAs permitted in approvals).
- `RepoSlug`: Enforces `owner/repo` format without directory traversal.
- `ParticipantId`: Formats and validates chat participant identifiers (`@username:domain`).
- `displaySha(sha)`: Helper to safely format a 40-character SHA down to 12 characters for UI and chat notifications.

### State Machine & Reasons
- `CASE_STATES`: Readonly array of 14 deterministic workflow states (`Reported`, `Triaged`, `FixInProgress`, `PRCreated`, `Verifying`, `VerificationFailed`, `AwaitingApproval`, `ReadyToMerge`, `Revalidating`, `Merging`, `Merged`, `Stale`, `Blocked`, `MergeUnknown`).
- `CaseState`: TypeScript union type of all valid case states.
- `REASON_CODES` / `ReasonCode`: Structured audit and failure codes.
- `TRANSIENT_REASON_CODES` / `isTransient(code)`: Determines whether a failure code represents a retryable transient error.

### Agent Reports & Verification
- `FixerReport`: Schema for fixer completion reports, including pull request URL and commit SHA.
- `VerifierReport`: Schema for verifier execution, regression outcome, findings, and head SHA binding.
- `verdictIsConsistent(report)`: Validates that verdict, findings severity, and regression replication match expected invariants.

### Chat & Wire Protocol
- `InboundMessage`: Schema for ingress chat events parsed from the Switch room transport.
- `Command` / `COMMAND_KINDS`: Structured maintainer command schemas (`report`, `accept`, `reject`, `approve`, `merge`, `retask`, `help`, `status`).

### Settings
- `GateSettings` / `GATE_SETTINGS_KEY`: Persistence schema for operational flags (`mergeEnabled`, `autoApproval`, etc.).

## Usage Example

```typescript
import {
  VerifierReport,
  verdictIsConsistent,
  FullSha,
} from "@puneetnith28/loopback-contracts";

// Validate a 40-character SHA
const shaResult = FullSha.safeParse("3f9c2ab4e1d0b4c9a8f7e6d5c4b3a2918f7e6d5c");
if (!shaResult.success) {
  throw new Error("Invalid commit SHA: must be full 40-character lowercase hex");
}

// Validate verifier evidence
const report = VerifierReport.parse({
  type: "verifier",
  runId: "a0000000-0000-4000-8000-000000000001",
  caseId: "LB-001",
  repository: "puneetnith28/Loopback",
  pullRequest: 42,
  headSha: "3f9c2ab4e1d0b4c9a8f7e6d5c4b3a2918f7e6d5c",
  verdict: "pass",
  findings: [],
  regressionTestFailsBeforeFix: true,
  summary: "Regression test fails before fix and passes on PR head.",
});

if (!verdictIsConsistent(report)) {
  throw new Error("Tampered or inconsistent verifier report");
}
```

## Security Invariants

All contracts are strictly validated at runtime with [Zod](https://zod.dev). Unrecognized fields are stripped or rejected according to schema strictness rules.

## License

Apache-2.0

