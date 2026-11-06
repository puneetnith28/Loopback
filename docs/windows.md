# Running Loopback on Windows

Loopback runs natively on Windows 10/11: the gate as a normal Node process, and the fixer,
verifier, signer and runner as the same Linux containers as on Linux, under Docker Desktop. Linux
stays the deployment target of the release documents; this page covers what changes on Windows.

## Prerequisites

| Tool | Needed for | Install |
|---|---|---|
| Node `>=22.13.0 <23` | The gate, tests, tooling | `winget install OpenJS.NodeJS.22` (the `LTS` package is a newer major, outside the range) |
| Git for Windows | Git Bash, which runs the repository's scripts | `winget install Git.Git` |
| Docker Desktop (Linux containers) | Agent isolation; `npm run test:linux` | `winget install Docker.DockerDesktop` |
| GitHub CLI and jq | `reset-demo.sh`, `verify-github-setup.sh` and other maintainer scripts | `winget install GitHub.cli jqlang.jq` |

No C++ toolchain is needed: `.npmrc` turns off install scripts and `better-sqlite3` ships a Windows
prebuilt binary. Check everything at once with `npm run readiness`.

The ACL checks find PowerShell and the system folders from variables Windows sets itself:
`SystemDrive` (or `SYSTEMDRIVE`), `windir` (or `WINDIR`) and `PSModulePath`. Nothing needs setting.

## Keep secrets and the database out of OneDrive

If the repository is under OneDrive (a Desktop folder often is), do **not** use the defaults
`./secrets` and `./data`: a key there is copied to the cloud, and a sync client can corrupt a live
SQLite database. The gate refuses both, using the `OneDrive*` environment variables. Put them in
your profile instead, and use absolute paths in `.env`:

```powershell
$dir = "$HOME\.loopback"
New-Item -ItemType Directory -Force "$dir\secrets", "$dir\data" | Out-Null
```

```dotenv
GH_APP_PRIVATE_KEY_PATH=C:\Users\you\.loopback\secrets\gate.pem
LOOPBACK_RUN_ISSUER_KEY_PATH=C:\Users\you\.loopback\secrets\run-issuer.pem
DB_PATH=C:\Users\you\.loopback\data\loopback.db
```

Other sync clients (Dropbox, Google Drive) are not detected; keep these paths out of them too.

## Key files: the Windows form of `chmod 600`

Mode bits mean nothing on NTFS, so the gate reads each key's access control list when it starts and
refuses to start unless only you, SYSTEM and Administrators can reach the file (those two can read
any file anyway), and nobody else can write to its folder. A failure to read the list is a refusal.

Lock a file, removing whatever it inherited:

```powershell
icacls "$HOME\.loopback\secrets\gate.pem" /inheritance:r /grant:r "${env:USERNAME}:F"
```

Files inherit from their folder, and `%LOCALAPPDATA%` and `%TEMP%` can carry entries for other
accounts, including leftovers from deleted ones. The gate names the SID it objects to. The same
rule applies to the agent credential files in `~\.config\loopback-agents\*.env`. Save those without
a byte-order mark (PowerShell 5 `Out-File -Encoding utf8` adds one, and `docker --env-file` then
misreads the first line); `[System.IO.File]::WriteAllText()` is safe.

## Running

```powershell
npm ci
npm run build
npm run migrate    # reads .env
npm run gate       # reads .env; serves /healthz and /readyz on 127.0.0.1
```

**Stopping.** Press Ctrl+C or Ctrl+Break in the gate's console, or close the window: all three
shut down cleanly and exit 0. Windows has no SIGTERM, so `Stop-Process` and `taskkill /F` kill the
process outright. That is safe for the data (SQLite's WAL, and a merge left unfinished becomes
`MergeUnknown` and is reconciled against GitHub at the next start), but it skips the clean
shutdown. Exit codes are the same as on Linux.

**Backups.** `npm run backup` takes a verified online backup. Schedule it with Task Scheduler
instead of the systemd timer.

**Logs.** To keep the gate's log, run `npm run gate *>> "$HOME\.loopback\gate.log"`. Each delivered
message is logged as `switch.inbound`, with no body or sender. If a command gets no reply and has no
such line, Switch never delivered it to the gate.

**After a restart.** Start Docker Desktop first, then Switch Console (it skips Mattermost if Docker
isn't running), then `npm run agents -- up`, then the gate.

**Flags through npm.** Windows PowerShell drops the `--` in `npm run <script> -- --flag`, so npm takes
the flag for itself and the script never sees it. Call the script with `node` instead:
`node scripts/ruleset-proof.mjs --apply`.

### Fewer permission prompts for the verifier

An agent waiting on a prompt looks idle in chat while its run counts down, so the gate posts one
reminder after 5 minutes. To avoid most prompts, copy `templates/opencode-verifier.jsonc` to
`opencode.jsonc` in the verifier's clone and set the path in it. Signing and anything unlisted still
ask. Never add raw `git diff` to it: `--output` can write a Git hook, which is why the template uses the
tool's `diff` command. Two limits apply:

- This has not been tested with Console's own permission settings yet, so check that it takes effect.
- OpenCode reads this file from the working folder, so PR code must never be checked out there. A PR
  could otherwise bring its own permissions. `prompts/verifier.md` forbids checking anything out.

## Agent isolation on Docker Desktop

Run the scripts through npm, which finds Git Bash. On Windows `bash` on PATH is usually the WSL
launcher, which is a different environment:

```powershell
npm run agents -- build
npm run agents -- signer-init
npm run agents -- up
npm run agents -- signer-token
npm run agents -- recycle-verifier   # before each verification run
npm run agents -- verify
```

Other scripts run the same way: `node scripts/sh.mjs scripts/reset-demo.sh`.
`deploy/isolation/rootless-docker.sh` is not used; every other flag, network and check is the same
as on Linux (`deploy/isolation/README.md`). Do not set `DOCKER_HOST`.

### What is weaker than on Linux

| | Linux (rootless Docker) | Windows (Docker Desktop) |
|---|---|---|
| Daemon | Your own user, in a user namespace | Root inside Docker Desktop's VM |
| A container escape reaches | Your user's sub-uids, and no more | That VM as root, and any Windows folder shared with it |
| Containers | Same image, uids, networks and hardening | Same |

Every flag and network is checked the same way, but a kernel-level container escape is more serious
here. `verify` reports this as an `INFO` line instead of passing it off as equal. Reduce the exposure
under Docker Desktop's *Settings > Resources > File sharing* by sharing as little as you can, and
keep the gate key outside anything shared. Whether to set `VERIFIER_ISOLATION_PROVEN=true` on this
runtime is the owner's decision, with this difference in view.

## Tests

| Command | Runs | Skips |
|---|---|---|
| `npm test` | Everything that can run natively, including real NTFS ACL checks and real Ctrl+C / Ctrl+Break delivery | Signer, sandbox runner and isolation role tests, which only run in Linux containers |
| `npm run test:linux` | The complete Linux suite in a throwaway container, from your tracked files including uncommitted edits | Only the live suites |

Run both before opening a pull request that touches platform code. Stage new files first:
`test:linux` does not see untracked ones.

## Switch

Switch itself is outside this repository. The live flow has run on Windows 11 with Switch Console
0.40.1, switch-core 0.31.0, Mattermost 11.9.0 under Docker Desktop, and agents on OpenCode 1.18 (the
Antigravity ACP provider has no Windows build). Console runs in its native mode, so it has no Gateway
web page: the Gateway API is at `/gateway/*` on the API port, and its ports can differ per install. If
you run Switch on another host, the gate only needs its agent bridge reachable as `SWITCH_BRIDGE_URL`.
The bridge binds to 127.0.0.1 on its own host, so reach it over an SSH tunnel rather than by opening the
port.
