# The documentation

The pages group by what you came to do: understand it, set it up, run it, or check the evidence. The [README](../README.md) is the argument and owns the results; nothing here repeats it.

**Start here instead:** judging or evaluating it, read [`TESTING.md`](../TESTING.md). Changing the code, read [`CONTRIBUTING.md`](../CONTRIBUTING.md). Reporting a vulnerability, read [`SECURITY.md`](../SECURITY.md).

## Understanding it

| # | Page | Answers |
|---|---|---|
| 1 | [`architecture.md`](architecture.md) | What are the modules, why two rooms, where does the verifier's signing key live, and what states can a case be in? |
| 2 | [`threat-model.md`](threat-model.md) | What can an outsider, a hostile bug report or a misbehaving agent do, and what stops each of them? |
| 3 | [`console-api.md`](console-api.md) | What does the read-only console API serve, and how does it stay read-only? |

## Setting it up and running it

| # | Page | Answers |
|---|---|---|
| 4 | [`setup.md`](setup.md) | How do I set up GitHub and Switch for a live gate, and how do I prove each step worked? |
| 5 | [`windows.md`](windows.md) | What changes on Windows, and what is weaker there? |
| 6 | [`operations.md`](operations.md) | How do I start, stop, back up and inspect the gate, and what does each setting do? |
| 7 | [`owner-actions.md`](owner-actions.md) | Which steps need the owner's own accounts and credentials? |
| 8 | [`demo-runbook.md`](demo-runbook.md) | How is the demo video recorded, scene by scene? |
| 9 | [`../deploy/isolation/README.md`](../deploy/isolation/README.md) | How are the agents, the signer and the runner isolated in containers? |
| 10 | [`../apps/console/README.md`](../apps/console/README.md) | How do I run and work on the evidence console? |
| 10a | [`../apps/console/docs/api-contract-v1.md`](../apps/console/docs/api-contract-v1.md) | Which responses does the console expect from its API? |
| 10b | [`../apps/console/docs/backend-api-requirements.md`](../apps/console/docs/backend-api-requirements.md) | What did the console ask of the backend, and why? |

## Release status

| # | Page | Answers |
|---|---|---|
| 11 | [`release-readiness.md`](release-readiness.md) | Which release checks pass, item by item, and with what evidence? |

## Evidence from live runs

Each page records what was run, on what, and what came back.

| # | Page | Answers |
|---|---|---|
| 12 | [`evidence/phase-05.md`](evidence/phase-05.md) | Did the gate run live on a fresh Windows install with Switch? |
| 13 | [`evidence/phase-06-m1.md`](evidence/phase-06-m1.md) | What did the read-only GitHub checks of the demo repository find? |
| 14 | [`evidence/phase-06-ruleset-proof.md`](evidence/phase-06-ruleset-proof.md) | Does GitHub refuse a merge that lacks the gate's status? |
| 15 | [`evidence/phase-06-isolation.md`](evidence/phase-06-isolation.md) | Do the agent containers keep their credentials and network apart? |
| 16 | [`evidence/phase-06-signer.md`](evidence/phase-06-signer.md) | Does the verifier's signer refuse what it should? |
| 17 | [`evidence/phase-06-windows.md`](evidence/phase-06-windows.md) | Does the Windows runtime work, with Docker Desktop for the containers? |
| 18 | [`evidence/phase-08-day2.md`](evidence/phase-08-day2.md) | Did a real bug go from a chat report to a merge by the gate? |
| 19 | [`evidence/phase-11-console.md`](evidence/phase-11-console.md) | Does the console show the real case correctly? |

## The agents' briefs

| # | Page | Answers |
|---|---|---|
| 20 | [`../prompts/fixer.md`](../prompts/fixer.md) | What exactly is the fixer told to do, and not do? |
| 21 | [`../prompts/verifier.md`](../prompts/verifier.md) | What exactly is the verifier told to check, and how must it report? |

The Switch template in `templates/loopback.template.yaml` is generated from these two files by `npm run switch-template`.
