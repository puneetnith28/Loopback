# Live environment setup

Everything here is a manual step for the maintainer. None of it has been performed or
verified yet; each section ends with the checks that turn it from "configured" into
"verified". Record the evidence for each check before relying on it.

## 1. GitHub

### Demo repository
1. Fork `simov/slugify` (MIT) to your account. Its default branch is `master`.
2. In the fork, record the starting commit as `DEMO_RESET_SHA`, tag it `demo-reset`, and add the
   CI workflow (job name `test`, triggered for PRs into the default branch and `demo/**`).
3. Confirm the demo bug reproduces (issue #177: `slugify.extend({'%': null})` throws).

### GitHub App `loopback-gate` (the only identity that can merge)

| Permission | Access | Why |
|---|---|---|
| Contents | Read & write | Merge the PR |
| Pull requests | Read & write | Read PRs, merge |
| Commit statuses | Read & write | Post `loopback/gate` |
| Checks | Read | Read CI check runs |
| Metadata | Read (default) | Required for every App; also covers `GET /repos/{o}/{r}/rules/branches/{branch}` per GitHub's fine-grained permissions reference |

No webhook. Install on the demo fork only. Save the private key as `secrets/gate.pem`
(mode 600) and set `GH_APP_ID`, `GH_APP_INSTALLATION_ID`.

### Agent tokens (fine-grained, demo fork only, short expiry)

| Token | Contents | Pull requests | Commit statuses | Workflows | Checks |
|---|---|---|---|---|---|
| Fixer | Read & write | Read & write | **none** | **none** | — |
| Verifier | Read | Read | none | none | Read |

Run each agent as its own OS user (or container) with only its token in `GH_TOKEN`, no access to
your home directory, `~/.ssh`, `~/.config/gh` or `secrets/`, and egress limited to GitHub, the npm
registry and its model provider.

### Rulesets
1. **Branch ruleset** targeting the default branch and `demo/*`: active, **empty bypass list**,
   restrict deletions, block force pushes, require a pull request (0 approvals), require status
   checks `test` (source: GitHub Actions) and `loopback/gate` (source: the `loopback-gate` App),
   with "require branches to be up to date". The App can be chosen as a source only after it has
   posted a `loopback/gate` status once; post a one-off status on a throwaway commit first.
   Keep enforcement **active**: rules in "evaluate" mode are not returned to the gate, which then
   blocks every merge with `BASE_UNPROTECTED`.
2. **Tag ruleset** targeting `demo-reset`: restrict updates and deletions.
3. Export the branch ruleset: `gh api repos/OWNER/REPO/rulesets/ID > docs/ruleset.json`.

### Verify (record each outcome in `docs/threat-model.md`)
- `scripts/verify-github-setup.sh` (read-only) passes.
- `LOOPBACK_LIVE_GITHUB=1 npm test -- --project e2e` passes (read-only App checks).
- Manual probes from the plan's ruleset proof: a PR with green `test` but no `loopback/gate`
  cannot be merged; the fixer token gets 405 on merge and 403 on `POST /statuses`; a fixer push
  changing `.github/workflows/` is rejected; the fixer cannot push to `demo/<run-id>`.

## 2. Switch

Verified against Switch Console 0.40.1 / switch-core 0.31.0 (agent bridge on
`http://127.0.0.1:<api port>` from `~/.config/switchdash/local-switch-server/ports.json`).

1. Install Switch Console (Linux is "early access"): `sudo apt install ./switch-console-amd64.deb`,
   then complete the interactive logins. Record the exact Console and server versions.
2. Register `loopback-gate` once with `POST /agents` and a registration key (a personal key, or
   the deployment bootstrap key, which makes the non-admin "Agent Bootstrap" account the owner).
   Store the returned `id` and `api_key` in `.env` as `SWITCH_AGENT_ID` / `SWITCH_AGENT_API_KEY`
   without printing them, then remove the registration key from `.env`.
3. Make the gate a member of the maintainers' room and set `SWITCH_ROOM_ID`. The gate claims that
   room when it connects (`rooms=` on the WebSocket) and posts only there.
4. New agents only accept addressing from their owner and the owner's agents
   (`who_can_talk: owner_and_owner_agents`). The gate needs exactly one rule instead:
   `rooms: [SWITCH_ROOM_ID]`, `room_groups: "*"`, `users: [ExternalUser ids]`,
   `agents: [fixer and verifier agent ids]`, `owner`, `owner_agents` and `platform` false. A workspace
   admin sets it with `PUT /gateway/agents/{id}/addressing-policy` (Console shows the control only
   for agents you own). Put the same ids in `SWITCH_POLICY_USER_IDS` and `SWITCH_POLICY_AGENT_IDS`;
   the gate checks the live policy at startup and exits with code 4 if it differs.

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
  `filter=all`, the room claimed on open. The connection id, the generation last held and the
  resume position are kept in the gate's database; a restart reattaches fenced on that generation.
- `taken_over` (an `evicted` frame, a 409 on the fenced beat, close code 4409) stops the gate with
  exit code 3 and is never retried. Authentication, membership and protocol refusals also stop it;
  network failures and 5xx are retried with a bounded backoff.
- Replies in a thread use `POST /agents/{id}/ops/post_message` with `X-Switch-Connection-Id`;
  top-level messages use `POST /agents/{id}/message`.

### Verify
- `LOOPBACK_LIVE_SWITCH=1 npm test -- --project e2e` (posts two labelled messages into the room).
- Sender attribution: on 0.31.0 people arrive with `sender_kind` null, `on_behalf_of` null and
  `sender_role` null until their account is linked (observed live). Agent and platform messages
  have not been observed yet; record them before enabling privileged commands.
- An account outside the policy mentioning the gate arrives with `addressed: false` and is
  refused (audited, not answered).
- Ids are stable across a Switch restart and reconnect; a threaded reply lands in its thread.
