# Windows runtime — evidence (2026-11-04)

Windows 11, Node 22.15.1, Docker Desktop 29.8.1 with the WSL2 backend, Git for Windows. All keys were
throwaway ones generated for this run and destroyed afterwards, along with the containers, volumes
and networks. Nothing was written to GitHub or Switch; the only external calls were GitHub GETs (a
clone of the public demo repository and the signer's PR head reads).

This shows the runtime works on Windows. It does **not** complete steps 6.4, 7.10 or any other live
gate: no role token existed, no real agent session ran, and Switch was not involved.

## Tests

| Command | Environment | Result |
|---|---|---|
| `npm ci` | Windows, no C++ toolchain | succeeds (failed before `.npmrc`) |
| `npm run typecheck`, `npx eslint .` | Windows | clean |
| `npx vitest run` | Windows | 939 passed, 0 failed, 92 skipped (container-only suites and live suites) |
| `npm run test:linux` (typecheck, lint, tests) | `node:22.23.3-bookworm-slim`, unprivileged user | 1014 passed, 0 failed, 17 skipped (Windows-only tests and live suites) |

Real, not faked, on Windows: NTFS ACLs read and judged (`tests/unit/windows-acl.test.ts`: `icacls`
grants to Everyone are refused, and a file inheriting from an open folder is refused);
`CTRL_C_EVENT` and `CTRL_BREAK_EVENT` delivered into the built gate's console, exit 0
(`tests/integration/main-signal.test.ts`).

## Isolation: `npm run agents -- verify` on Docker Desktop

**352 PASS, 1 FAIL, 6 INFO.** The only FAIL is the one the Linux run has (`phase-06-signer.md`): the
verifier cannot show GitHub read access because its read-only token is an owner step.

Docker Desktop additions, all passing inside the fixer, verifier and signer: no route to the VM
gateway `192.168.65.1` or host address `192.168.65.254`; `host.docker.internal`,
`gateway.docker.internal` and `kubernetes.docker.internal` do not resolve. The host role reports
the rootful VM daemon as an INFO line (`docs/windows.md`, "What is weaker than on Linux").

An env file that still inherited another account's read access was refused by `agents.sh up`:

```text
signer.env: file must be accessible only to you (S-1-5-21-…-1004 has access); see docs/windows.md (icacls)
agents: …/signer.env is not private to you (docs/windows.md; run npm run build first)
```

## Regression test in the runner (no network, no credentials)

The demo repository was cloned by the verifier through its proxy, and the tests submitted with
`run-in-sandbox.mjs --tree . -- node --test test/index.test.js`:

| Commit | Exit |
|---|---|
| `70a5362` (demo-reset, seeded bug) | 1 |
| `e804775` (PR #2 head) | 0 |

## Signing (capabilities issued with a throwaway run-issuer key, for live PR #2)

| Request | Result |
|---|---|
| Valid report, live head `e804775` | signed; the gate's `verifyReportSignature` → `{"ok":true}` |
| Verdict altered after signing | `{"ok":false,"reason":"invalid"}` |
| Head altered after signing | `{"ok":false,"reason":"invalid"}` |
| Identical retry | same signature |
| Different report, same run | `REPLAYED` |
| Capability for an old head (read live from GitHub) | `STALE_HEAD` |
| Capability from a non-gate key | `CAPABILITY_INVALID` |
| `pass` with `regressionTestFailsBeforeFix:false` | `REPORT_INCONSISTENT` |
| `signer` looked up from the fixer | `EAI_AGAIN` (does not resolve) |
