import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadGitHubConfig } from "../../apps/switch-gate/src/config.js";
import { GitHubClient } from "../../apps/switch-gate/src/github/client.js";
import { GitHubTransport } from "../../apps/switch-gate/src/github/transport.js";

// Live, READ-ONLY checks against the real demo repository with the gate's GitHub App.
// Skipped unless LOOPBACK_LIVE_GITHUB=1 and the GitHub configuration group is set.
// Optional: LOOPBACK_LIVE_PR=<number> to also read a real PR, its checks and files.
// Nothing here writes to GitHub (no statuses, no merges).

const live = process.env.LOOPBACK_LIVE_GITHUB === "1";

describe.skipIf(!live)("live GitHub (read-only)", () => {
  const cfg = live ? loadGitHubConfig(process.env) : undefined;
  const client = () => {
    const c = cfg!;
    const t = new GitHubTransport({ appId: c.appId, installationId: c.installationId, privateKeyPem: readFileSync(c.privateKeyPath, "utf8") });
    return new GitHubClient(t, c.repo, c.gateStatusContext);
  };

  it("the App can read the base branch rules, and the required protection is active", async () => {
    const rules = await client().getBranchRules(cfg!.baseBranch);
    expect(rules.requiredStatusContexts).toEqual(expect.arrayContaining([...cfg!.requiredChecks, cfg!.gateStatusContext]));
    expect(rules).toMatchObject({ requiresPullRequest: true, requiresUpToDate: true, blocksForcePush: true, restrictsDeletion: true });
  });

  it("the base branch head is readable (and equals the recorded demo commit during a demo run)", async () => {
    const head = await client().getBranchHead(cfg!.baseBranch);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    if (cfg!.demoResetSha !== null) expect(head).toBe(cfg!.demoResetSha);
  });

  it.skipIf(!process.env.LOOPBACK_LIVE_PR)("a real PR yields a consistent snapshot", async () => {
    const { snapshot, pull } = await client().snapshot(Number(process.env.LOOPBACK_LIVE_PR));
    expect(pull).toBeDefined();
    expect(snapshot.changedFilesHeadSha).toBe(pull!.headSha);
    expect(snapshot.checks).toBeDefined();
    expect(snapshot.baseProtection).toBeDefined();
  });
});
