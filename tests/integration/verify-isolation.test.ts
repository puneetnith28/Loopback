import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// D28: scripts/verify-isolation.sh must fail closed. It can only produce real evidence on an
// installed separate-users runtime (fixer/verifier inside their units); here it must refuse
// or fail, never claim isolation, and never print a token.

const SCRIPT = join(process.cwd(), "scripts", "verify-isolation.sh");
const TOKEN = "ghp_this_must_never_be_printed_0123456789";
let dir = "";

const run = (role: string, env: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT, role], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", GH_TOKEN: TOKEN, ...env },
  });

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "loopback-iso-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("verify-isolation.sh fails closed", () => {
  it.each(["gate", "fixer", "verifier"])("cannot be executed for %s without the runtime: exit 2, NOT PROVEN, no token printed", (role) => {
    const r = run(role, { LOOPBACK_SU_CONFIG_DIR: join(dir, "no-such-config") });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(role === "gate" ? /CANNOT RUN {2}the separate-users runtime is not installed/ : /CANNOT RUN {2}user .* is not a separate-users agent user/);
    expect(r.stdout).toMatch(/verdict: NOT PROVEN/);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("refuses bad usage", () => {
    expect(run("everyone").status).toBe(2);
  });

  it("an agent role is refused outside the unit even when the unit's environment is imitated", () => {
    const r = run("verifier", { SWITCH_HOST_SHARED_GROUP: "1", HOME: join(dir, "agent", "home"), LOOPBACK_CONTROLLER_UID: "1000" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/not a separate-users agent user/);
  });

  it("an 'installed' layout that is not really separated fails for the gate role, without claiming isolation", () => {
    const uid = String(userInfo().uid);
    const config = join(dir, "etc");
    const agents = join(dir, "agents");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, `separate-users-${uid}.json`), "{}");
    mkdirSync(join(agents, uid, "01"), { recursive: true, mode: 0o755 }); // owned by us, not sa<uid>-01, world-readable
    const r = run("gate", {
      LOOPBACK_SU_CONFIG_DIR: config, LOOPBACK_AGENTS_PARENT: agents, LOOPBACK_CONTROLLER_UID: uid,
      LOOPBACK_SIGNER_DIR: join(dir, "no-signer"), LOOPBACK_GATE_KEY: join(dir, "no-key.pem"),
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`slot 01 directory is owned by .*, not sa${uid}-01`));
    expect(r.stdout).toMatch(/gives others access/);
    expect(r.stdout).toMatch(/not root-owned/);
    expect(r.stdout).toMatch(/verdict: NOT PROVEN/);
    expect(r.stdout).not.toMatch(/isolation (is )?proven(?! by this alone)/i);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});
