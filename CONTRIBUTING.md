# Contributing to Loopback

## Supported environments

| Environment | What works | Use it for |
|---|---|---|
| **Linux** (Ubuntu) | Everything: full test suite, coverage, secret scan, running the gate | The reference environment for the release documents |
| **Native Windows** | Everything except the Linux-container test suites, which `npm run test:linux` runs through Docker; the gate; agent isolation under Docker Desktop | Day-to-day work on Windows: see [docs/windows.md](docs/windows.md) |
| **Windows + WSL2 (Ubuntu)** | Everything, as on Linux | Windows contributors who want the Linux reference environment |

### WSL2 setup (Windows)

1. `wsl --install -d Ubuntu`, then open the Ubuntu shell.
2. Clone **inside the WSL filesystem** (e.g. `~/src/Loopback`), not under `/mnt/c`: it is much
   faster and keeps Linux file permissions.
3. Install Node from `.nvmrc` (Node 22), e.g. with nvm: `nvm install && nvm use`.

### Line endings

`.gitattributes` stores and checks out LF everywhere, so `core.autocrlf` does not matter for this
repository. If an editor saves CRLF, `tests/unit/line-endings.test.ts` fails. Never commit a
"fix all line endings" change: there should be none to fix.

## Build and test

```bash
npm ci
npm run typecheck
npm run lint
npm test                 # unit, integration and security suites (live suites skip themselves)
npm run test:coverage    # what CI runs on Linux, with coverage thresholds
npm run test:linux       # from Windows: the complete Linux suite in a throwaway container
npm run release:check    # verifies version consistency across package manifests
npm run build
npm --prefix apps/console run build
```

CI runs two jobs: **check** (Linux, authoritative: coverage, builds, and a full-history gitleaks scan) and
**windows-portable** (typecheck, lint, build, and every test that can run natively). Both must be green
before merging.

## Code of Conduct

All contributors and maintainers are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Branches, pull requests and commits

- Nobody pushes directly to `main`. Everyone works on a branch named `<type>/<short-topic>` (e.g.
  `fix/poller-backoff`, `docs/setup-windows`) and opens a pull request into `main`; merge only with
  CI green and the maintainer's review.
- Fill out the pull request checklist in `.github/pull_request_template.md`.
- Never force-push to `main`, rewrite published history, or amend published commits.
- Commit messages follow Conventional Commits: `<type>: <description>`, with `feat`, `fix`,
  `refactor`, `docs`, `test`, `chore`, `perf` or `ci`. Describe the change, not the plan step.
- Every behaviour change needs a test; do not weaken or skip a test to make a build pass. A
  platform skip is only for code that genuinely cannot run on that platform, with the reason.

## Never commit

`.env` and any `.env.*` except `.env.example`; `secrets/` and any key (`*.pem`); databases
(`data/`, `*.db`); build output (`dist/`, `coverage/`, `node_modules/`); the local planning
documents (`plan.md`, `implementation.md`, `ANTIGRAVITY_HANDOFF.md`). All are git-ignored; check
`git status` before committing anyway.

## Live tests and anything outside your machine

The live suites run only when asked: `LOOPBACK_LIVE_GITHUB=1 npm test -- --project e2e`
(read-only GitHub checks) and `LOOPBACK_LIVE_SWITCH=1 npm test -- --project e2e` (posts two
labelled messages into the maintainers' room). Both need the maintainer's credentials and their
agreement. Do not change Switch configuration, GitHub rulesets, credentials, agent registrations
or the safety flags (`MERGE_ENABLED`, `LOOPBACK_PRIVILEGED_ENABLED`, `VERIFIER_ISOLATION_PROVEN`,
all `false`) without explicit authorisation. See [docs/setup.md](docs/setup.md).
