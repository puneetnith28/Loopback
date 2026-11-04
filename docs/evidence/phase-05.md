# Day-1 gate, live on a fresh Windows install (2026-11-05)

Windows 11, Switch Console 0.40.1, switch-core 0.31.0, Mattermost 11.9.0, Docker Desktop. The gate
ran with `MERGE_ENABLED`, `LOOPBACK_PRIVILEGED_ENABLED` and `VERIFIER_ISOLATION_PROVEN` all `false`.
Nothing was merged, and the fixer and verifier were never tasked. Observed from room history, the
gate's database and its logs. Ids below identify this local install and are not secrets.

| Identity | Id |
|---|---|
| Gate agent | `9cc0e709-21b8-4186-94b4-6ced4e1b6b17`, participant `@switch-agent-8fb7a9dd:localhost` |
| Fixer agent | `91cdcfaa-5b57-4e14-8077-72259a830fb2`, participant `@switch-agent-bab6c8f9:localhost` |
| Verifier agent | `a579a83c-c81b-49e5-b04c-93b3d55b2c2d`, participant `@switch-agent-350a15ef:localhost` |
| Maintainer | `@switch-mattermost-27d7dd80-86ae-4026-b7df-f254cecf4fae-user:localhost` |
| Rooms | maintainers `a4dcc0b3-1072-4299-818e-042404fab0a1`, intake `f94d3766-46b6-453c-ab97-d5116ad5dfd0` |

## Startup

- The gate's own `verifyAddressingPolicy` returned `{"ok":true}` on the two-rule policy (D26).
- `/healthz` 200 and `/readyz` `{"ok":true,"failing":[]}`; the gate showed as `live` in both rooms.
- `LOOPBACK_LIVE_GITHUB=1 LOOPBACK_LIVE_PR=2`, `tests/e2e/github-live.test.ts`: 3 passed.
- `LOOPBACK_LIVE_SWITCH=1`, `tests/e2e/switch-live.test.ts`: 1 passed. The maintainer confirmed in
  Mattermost that the threaded reply sits inside its thread.

## Commands from real accounts

| Sender | Room | Message | Result |
|---|---|---|---|
| Maintainer | maintainers | `help` | Commands listed, with `your role: maintainer` |
| Maintainer | maintainers | `whoami` | Exact participant id, `role: maintainer` |
| Maintainer | intake | `report …` | `received as LB-001`; triage notice posted in the maintainers' room; case stays `Reported`, nothing tasked |
| `outsider` | intake | `help` | Intake commands only: `help`, `report`, `status` |
| `outsider` | intake | `approve LB-001 000…` | `REFUSED: That request is not available to you here.` Audited `command.refused`, `WRONG_ROOM` |
| `outsider` | maintainers | `approve LB-001 000…` | Switch replied that this sender may not address the gate here. The gate audited `command.refused`, `NOT_ADDRESSED`, and did not answer |

After these: `LB-001` still `Reported`, version 0; 0 approvals, 0 verification runs, 0 merge
operations. The audit log holds the case creation and exactly the two refusals.

The refusal in the maintainers' room comes from Switch, not from the gate. So the docs' "refused
silently" describes the gate's behaviour only: the sender still sees a refusal.

## Restart

The gate process was killed outright and started again while `LB-001` was open. Before and after:
the same case, state and version, 1 audit row, 3 processed events, and no duplicate triage case. In
an earlier restart both rooms kept their connection ids (`a5ee8ed3`, `466990fc`), and their
generations advanced, as D23 requires. `/readyz` returned ok each time.

## Not shown here

- A restart of Switch itself, and whether ids stay stable across one (3.10, Q3).
- How a real agent report is attributed. Agent messages in history carry the exact agent `sender`,
  but no agent has yet sent the gate a report (3.10, Q3, 7.10).
- Privileged commands, which stay off. An `approve` from a maintainer has not been exercised live.
