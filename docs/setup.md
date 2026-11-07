# Live environment setup

**Runtime platforms: Linux and Windows.** The gate needs Node `>=22.13.0 <23`, and refuses a GitHub App key
or key directory others can read or write. On Linux it uses rootless Docker for the agent containers
(`deploy/isolation/README.md`) and POSIX file permissions. On Windows it uses Docker Desktop and NTFS
ACLs; **read [windows.md](windows.md) first**, including what is weaker there. The commands below are
written for Linux.

Everything here is a manual step for the maintainer. It was done once, on one Windows machine
([evidence](evidence/phase-05.md)); nobody else has done it from a clean clone yet. Each section ends
with the checks that turn it from "configured" into "verified". Record the evidence for each check
before relying on it.

## 1. GitHub

### Demo repository (`loopback-demo-target`)
1. Create a dedicated demo repository under your GitHub account: `loopback-demo-target` (default branch: `main`).
2. Populate it with the minimal target application, automated tests (`npm test`), and a deliberately seeded reproducible bug (Issue #1).
3. In the repository, record the baseline commit as `DEMO_RESET_SHA`, tag it `demo-reset`, and add the
   CI workflow (job name `test`, triggered for PRs into the default branch `main` and `demo/**`).
4. Confirm the demo bug reproduces when the regression test runs.

### GitHub App `loopback-gate` (the only identity that can merge)

| Permission | Access | Why |
|---|---|---|
| Contents | Read & write | Merge the PR |
| Pull requests | Read & write | Read PRs, merge |
| Commit statuses | Read & write | Post `loopback/gate` |
| Checks | Read | Read CI check runs |
| Metadata | Read (default) | Required for every App; also covers `GET /repos/{o}/{r}/rules/branches/{branch}` per GitHub's fine-grained permissions reference |

No webhook. Install on the demo fork only. Save the private key as `secrets/gate.pem`
(file mode 600, in a directory created with `install -d -m 700 secrets`) and set `GH_APP_ID`,
`GH_APP_INSTALLATION_ID`. The gate refuses to start if the key file is group- or world-accessible
or its directory is group- or world-writable. `secrets/` is ignored by Git.

### Agent tokens (fine-grained, demo fork only, short expiry)

| Token | Contents | Pull requests | Commit statuses | Workflows | Checks |
|---|---|---|---|---|---|
| Fixer | Read & write | Read & write | **none** | **none** | — |
| Verifier | Read | Read | none | none | Read |

Both tokens are fine-grained tokens **owned by your personal GitHub account**. GitHub therefore
attributes the fixer's pushes and PRs (and any verifier comments) to your account, not to a bot;
Loopback's audit log is the record of which agent acted. Say so in the demo and in PR
descriptions.

Run each agent as its own OS user (or container) with only its token in `GH_TOKEN`, no access to
your home directory, `~/.ssh`, `~/.config/gh` or `secrets/`, and egress limited to GitHub, the npm
registry and its model provider.

### Verifier isolation (D28)
A second Claude Code session under the same OS user is **not** an isolated verifier: it can read
the same settings files (including the Switch key in the working directory) and the same GitHub
credentials. Until all of the following hold, keep `VERIFIER_ISOLATION_PROVEN=false`, and the gate
labels verification **advisory** in chat and in the audit log:
1. The verifier runs as a separate OS user (or container) whose home and working directory the
   fixer's user cannot read, and vice versa.
2. It has its own Switch agent registration and key, and its own verifier token (read-only).
3. Evidence is recorded: `id`, file permissions of both working directories, and a failed attempt
   by each user to read the other's credentials.

**Known gap today:** agent sessions still run as your desktop user, the same user as the gate,
so they can read the gate's `.env` and `secrets/gate.pem` (file modes do not separate a user from
itself). The container runtime in `deploy/isolation/` closes this for the agents: the fixer and
verifier containers have no bind mounts, so the gate's files are not in their filesystem
(checked by `agents.sh verify`). It takes effect only once the agent sessions run inside those
containers; until then, treat the GitHub App key as reachable by the fixer.

#### Identities and credentials (target layout)

| Identity | Holds, readable only by itself | GitHub | Switch |
|---|---|---|---|
| `loopback-gate` | `.env`, `secrets/gate.pem`, the database | App `loopback-gate` | agent `loopback-gate` |
| `loopback-fixer` | fixer token, fixer Switch key, its clone | fine-grained token: Contents and Pull requests R/W; no Statuses, Workflows or Administration | agent `loopback-fixer` |
| `loopback-verifier` | verifier token, verifier Switch key, **signing key**, its clone | fine-grained token: Contents, Pull requests, Checks **read only** | agent `loopback-verifier` |

Separate OS users or containers both work. Each home is mode 700; nothing is shared except read
access to the demo repository (each identity clones its own copy). The verifier has no git
credential helper and no write token.

#### Advisory versus isolated verification

- **Advisory** (`VERIFIER_ISOLATION_PROVEN=false`, the default): reports are accepted from the
  exact verifier id, bound to the run, repository, PR and full SHA, and re-checked against the
  live head, but labelled *advisory* in chat and audit. With `VERIFIER_PUBLIC_KEY` set, a report must
  carry a valid signature (D32). With no key, reports are accepted and recorded as unverified.
- **Isolated** (`VERIFIER_ISOLATION_PROVEN=true`): additionally every report must carry a valid
  Ed25519 signature from the verifier's key, checked before anything is recorded. The gate refuses
  to start unless `VERIFIER_PUBLIC_KEY`, `LOOPBACK_FIXER_AGENT_ID` and `LOOPBACK_VERIFIER_AGENT_ID`
  are set, the agent ids differ, and both are listed in `SWITCH_POLICY_AGENT_IDS`.

A valid signature proves that the report came from the holder of the verifier's key and was not
altered (run id, repository, PR, SHA, verdict, findings). It does **not** prove that the verifier
ran the tests, nor that its runtime is isolated: that is what the OS separation and the isolation
proof are for.

#### Independent signer (D29)

The verifier never holds a signing key. The key lives only in the `loopback-signer` container
(uid 10003, its own volume), which the verifier alone can reach and which signs a report only
under a capability the gate issued for that exact run (see `docs/architecture.md`, "Verifier
signing boundary"). PR code runs only in the `loopback-runner` container (no network, no
credentials).

1. Gate run-issuer key (host, gate's identity): an Ed25519 private key at an absolute path, mode
   600; set `LOOPBACK_RUN_ISSUER_KEY_PATH` to it. Put its public key in
   `~/.config/loopback-agents/signer.env` (mode 600) as `SIGNER_ISSUER_PUBLIC_KEY` (raw 32-byte
   base64, because an env file holds one line), with `SIGNER_REPOSITORY=<owner/repo>`:

   ```bash
   (umask 077; openssl genpkey -algorithm ed25519 -out secrets/run-issuer.pem)
   openssl pkey -in secrets/run-issuer.pem -pubout -outform DER | tail -c 32 | base64   # SIGNER_ISSUER_PUBLIC_KEY
   ```
2. `deploy/isolation/agents.sh signer-init`: creates the signing key and a client token inside the
   signer volume and prints only the signer's PUBLIC key; put it in the gate's
   `VERIFIER_PUBLIC_KEY`.
3. `deploy/isolation/agents.sh up`, then `deploy/isolation/agents.sh signer-token`: copies the
   client token from the signer volume into the verifier volume through a pipe (never shown,
   never on the host disk) and removes any D28 key left in the verifier.
4. Before each verification run: `deploy/isolation/agents.sh recycle-verifier` (fresh verifier
   container and home volume, so nothing a previous session planted survives). If the token may
   have leaked: `deploy/isolation/agents.sh signer-rotate-token`.
5. The verifier signs with `node /opt/loopback/request-signature.mjs --capability 'lbcap1…' <
   report.json` and runs tests with `node /opt/loopback/run-in-sandbox.mjs --tree . -- <argv>`
   (`prompts/verifier.md`).

#### Isolation proof

1. Run `deploy/isolation/agents.sh verify` (read-only; `scripts/verify-isolation.mjs`): `host`
   checks the daemon is the per-user rootless one and each container's hardening (non-root uid,
   no capabilities, no-new-privileges, read-only root, no bind mounts or Docker socket, its own
   home volume, its exact networks (each agent's own internal network shared only with its proxy;
   the verifier also the signer network), limits, no `GITHUB_TOKEN`) and
   that fixer and verifier share no uid, volume or network, that only the signer mounts its key
   volume, and the signer's and runner's networks; `fixer` and `verifier` run **inside
   their containers** (the other role's home unreadable, no capabilities, read-only root, root-owned
   tooling, direct connections to the internet, GitHub, LAN, the host gateway and the metadata
   address fail, the proxy allows only the allowlist; for the verifier also no private key
   anywhere in its home, its own mode-600 signer token, the signer reachable but refusing
   unauthenticated requests, no git credential helper and a read-only GitHub GET); `signer` (its
   own key, GitHub API only, no agent reachable) and `runner` (no network, no DNS, no credentials,
   jobs read-only) run inside theirs. Outside a container, or
   without the daemon, it exits 2 ("CANNOT RUN … NOT PROVEN"). Missing evidence counts as failure
   (exit 1). Save the output (latest run: `docs/evidence/phase-06-isolation.md`).
2. Separately authorised: probe that the verifier token cannot write (requests that cannot change
   anything, e.g. a status on a non-existent commit: 403 = no permission, 422 = permission present).
3. A real signed report on a live PR is recorded with `signature: "valid"`; a forged one (unsigned,
   or sent from the fixer) is rejected and audited.
4. Only then set `VERIFIER_ISOLATION_PROVEN=true` with the public key and agent ids. The script
   existing, or passing once, does not make the flag true by itself.

### Rulesets
1. **Branch ruleset** targeting the default branch and `demo/*`: active, **empty bypass list**,
   restrict deletions, block force pushes, require a pull request (0 approvals), require status
   checks `test` (source: GitHub Actions) and `loopback/gate` (source: the `loopback-gate` App),
   with "require branches to be up to date" and **"do not require status checks on creation"**.
   Without that last setting, GitHub refuses to create any `demo/<run-id>` branch (HTTP 422,
   "Reference update failed"). The App can be chosen as a source only after it has
   posted a `loopback/gate` status once; post a one-off status on a throwaway commit first.
   Keep enforcement **active**: rules in "evaluate" mode are not returned to the gate, which then
   blocks every merge with `BASE_UNPROTECTED`.
2. **Tag ruleset** targeting `demo-reset`: restrict updates and deletions.
3. Export the branch ruleset: `gh api repos/OWNER/REPO/rulesets/ID > docs/ruleset.json`.

### Required-Status-Check Source Validation & Configuration
- **`CHECK_SOURCES`**: Maps PR check-run names to expected App slugs (e.g. `test:github-actions`), validating the `appSlug` of check runs returned by the GitHub Checks API.
- **`REQUIRED_CHECK_INTEGRATIONS`**: Maps required status check contexts to ruleset integration IDs (format: `<check>:<integration-id>`, comma-separated). This validates the numerical GitHub App integration ID returned by GitHub's branch rules endpoint.
- **`loopback/gate` binding**: The expected integration ID for `GATE_STATUS_CONTEXT` (`loopback/gate`) is automatically bound to `GH_APP_ID`. Supplying an explicit mapping in `REQUIRED_CHECK_INTEGRATIONS` is optional, but if supplied it must match `GH_APP_ID`.
- **Fail-closed behavior**: `evaluateMerge` fails closed with terminal reason `CHECK_SOURCE_MISMATCH` if any required context has no ruleset entry, has a null source (`integrationId: null`), has a mismatched integration ID, or contains conflicting duplicate sources.
- **GitHub Actions Integration ID**: GitHub Rulesets can only associate an `integration_id` with a check name after that check has run in the repository. Because workflow CI runs on pull requests, the actual GitHub Actions App ID must be obtained from an executed check run on a PR before configuring `REQUIRED_CHECK_INTEGRATIONS` in `.env`.

### Verify (record each outcome in `docs/threat-model.md`)
- `scripts/verify-github-setup.sh` (read-only) passes.
- `LOOPBACK_LIVE_GITHUB=1 npm test -- --project e2e` passes (read-only App checks).
- The ruleset proof, `npm run ruleset-proof` (dry run first; it needs the fixer's token and a run
  branch): a PR with green `test` but no `loopback/gate` cannot be merged, even with a
  `loopback/gate` success from another source; the fixer token cannot merge or post
  `POST /statuses`; a fixer push changing `.github/workflows/` is rejected; the fixer cannot push
  to `demo/<run-id>`; the `demo-reset` tag cannot be moved.

## 2. Switch

Verified against Switch Console 0.40.1 / switch-core 0.31.0 (agent bridge on
`http://127.0.0.1:<api port>` from `~/.config/switchdash/local-switch-server/ports.json`).

1. Install Switch Console (Linux is "early access"): `sudo apt install ./switch-console-amd64.deb`,
   then complete the interactive logins. Record the exact Console and server versions.
2. Register `loopback-gate` once with `POST /agents` and a registration key (a personal key, or
   the deployment bootstrap key, which makes the non-admin "Agent Bootstrap" account the owner).
   Store the returned `id` and `api_key` in `.env` as `SWITCH_AGENT_ID` / `SWITCH_AGENT_API_KEY`
   without printing them, then remove the registration key from `.env`.
3. Create the team from the template: in Switch Console, **Templates**, **Import template**, choose
   [`templates/loopback.template.yaml`](../templates/loopback.template.yaml), then **Use**. It creates
   the fixer and verifier agents, a private maintainers' room and a public intake room, with the gate in
   both and each agent's brief from `prompts/`. Switch 0.31 accepts the file with no warnings; running
   it end to end has not been tried yet, and our live rooms were made by hand. Put the rooms' ids in
   `.env` as `SWITCH_ROOM_ID` and `SWITCH_INTAKE_ROOM_ID`. After changing `prompts/`, run
   `npm run switch-template`. Two rooms is decision D26: the gate opens one connection per room
   (`scope=single`, `rooms=<that room>`) and posts in each room only through that room's connection.
4. New agents only accept addressing from their owner and the owner's agents
   (`who_can_talk: owner_and_owner_agents`). The gate needs exactly two rules instead:
   - `rooms: [SWITCH_ROOM_ID]`, `room_groups: "*"`, `users: [maintainer ExternalUser ids]`,
     `agents: [fixer and verifier agent ids]`, `owner`, `owner_agents`, `platform` false;
   - `rooms: [SWITCH_INTAKE_ROOM_ID]`, `room_groups: "*"`, `users: "*"`, `agents: []`,
     `owner`, `owner_agents`, `platform` false.

   A workspace admin sets it with `PUT /gateway/agents/{id}/addressing-policy` (Console shows the
   control only for agents you own). Put the maintainers' ids in `SWITCH_POLICY_USER_IDS` and the
   agents' ids in `SWITCH_POLICY_AGENT_IDS`; the gate checks the live policy at startup and every
   60 s and exits with code 4 if it differs.
5. The gate lists its Switch operations at startup (`GET /agents/{id}/ops`) and exits with code 5
   unless `post_message` and `read_context` are available. It keeps its documents in the maintainers'
   room only if `create_room_document` and `update_room_document` are available too.

### Authorization
- A message reaches a handler only if Switch addressed it to the gate (its policy admitted the
  sender) **and** it passes admission: not the gate itself, not `sender_kind: "platform"`, no
  `on_behalf_of`, `sender_kind` null. Commands from people then get a role from the exact `sender`
  id in `LOOPBACK_MAINTAINERS` / `LOOPBACK_REPORTERS`. Reports count only from the exact
  `LOOPBACK_FIXER_ID` / `LOOPBACK_VERIFIER_ID` and must be addressed too, so the fixer and verifier
  must start each report with `@loopback-gate`.
- Grant a maintainer in both places (Switch policy `users`, Loopback list); revoke by removing
  either. Removing someone from `LOOPBACK_MAINTAINERS` also voids their recorded approvals.
- Privileged commands stay off until `LOOPBACK_PRIVILEGED_ENABLED=true`.
- In the intake room anyone may `help`, `report` and `status` (own reports only); nothing else
  exists there, whatever the sender's role. A public report waits in `Reported` until a maintainer
  runs `accept LB-xxx` (tasks the fixer) or `decline LB-xxx <reason>` in the maintainers' room.
  Triage is not a privileged command. Refusals to anyone but a maintainer in their own room use
  one generic text (D27); every refusal is audited with its precise reason.
- The policy ids (`SWITCH_POLICY_*`, Switch row UUIDs) and Loopback's participant ids are
  different identifiers, and the gate cannot check that they name the same people and agents.
  A mismatch fails closed (reports refused, or commands with the outsider role), but configure
  both from the same `whoami` / bridge-users evidence.

### Identity stability (switch-core 0.31.0 source, not yet verified live)
- A Mattermost person's `sender` id (`@switch-mattermost-<bridge>-<username>:<server>`) is created
  once per bridge and Mattermost user id; the username only seeds it
  (`bridges/collaboration/collaboration_core.py`, `_create_human_actor_locked`).
- A Mattermost rename keeps the id ("the client keeps its localpart").
- Another account that later takes the same username cannot inherit the id: the collision is
  detected and the new account gets `<localpart>-<digest>` unless it is the same Mattermost user.
- Still unverified live; until then deactivate departed Mattermost accounts instead of deleting
  them, and re-check `whoami` after any rename.

### Transport (implemented)
- WebSocket `/agents/{id}/connection/ws`, Bearer auth, agent-protocol 9, `scope=single`,
  `filter=all`, one connection per room, each claiming its room on open. Each room's connection id,
  generation and resume position are kept in the gate's database (`switch_connection:<room id>`); a
  restart reattaches fenced on that generation. The maintainers' room adopts the record saved by
  the earlier single-room gate. If either connection stops for good, both stop.
- A `gap` frame (events Switch could not deliver) triggers recovery for that room: `read_context`
  through that room's connection, a `delivery.gap` audit entry, a count-only notice to
  maintainers, and reconciliation of every case. Missed messages are not executed; senders resend.
- `taken_over` (an `evicted` frame, a 409 on the fenced beat, close code 4409) stops the gate with
  exit code 3 and is never retried. Authentication, membership and protocol refusals also stop it;
  network failures and 5xx are retried with a bounded backoff.
- Replies in a thread use `POST /agents/{id}/ops/post_message` with `X-Switch-Connection-Id`;
  top-level messages use `POST /agents/{id}/message`.

### Verify
- `LOOPBACK_LIVE_SWITCH=1 npm test -- --project e2e` (posts two labelled messages into the
  maintainers' room; it does not exercise the intake room).
- Two rooms (not yet verified live): both connections open; a public account in the intake room
  can `report` and gets the receipt; the triage notice appears in the maintainers' room; a public
  account's `approve` gets the generic refusal; an agent mention in the intake room arrives with
  `addressed: false`.
- Sender attribution: on 0.31.0 people arrive with `sender_kind` null, `on_behalf_of` null and
  `sender_role` null until their account is linked (observed live). Agent and platform messages
  have not been observed yet; record them before enabling privileged commands.
- An account outside the policy mentioning the gate arrives with `addressed: false` and is
  refused (audited, not answered).
- Ids are stable across a Switch restart and reconnect; a threaded reply lands in its thread.

## 3. Using Slack instead of Mattermost

The gate speaks only to Switch, so the chat app is Switch's choice. Everything above holds for Slack,
with these differences. They come from reading switch-core 0.31.0's Slack bridge
(`bridges/collaboration/slack/adapter.py`) and from `tests/integration/slack-delivery.test.ts`, which
feeds the gate messages as that bridge delivers them. The gate has run a complete case in a Slack
workspace: a report in the intake channel, triage, the fixer's pull request, the verifier's signed
report, an approval voided by a later commit, a refused merge, a fresh approval and a merge confirmed
by GitHub (PR #8 in the demo repository, 25 audit events).

### What the Slack bridge does for you
- **Mentions arrive as names.** Picking `@loopback-gate` from Slack's `@` menu sends a user-group
  code, `<!subteam^S…>`; the bridge turns it back into `@loopback-gate` before Switch addresses the
  message (`_translate_usergroup_mentions`). A person's `<@U…>` becomes `@username` the same way.
  So commands parse exactly as they do from Mattermost.
- **People get Switch ids in the same shape:** `@switch-slack-<bridge id>-<username>:<server>`, made
  once per bridge and Slack user (`collaboration_core._create_human_actor_locked`). Read them from
  `whoami` or the bridge's users, as for Mattermost.

### What the gate does for Slack
- **Slack's escapes are decoded in people's commands.** Slack sends `<`, `>` and `&` as `&lt;`, `&gt;`
  and `&amp;`, and the bridge passes them on. The gate decodes exactly those three, once, before
  parsing (`decodeChatEscapes` in `apps/switch-gate/src/commands/parse.ts`). Agents' reports are never
  decoded: they come through Switch's agent API, and their signatures must match what was sent.
- **A command pasted as code still runs.** Slack keeps the backticks when someone pastes the gate's
  own command from a code span. A message that is entirely one code span is unwrapped first; a code
  span inside prose is not.
- **A mention the bridge could not resolve does nothing.** If the agent's user group has not been
  adopted yet, the raw `<!subteam^…>` reaches the gate, the message does not start with the gate's
  mention, and it is refused as an unknown command.

### Setting it up
1. In Switch Console, **Home**, **Messaging apps**, **Connect**, and choose Slack. Install Switch's
   Slack app in the workspace.
2. Use the template with **Slack** as the messaging app. It creates `loopback-intake` (public) and
   `loopback-maintainers` (private) as Slack channels.
3. Invite Switch's Slack app to the private `loopback-maintainers` channel, and check that someone
   outside it cannot read it.
4. Put the Slack people's Switch ids in `LOOPBACK_MAINTAINERS` and in the addressing policy's `users`,
   and the two new room ids in `SWITCH_ROOM_ID` and `SWITCH_INTAKE_ROOM_ID` (section 2, step 4).
5. `npm run readiness`, then `npm run gate`.

### Check on the first live run
- `@loopback-gate` picked from the menu and typed by hand both work.
- `@loopback-gate decline LB-001 a < b & c` records the reason as typed.
- A case raised in a Slack thread keeps its replies in that thread.
- Two or three quick replies from the gate all arrive (Slack limits how fast a bot posts).
- The gate fences untrusted report text with `~~~untrusted-report`. Slack does not render `~~~`
  fences, so people see the tildes; the fixer reads the text through Switch, so the fence still
  works for it. Decide whether that is acceptable to read.

Discord works the same way in switch-core 0.31.0: its bridge turns role and user mentions back into
`@name` (`bridges/collaboration/discord/adapter.py`, `translate_inbound`). It has not been tried either.
