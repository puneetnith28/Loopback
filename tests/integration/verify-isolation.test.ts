import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** POSIX-only: the container runtime (rootless Docker) and /proc checks are Linux-only. */
const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: the agent roles read /proc and the runtime is rootless Docker on Linux.

// D28 / step 6.4: scripts/verify-isolation.mjs must fail closed. Outside the agent containers,
// or without the Loopback rootless daemon, it must refuse (exit 2), never claim isolation and
// never print a token. The PASS paths run live via deploy/isolation/agents.sh verify
// (docs/evidence/phase-06-isolation.md); the pure checks are unit-tested.

const SCRIPT = join(process.cwd(), "scripts", "verify-isolation.mjs");
const TOKEN = "ghp_this_must_never_be_printed_0123456789";

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", GH_TOKEN: TOKEN, ...env },
  });

describe.skipIf(ON_WINDOWS)("verify-isolation.mjs fails closed", () => {
  it.each([[[]], [["everyone"]], [["constructor"]], [["toString"]]])("refuses bad usage %j", (args) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it("host role without DOCKER_HOST: exit 2, NOT PROVEN, no token printed", () => {
    const r = run(["host"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/CANNOT RUN {2}DOCKER_HOST is not set/);
    expect(r.stdout).toMatch(/verdict: NOT PROVEN/);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("host role against an unreachable daemon: exit 2", () => {
    const r = run(["host"], { DOCKER_HOST: "unix:///nonexistent/loopback-test.sock" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/CANNOT RUN {2}docker /);
  });

  it.skipIf(existsSync("/.dockerenv")).each(["fixer", "verifier"])(
    "%s role outside a container is refused even when the container environment is imitated",
    (role) => {
      const r = run([role], { LOOPBACK_AGENT_ROLE: role, HOME: `/home/${role}`, HTTPS_PROXY: "http://proxy:3128" });
      expect(r.status).toBe(2);
      expect(r.stdout).toMatch(/CANNOT RUN {2}not inside a container/);
      expect(r.stdout).toMatch(/verdict: NOT PROVEN/);
      expect(r.stdout).not.toMatch(/PASS/);
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    },
  );
});
