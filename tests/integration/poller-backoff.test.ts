import { describe, expect, it } from "vitest";
import { GitHubError, RateLimited } from "../../apps/switch-gate/src/github/client.js";
import { OUTAGE_BACKOFF_BASE_MS, OUTAGE_BACKOFF_MAX_MS, RATE_LIMIT_PAUSE_MAX_MS } from "../../apps/switch-gate/src/workflow/poller.js";
import { A, G, REP, createHarness, type Harness } from "../helpers/harness.js";

// Step 9.6: the poller backs off during GitHub rate limits and outages instead of
// hammering the API, and resumes on its own. Nothing is decided from cached state meanwhile.

async function verifying(): Promise<Harness> {
  const h = createHarness();
  await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
  h.gh.setPull(42);
  h.gh.pass(A);
  await h.poller.tick(); // FixInProgress -> Verifying
  return h;
}

function countReads(h: Harness): () => number {
  let reads = 0;
  const original = h.gh.getPull.bind(h.gh);
  h.gh.getPull = (n: number) => { reads += 1; return original(n); };
  return () => reads;
}
const later = (h: Harness, ms: number) => { h.clock.now = new Date(h.clock.now.getTime() + ms); };

describe("poller back-off (step 9.6)", () => {
  it("a rate limit pauses polling until GitHub's reset, then resumes", async () => {
    const h = await verifying();
    const reads = countReads(h);
    h.gh.rateLimited = true; // the fake reports retry-after 60 s
    await h.poller.tick();
    const pausedUntil = h.poller.backoffUntil;
    expect(pausedUntil).toBe(h.clock.now.getTime() + 60_000);

    h.gh.rateLimited = false;
    const before = reads();
    later(h, 59_000);
    await h.poller.tick();
    expect(reads()).toBe(before); // still paused: no GitHub call
    later(h, 1_000);
    await h.poller.tick();
    expect(reads()).toBeGreaterThan(before);
    expect(h.state()).toBe("Verifying");
  });

  it("an outage for every case backs off exponentially up to the cap, and success resets it", async () => {
    const h = await verifying();
    const reads = countReads(h);
    h.gh.failGetPull = true;
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const before = reads();
      await h.poller.tick();
      expect(reads(), `attempt ${i}`).toBe(before + 1); // each pass that runs makes exactly one read
      delays.push(h.poller.backoffUntil - h.clock.now.getTime());
      later(h, delays.at(-1)! - 1);
      const skipped = reads();
      await h.poller.tick();
      expect(reads(), `still backing off after attempt ${i}`).toBe(skipped);
      later(h, 1);
    }
    expect(delays.slice(0, 4)).toEqual([OUTAGE_BACKOFF_BASE_MS, OUTAGE_BACKOFF_BASE_MS * 2, OUTAGE_BACKOFF_BASE_MS * 4, OUTAGE_BACKOFF_BASE_MS * 8]);
    expect(Math.max(...delays)).toBe(OUTAGE_BACKOFF_MAX_MS);
    expect(h.state()).toBe("Verifying"); // nothing decided on missing data

    h.gh.failGetPull = false;
    await h.poller.tick();
    expect(h.poller.backoffUntil).toBeLessThanOrEqual(h.clock.now.getTime());
    h.gh.failGetPull = true;
    await h.poller.tick();
    expect(h.poller.backoffUntil - h.clock.now.getTime()).toBe(OUTAGE_BACKOFF_BASE_MS); // the streak restarted
  });

  it("does not back off when only some cases fail", async () => {
    const h = await verifying();
    await h.say(REP, `${G} report a second bug in slugify options`); // LB-002, FixInProgress (no PR yet)
    h.gh.failGetPull = true; // LB-001 fails; LB-002's PR discovery still works
    await h.poller.tick();
    expect(h.poller.backoffUntil).toBe(0);
  });

  it("permanent per-case errors (e.g. 404) are not an outage and never back off", async () => {
    const h = await verifying();
    h.gh.getPull = () => Promise.reject(new GitHubError("not found", 404));
    await h.poller.tick();
    await h.poller.tick();
    expect(h.poller.backoffUntil).toBe(0);
  });

  it("caps a rate-limit pause at one hour, whatever GitHub says", async () => {
    const h = await verifying();
    h.gh.getPull = () => Promise.reject(new RateLimited("rate limited", 429, 999_999));
    await h.poller.tick();
    expect(h.poller.backoffUntil - h.clock.now.getTime()).toBe(RATE_LIMIT_PAUSE_MAX_MS);
  });
});
