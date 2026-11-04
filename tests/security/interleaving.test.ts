/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import { describe, expect, it } from "vitest";
import { HeadChanged } from "../../apps/switch-gate/src/github/transport.js";
import { getCase, listApprovals, listRuns } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, B, G, MAINT, MAINT2, createHarness } from "../helpers/harness.js";

// Step 8.3: a head change racing an approval and a merge, 100 seeded interleavings.
// In each run the PR head moves from A to B after a random number of GitHub reads,
// while an approval for A, a poller pass and a merge command run concurrently in a
// random order with random yields between them. Whatever the interleaving:
//  - every merge call is bound to a head with a recorded maintainer approval and a passing
//    verification run; if the head moved after the gate's last read (an unavoidable
//    window), the call's SHA precondition makes GitHub refuse it (409), modelled here;
//  - a merge only ever lands on the approved head;
//  - no approval is ever recorded for B (nobody approved B);
//  - a case left ReadyToMerge or Merged is bound to the approved head.

const RUNS = 100;

/** Small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function yields(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function run(seed: number) {
  const rnd = prng(seed);
  const h = createHarness({ mergeEnabled: true, privilegedEnabled: true });
  await h.driveToAwaitingApproval();
  expect(h.state()).toBe("AwaitingApproval");

  const violations: string[] = [];
  let landed: string | null = null;
  let refused = 0;
  h.merger.mockImplementation(async (n, sha) => {
    const approved = listApprovals(h.db, "LB-001").some((a) => a.headSha === sha && a.decision === "approve");
    const verified = listRuns(h.db, "LB-001").some((r) => r.headSha === sha && r.status === "pass");
    if (!approved || !verified) violations.push(`merge call for ${sha.slice(0, 7)} without approval+verification`);
    // GitHub's `sha` precondition (github/merge.ts): a moved head is refused, never merged.
    if (h.gh.pulls.get(n)?.headSha !== sha) {
      refused += 1;
      throw new HeadChanged("head changed: GitHub refused the sha precondition", 409);
    }
    landed = sha;
    h.gh.setPull(n, { merged: true, state: "closed", mergeCommitSha: "d".repeat(40) });
    return { merged: true, sha: "d".repeat(40) };
  });

  // The head moves after a random number of GitHub reads (0 = before anything runs).
  const moveAfter = Math.floor(rnd() * 8);
  let reads = 0;
  const move = () => { h.gh.setPull(42, { headSha: B }); h.gh.pass(B); };
  if (moveAfter === 0) move();
  h.gh.onGetPull = () => { reads += 1; if (reads === moveAfter) move(); };

  const actors: (() => Promise<void>)[] = [
    () => h.say(MAINT, `${G} approve LB-001 ${A}`),
    () => h.poller.tick(),
    () => h.say(MAINT2, `${G} merge LB-001`),
  ];
  await Promise.all(shuffle(actors, rnd).map(async (act) => { await yields(Math.floor(rnd() * 6)); await act(); }));
  // Let the gate settle: another poll, and a second merge command after it.
  await h.poller.tick();
  await h.say(MAINT, `${G} merge LB-001`);
  await h.poller.tick();

  const c = getCase(h.db, "LB-001")!;
  if (listApprovals(h.db, "LB-001").some((a) => a.headSha === B)) violations.push("an approval was recorded for B");
  if (landed !== null && landed !== A) violations.push(`merged ${String(landed).slice(0, 7)}, not the approved head`);
  if (c.state === "Merged" && landed !== A) violations.push("Merged without the approved head landing");
  if (c.state === "ReadyToMerge" && c.headSha !== A) violations.push(`ReadyToMerge bound to ${String(c.headSha).slice(0, 7)}`);
  if (refused > 0 && c.state === "Merged") violations.push("Merged after GitHub refused the only merge call");
  return { violations, state: c.state, merged: landed === null ? 0 : 1, refused, moveAfter };
}

describe(`head change vs approval and merge: ${RUNS} interleavings (step 8.3)`, () => {
  it("never merges or approves a head that was not approved and verified", async () => {
    const outcomes = new Map<string, number>();
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const r = await run(seed);
      expect(r.violations, `seed ${seed} (head moved after read ${r.moveAfter})`).toEqual([]);
      expect(r.merged, `seed ${seed}`).toBeLessThanOrEqual(1);
      const key = `${r.state}/merged=${r.merged}/refused=${r.refused}`;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
    // The schedule must explore both sides of the race, not one lucky order.
    const kinds = [...outcomes.keys()];
    expect(kinds.some((k) => k.includes("merged=1")), JSON.stringify([...outcomes])).toBe(true);
    expect(kinds.some((k) => k.includes("merged=0")), JSON.stringify([...outcomes])).toBe(true);
    expect(kinds.some((k) => k.includes("refused=1")), JSON.stringify([...outcomes])).toBe(true);
  });
});
