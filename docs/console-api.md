# Console API

The read-only HTTP API behind the Loopback console. It reads the gate's database and answers GET
requests; it cannot change anything.

- **Typed schemas:** [`packages/console-contracts/src/index.ts`](../packages/console-contracts/src/index.ts) (zod, with inferred TypeScript types).
- **Example responses:** [`docs/console-api-examples/`](console-api-examples/), one file per endpoint. A test checks each against its schema.

## Start without the gate

```bash
npm ci
npm run build
npm run console-api:mock
```

This serves the real API over throwaway fake data, on `http://127.0.0.1:8788/api/v1`, with the fixed
token `loopback-console-mock-token-not-a-secret` and `http://localhost:5173` allowed as an origin. It
adds an audit event every 10 s, so polling has something to find. The seven cases cover the states the
console must handle:

| Case | State | What it exercises |
|---|---|---|
| LB-001 | `Merged` | The whole story: signed verification, CI, approval, merge |
| LB-002 | `AwaitingApproval` | Advisory, unsigned verification with a finding |
| LB-003 | `Stale` | A new commit voided the approval and verification |
| LB-004 | `Blocked` | Terminal reason code, failed CI, high finding |
| LB-005 | `Reported` | **Hostile report text: use it to test your rendering** |
| LB-006 | `FixInProgress` | No PR yet: every PR field is `null` |
| LB-007 | `MergeUnknown` | Merge outcome not confirmed; the gate is reconciling |

## Connecting from Vite

`apps/console/vite.config.ts` already proxies `/api` to this API, so `npm run dev --workspace
apps/console` works with the mock as it is. For a real database, set `CONSOLE_API_TOKEN` in the
console's terminal too: the proxy then adds that token on the server side, so it never reaches the
browser bundle. `changeOrigin` is required, because the API refuses a Host header other than its own.

Do not put a real token in `VITE_*` variables: Vite compiles those into the bundle. The console's
client falls back to the mock's public token, which is harmless, because a real API refuses it.

**Not built yet:** the API does not serve the production console itself, so run it through the dev
server, on your own machine.

## Authentication

`Authorization: Bearer <token>` on every endpoint except `/health`. The token is a read-only shared
secret, unrelated to any GitHub, Switch or signer credential. Generate it with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Running it for real

Create `.env.console` (git-ignored). **Do not point it at the gate's `.env`:** the API refuses to
start if it finds `GH_APP_PRIVATE_KEY_PATH`, `GH_TOKEN`, `GITHUB_TOKEN`, `SWITCH_AGENT_API_KEY`,
`LOOPBACK_RUN_ISSUER_KEY_PATH` or any `SIGNER_*` in its environment.

```dotenv
CONSOLE_DB_PATH=/absolute/path/to/data/loopback.db   # required: the gate's DB_PATH
CONSOLE_API_TOKEN=                                   # required: at least 32 characters
CONSOLE_API_PORT=8788
CONSOLE_ALLOWED_ORIGIN=http://localhost:5173         # one exact origin; leave empty for none
CONSOLE_GATE_HTTP_PORT=8787                          # the gate's HTTP_PORT, for /gate
```

Then `npm run console-api`. It binds to 127.0.0.1 only. A remote console needs an SSH tunnel or a
reverse proxy you add deliberately; it has no TLS of its own.

To see the console on that data, in a second terminal (PowerShell shown):

```powershell
$env:CONSOLE_API_TOKEN = "<the same token as in .env.console>"
npm run dev --workspace apps/console    # then open http://localhost:5173
```

## Endpoints

All paths are under `/api/v1`. All are GET.

| Path | Response schema | Notes |
|---|---|---|
| `/health` | `HealthResponse` | No token. Only says this API is up |
| `/meta` | `MetaResponse` | States, event types, reason codes with transience |
| `/summary` | `SummaryResponse` | Dashboard counts; every state is present, including zeros |
| `/gate` | `GateStatusResponse` | The gate's own `/healthz` and `/readyz` |
| `/cases` | `CaseListResponse` | `?state= &limit= &cursor=`; newest first |
| `/cases/{id}` | `CaseDetail` | Case with evidence **for the current head only** |
| `/cases/{id}/commits` | `CommitListResponse` | Head history |
| `/cases/{id}/verification-runs` | `VerificationListResponse` | All runs, highest `sequence` first |
| `/cases/{id}/checks` | `CiListResponse` | All observations |
| `/cases/{id}/approvals` | `ApprovalListResponse` | All decisions, including voided ones |
| `/cases/{id}/merge-operations` | `MergeListResponse` | All attempts |
| `/cases/{id}/audit` | `AuditPageResponse` | `?after= &before= &limit=` |
| `/audit` | `AuditPageResponse` | `?after= &before= &limit= &type= &caseId=` |
| `/activity` | `AuditPageResponse` | `?after= &before= &limit=`; agent events only |

`limit` is 1–200, default 50. Unknown query parameters are refused, so a typo fails loudly.

### Paging and polling

Every page has `items` and `nextCursor` (`null` at the end). Pass `nextCursor` back as `cursor` for
cases, or as `before` for audit when reading newest first.

There is no push. To follow the audit log, poll with `after`, which returns the oldest events first:

```text
GET /audit?limit=50            newest events; remember items[0].id
GET /audit?after=<that id>     only what is new; remember the last item's id
```

Polling every 2–5 seconds is fine: each request is a short local read.

## Errors

Every non-2xx response has the same body, and `requestId` equals the `x-request-id` header:

```json
{ "error": { "code": "NOT_FOUND", "message": "No such case.", "requestId": "…" } }
```

| Status | `code` | Meaning | Console should |
|---|---|---|---|
| 400 | `BAD_REQUEST` | Invalid query; `message` says which | Treat as a bug |
| 401 | `UNAUTHORIZED` | Missing or wrong token | Show a configuration error |
| 403 | `FORBIDDEN` | Origin or Host not allowed | Show a configuration error |
| 404 | `NOT_FOUND` | No such case or endpoint | Show "not found" |
| 405 | `METHOD_NOT_ALLOWED` | Anything but GET | Treat as a bug |
| 500 | `INTERNAL` | Unexpected; details are in the server log only | Retry, then show an error |
| 503 | `DATABASE_UNAVAILABLE` | The gate has not created its database yet | Show "waiting for the gate"; keep polling |
| 503 | `SCHEMA_MISMATCH` | The gate and this API are different versions | Show a configuration error |

## What the console can and cannot show

- **Everything comes from the gate's database.** The API makes no GitHub calls and holds no GitHub
  credential, so **PR and CI status are what the gate's poller last saw**. Show `observedAt`, and
  link out with `pullRequestUrl` and `url` for the live page.
- **Agent activity is audit events.** No live session data, logs or token usage are recorded, so
  `/activity` is a timeline of what agents reported, not a live view of what they are doing.
- **Safety flags are not exposed.** `MERGE_ENABLED` and the others live in the gate's `.env`, which
  this API never reads. `/gate` reports health only.
- **No actions.** Approve, merge, retask and the rest happen in the Switch room, where the gate can
  authenticate the sender. Link to the room rather than adding buttons.

## Rendering rules

These fields come from outside and are **untrusted, even when signed**: `reportText`,
`reportExcerpt`, `report.summary`, `findings[].message`, `findings[].file`, approval `reason`, and
any string in an audit `payload`.

- Render them as plain text. Never `dangerouslySetInnerHTML`, and never a Markdown renderer that
  allows HTML or links. LB-005 is there to test this.
- Do not turn their contents into links. Only `pullRequestUrl` and check `url` are safe to link:
  the API guarantees they start with `https://github.com/`.
- `signature: "valid"` means the report came from the signer unaltered. It does **not** mean the
  tests ran or passed, so do not label it "verified". `advisory: true` means isolation is not
  proven, and the UI should say so.
- `isCurrentHead: false` evidence is history. It no longer counts toward a merge.
- A `Blocked` case with `blockedReasonTransient: true` can continue after a maintainer's `merge`
  command; `false` needs `retask`.

## Guarantees and how they are enforced

| Guarantee | Enforced by |
|---|---|
| Cannot change gate state | SQLite opened read-only and `query_only`; GET only; test compares the database before and after |
| Holds no gate credential | Refuses to start with one in its environment; imports limited by a lint rule (`lint-boundaries.test.ts`) |
| Undeclared fields cannot leave | Every response is parsed through its schema first |
| Credentials are not served | Signature bytes, the gate's merge error text, rooms, threads and `kv` are never selected; audit payloads are re-redacted by key and value |
| Local only | Binds to 127.0.0.1; checks Host (DNS rebinding) and Origin; exact-origin CORS |

Tests: `tests/integration/console-api.test.ts`.
