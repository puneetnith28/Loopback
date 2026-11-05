# @puneetnith28/loopback-console-contracts

HTTP wire protocol schemas, audit event models, and API contracts for the [Loopback](https://github.com/puneetnith28/Loopback) maintainer console and console API.

## Purpose

Loopback features a read-only maintainer console designed to provide operational visibility into autonomous agent runs without exposing write access to the gate or execution environments.

This package defines the wire schemas between `apps/console-api` (backend) and `apps/console` (frontend), ensuring end-to-end type safety and payload sanitization:

- **Strict Wire Envelopes**: All API responses are validated against runtime Zod schemas before serialization.
- **Untrusted Content Sanitization**: Exterior agent text, crash logs, and user reports are encapsulated as untrusted plain text.
- **Audit Verification**: Structured schemas for cryptographic evidence verification and audit events.

## Installation

This package is distributed via the **GitHub Packages npm registry** under the `@puneetnith28` scope.

### 1. Configure `.npmrc`

GitHub Packages requires authentication for package installation. Add the following to your project's `.npmrc`:

```ini
@puneetnith28:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Ensure your `GITHUB_TOKEN` (or PAT) includes the `read:packages` permission.

### 2. Install

```bash
npm install @puneetnith28/loopback-console-contracts @puneetnith28/loopback-contracts
```

## Public API & Exports

### Wire Response Schemas
- `SummaryResponse`: Top-level operational metrics (active cases, pending approvals, verifications completed).
- `CaseDetailResponse` / `CaseDetail`: Detailed case status including fixer branch, PR URL, verification evidence, and full commit SHA.
- `AuditLogResponse` / `AuditLogEntry`: Append-only audit events with timestamp, actor, action, and sealed evidence digest.
- `SettingsResponse`: Read-only view of runtime configuration (e.g. `mergeEnabled`, `privilegedEnabled`).
- `HealthResponse`: System health status and SQLite database connectivity.
- `ApiError`: Standardized error envelope with error code and human-readable message.

### Protocol Constants
- `API_VERSION`: Current REST API contract version (`v1`).

## Usage Example

```typescript
import {
  SummaryResponse,
  CaseDetailResponse,
} from "@puneetnith28/loopback-console-contracts";

async function fetchCase(caseId: string) {
  const response = await fetch(`/api/v1/cases/${encodeURIComponent(caseId)}`);
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const data = await response.json();
  // Validates wire contract at runtime
  const caseDetail = CaseDetailResponse.parse(data);
  return caseDetail;
}
```

## Security Design

The console contracts enforce read-only visibility. No mutation or state-transition endpoints exist within this contract. State updates are strictly mediated by the Switch Gatekeeper via authenticated chat commands and cryptographic agent signatures.

## License

Apache-2.0

