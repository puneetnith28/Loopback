# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a
vulnerability"** button on this repository's **Security** tab (private security
advisory). Do not open a public issue for security problems. Expect an
acknowledgement within 72 hours.

Include the affected version or commit, reproduction steps, and the impact you
observed. Please do not access data that is not yours or degrade the service of
others while testing.

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest commit) | Yes |
| Anything older | No |

## Security model in brief

Loopback is a merge gate: an AI fixer may propose a change, but only the
gatekeeper can merge, and only when every piece of evidence (CI, independent
verification, maintainer approval) is bound to the exact current commit SHA and
re-checked against live GitHub state. Details are in
[`docs/threat-model.md`](docs/threat-model.md) once published.

## Known limits

- Single instance only: the per-case lock is in-process.
- Runs locally; the health endpoints bind to `127.0.0.1` and must not be exposed.
- Branch-protection properties that GitHub does not expose at runtime (for
  example the ruleset bypass list) are verified at setup, not before every merge.
- A repository administrator can still merge directly when all required checks
  are green; Loopback detects and alerts on such merges but cannot prevent them.
