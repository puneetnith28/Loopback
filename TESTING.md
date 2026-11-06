# Evaluating Loopback

Written for a judge or reviewer who wants to see whether this works without doing the live setup. Start at the top and stop when you are convinced.

## For a submission form

> Loopback is a merge gate for AI-written fixes that runs as a custom agent inside Switch rooms. A contributor reports a bug in chat, a fixer agent opens a pull request, a verifier agent signs a report for that exact commit, and a maintainer approves one full commit id. Before merging, the gate re-reads GitHub: if a commit landed after the approval, it refuses with `HEAD_MOVED`, throws the evidence away and verifies again. Only the gate can merge, and GitHub's rulesets enforce it. Without Switch there are no rooms, no agents and no proof of who said what, so the gate refuses to start. Try it in the browser with no install, or run `npm ci && npm run build && npm run demo`, which checks its own 16 outcomes.

## Levels, from least effort to most

| Level | What you need | Time | What it shows |
|---|---|---|---|
| 1. The web page | A browser | about 5 minutes for the 21 steps | The whole flow, typed by you, with the gate's recorded answers and the real evidence console |
| 2. The rehearsal | Node and Git, at the [versions in the README](README.md#run-it) | about 1.5 minutes, install included | The same flow, run by the gate's real code on your machine, checking 16 outcomes |
| 3. The console | Level 2, then two terminals | under 10 seconds to start, once level 2 is done | The real console API and React app over the rehearsal's case |
| 4. The live setup | GitHub, Switch Console with Docker, a coding agent | a few hours the first time | Everything on real services. [`docs/setup.md`](docs/setup.md) |

The times for level 2 were measured from a clean clone on Windows 11 with Node 22.15.1: `npm ci` 50 s, `npm run build` 6 s, `npm run demo` 24 s.

## Level 1: the web page

Open [the demo page](https://claude.ai/artifact/JWwtrnBgQ6UjhvpymQp5Nf). Nothing is installed. The chat messages, refusals and console screens were recorded from a run of the gate's real code; Switch's delivery, GitHub and the agents are simulated, and a label on every screen says so.

**If you only have a few minutes, this is the part to watch:**

1. On the title page, press the Switch button inside the loop. The agents go dark, the room empties, and the gate's real refusal to start appears.
2. Press it again, then **Run the demo**. Step 1 asks you to send a report as Prashant in the public room. **Fill it in for me**, then send.
3. Step 2: try to approve from the public room. It is refused, because nothing privileged exists there.
4. Press **Late commit**. A new commit lands after Puneet approved, and he says merge. Send it.
5. Read the gate's reply: `BLOCKED (HEAD_MOVED)`. Then **See the evidence reset** opens the real evidence console, now back at Verifying for the new commit.
6. Press **Play the rest** to watch it earn the evidence again and merge.
7. Turn Switch off in the top bar at any step. Messages are not delivered, and no step can run.

## Level 2: the rehearsal

```bash
git clone https://github.com/puneetnith28/Loopback.git
cd Loopback
npm ci
npm run build
npm run demo
```

What to look at: each scene prints what it expects, then a ✓ or a ✗. Scene 11 is the late commit. The last line must be:

```text
16 of 16 expected outcomes observed. Rehearsal passed.
```

If any outcome does not happen, the run says `REHEARSAL FAILED.` and exits with code 1.

## Level 3: the console

```bash
npm run demo:console                    # terminal 1: the rehearsal, then the console API on port 8788
npm run dev --workspace apps/console    # terminal 2
```

Open `http://localhost:5173` and choose `LB-001`. Its repository reads `simulated/rehearsal-not-a-live-run`, so it cannot be taken for a live run. The System page shows the rehearsal's settings, as the gate recorded them.

## Verifying it

The results, and what is not verified yet, are in the README: [What is verified, and what is not](README.md#what-is-verified-and-what-is-not). The live evidence is in [`docs/evidence/`](docs/README.md#evidence-from-live-runs).

## Known limits, before you find them

- On the live run a person guided the verifier, and verification is labelled advisory because the agents ran outside their isolated containers.
- The late commit, `why`, `board`, `team` and the room documents have been run against stand-ins for Switch, not live.
- Only Mattermost has been tried.

## When something goes wrong

| What you see | Cause | Fix |
|---|---|---|
| `Nothing is built yet. Run: npm ci && npm run build` | `npm run demo` ran before a build | Run the two commands |
| `Refusing to start: the gate's Switch addressing policy is not the expected one (...)` | The gate could not read its Switch policy, or the policy is not the restrictive one | [`docs/setup.md`](docs/setup.md), section 2, step 4 |
| `database is in a cloud-synced folder (OneDrive); move it (docs/windows.md)` | `DB_PATH` points into OneDrive | Move the database, as [`docs/windows.md`](docs/windows.md) shows |
| The console says the configuration is unavailable | The gate has never started with this database, so it has not recorded its settings | Start the gate once. The API answers `The gate has not recorded its settings yet. Start the gate once with this database.` |
