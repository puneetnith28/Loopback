# Architecture

```mermaid
flowchart TB
  Public["Anyone (public contributors)"] -->|chat| IR["Public intake room"]
  Maint["Maintainers"] -->|chat| MR["Private maintainers' room"]
  IR <--> SW["Switch (agent bridge)"]
  MR <--> SW
  SW <-->|"one WebSocket connection per room (D26)"| GATE["loopback-gate (Node 22, TypeScript)"]
  SW <--> FX["Fixer agent"]
  SW <--> VF["Verifier agent"]
  FX -->|"push branch, open PR (no status/merge rights)"| GH["GitHub"]
  VF -->|read only| GH
  GATE -->|"read PR/checks/rules; post loopback/gate; merge with sha precondition"| GH
  GATE --> DB[("SQLite: cases, evidence, approvals, merge attempts, append-only audit")]
```

## Modules (`apps/switch-gate/src`)

| Module | Responsibility |
|---|---|
| `config.ts` | Per-group, fail-closed configuration; never echoes values |
| `commands/` | Closed command grammar (`parse.ts`) and routing with audited refusals (`router.ts`) |
| `policy/` | Pure functions only: roles and authorization, `evaluateMerge`, invariants |
| `cases/` | State machine with guarded exceptions, transactional transitions, per-case lock, merge executor and reconciliation |
| `workflow/` | Fixer hand-off, verification requests and report ingestion, timeouts, approvals, retask, GitHub poller |
| `github/` | Typed REST client over `fetch` with App auth; the isolated merge call |
| `persistence/` | Migrations and typed repositories |
| `audit/` | Append-only audit log with redaction |
| `agents/` | Extraction of `loopback-report` blocks from untrusted agent output |
| `chat/` | Refusal wording, status/audit rendering, escaping |
| `switch/` | Switch transport: one connection per room (`rooms.ts`, `connection.ts`), room-keyed posting (`chat.ts`), connection records (`store.ts`), operation discovery and `read_context` (`ops.ts`), delivery-gap recovery (`gap.ts`), addressing-policy self-check (`policy-check.ts`) |
| `observability/` | Redacting logger, loopback-only health endpoints |
| `startup.ts` | Preflight (identity, policy), the periodic policy watch, readiness checks |
| `app.ts`, `main.ts` | Composition root and entry point |

Lint boundaries (tested in `tests/unit/lint-boundaries.test.ts`): `policy/` imports only the
contracts; the merge call is reachable only from `cases/service.ts` and the composition root
(`app.ts`, which injects it); only `github/*` and the composition root may import the raw GitHub
transport; audit internals are reachable only through `audit/index`.

## Rooms (D26)

The gate serves two Switch rooms over two connections of the same agent identity (a
`scope=single` connection holds one room, and threaded replies go to that room):

| | Maintainers' room (private) | Intake room (public) |
|---|---|---|
| Who Switch admits to address the gate | Exactly `SWITCH_POLICY_USER_IDS` and the fixer/verifier `SWITCH_POLICY_AGENT_IDS` | Any person (`users: "*"`), no agents (`agents: []`) |
| Commands | All, by role; privileged ones only with `LOOPBACK_PRIVILEGED_ENABLED=true` | `help`, `report`, `status` (own reports only) |
| Agent reports | Accepted from the exact fixer/verifier ids | Refused (`WRONG_ROOM`) |
| Refusals (D27) | Precise reason for maintainers; generic text for anyone else | Generic text, rate-limited per sender |

A public report becomes a case in `Reported` and a triage notice in the maintainers' room; only
a maintainer's `accept` tasks the fixer (`decline` blocks it with `TRIAGE_DECLINED`). Each room
keeps its own connection record (`switch_connection:<room id>`); the maintainers' room adopts the
record saved before rooms were split, so an upgraded gate reattaches fenced. If either connection
stops for good, both stop and the process exits (all-or-nothing).

If Switch reports a delivery gap, the gate reads the room's recent history (`read_context`),
records unprocessed messages aimed at it in the audit log, tells maintainers how many to resend
(never the content), and reconciles every case against GitHub. Recovered messages are **never
executed**: `read_context` carries no `addressed` flag, so they cannot pass admission.

## Trust boundaries

| Component | Trusted for | Never trusted for |
|---|---|---|
| Switch | Delivering messages and the sender's participant id | Proof that GitHub policy was enforced |
| Fixer | Doing the work | Claims that tests passed or a PR exists |
| Verifier | A second opinion, as structured evidence bound to a run and to the PR's live head; **advisory** (labelled so) until `VERIFIER_ISOLATION_PROVEN=true` (D28) | Approving or merging |
| Public intake room | Receiving a report and its sender id | Anything beyond `help`, `report`, `status`; tasking the fixer |
| Gatekeeper | Policy decisions | Its own past state when GitHub disagrees |
| GitHub | Repository, PR, commit, CI and merge state | — |

## Case lifecycle

`Reported → Triaged → FixInProgress → PRCreated → Verifying → AwaitingApproval → ReadyToMerge →
Revalidating → Merging → Merged`, with `Stale`, `VerificationFailed`, `Blocked` and
`MergeUnknown` as the specified side states. Public reports wait in `Reported` until a
maintainer's `accept` (`Reported → Triaged → FixInProgress`) or `decline` (`→ Blocked`). Two exceptions to the specified table exist (D18):
`Blocked → Revalidating` only for transient reasons on a maintainer `merge`, and open-PR states
`→ Blocked` only when GitHub shows the PR closed. Reconciliation can never reach `Merging`.
