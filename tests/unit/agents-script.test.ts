import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deploy/isolation/agents.sh", () => {
  it("gives the runner's /work tmpfs an explicit owner, so it stays writable after a restart", () => {
    // Without uid/gid, `docker start` recreates the tmpfs owned by root and every sandboxed test
    // fails with RUNNER_ERROR. Found live on 2026-11-05 after a machine restart.
    const script = readFileSync("deploy/isolation/agents.sh", "utf8");
    const mount = /--tmpfs (\/work:\S+)/.exec(script)?.[1] ?? "";
    expect(mount).toContain("uid=10004");
    expect(mount).toContain("gid=10004");
  });
});
