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
   (`who_can_talk: owner_and_owner_agents`). Allow the maintainers (and the fixer/verifier agents)
   to address the gate in Console, or `@loopback-gate` commands from them never count as addressed.

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
- Sender attribution: post as a maintainer and from an agent; record `sender`, `sender_kind`,
  `on_behalf_of`, `sender_role`. On 0.31.0 the live message event sets `sender_kind` only for
  platform-carried messages (`"platform"`), otherwise null, so `SWITCH_HUMAN_SENDER_KIND` cannot
  distinguish people from agents; privileged commands stay disabled until an attribution rule is
  verified and decided.
- Ids are stable across a Switch restart and reconnect; a threaded reply lands in its thread.
