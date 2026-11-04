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

1. Install Switch Console (Linux is "early access"): `sudo apt install ./switch-console-amd64.deb`,
   then complete the interactive logins (agent CLI, Mattermost or Gateway account). Record the
   exact Console and server versions.
2. Register `loopback-gate` as a custom agent using the installed version's documented
   registration endpoint (current docs: `POST /agents` with a registration API key; verify on the
   install). Store the returned key once in `SWITCH_AGENT_API_KEY`.
3. Create the room from `templates/loopback-room.yaml` (unverified; if the template cannot reference
   the gate, use `!invite-agent @loopback-gate`).
4. Collect participant ids with `@loopback-gate whoami` once the transport exists.

### Verify
- Sender attribution: post as a maintainer and from an agent you own; record `sender`,
  `sender_kind` and `on_behalf_of`. Set `SWITCH_HUMAN_SENDER_KIND` only after this is recorded.
- Ids are stable across a Switch restart and reconnect.
- A threaded reply lands in its thread (otherwise replies carry the case id).

The gate's Switch transport is **not implemented** until these facts are verified on the real
install (decision D23); `npm run gate` refuses to start until then.
