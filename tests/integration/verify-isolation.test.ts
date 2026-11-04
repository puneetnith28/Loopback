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
    expect(r.stdout).toMatch(/no-signer is missing, not root-owned, or writable by others \(its files could be swapped\)/);
    expect(r.stdout).toMatch(/verdict: NOT PROVEN/);
    expect(r.stdout).not.toMatch(/isolation (is )?proven(?! by this alone)/i);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});

/**
 * The PASS path of the in-sandbox roles, which needs the separate-users runtime to run for real.
 * Stub `id`, `stat` and `ls` come first on PATH to present an agent user inside its unit; the
 * script itself is unchanged. Each check is then broken in turn to show it cannot pass falsely.
 */
describe("verify-isolation.sh inside a simulated agent unit", () => {
  const uid = "1000";
  const setupUnit = (opts: { homeVisible?: boolean; otherAgent?: boolean; signerOwner?: string; keyMode?: string; signerDirMode?: string } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "loopback-unit-"));
    const agents = join(root, "agents");
    const home = join(agents, uid, "agent", "home");
    const signer = join(root, "signer");
    const bin = join(root, "bin");
    mkdirSync(join(home, ".config", "loopback-verifier"), { recursive: true });
    if (opts.otherAgent) mkdirSync(join(agents, uid, "02"), { recursive: true });
    mkdirSync(signer, { recursive: true });
    writeFileSync(join(signer, "sign-verifier-report.mjs"), "");
    writeFileSync(join(signer, "signature.js"), "");
    writeFileSync(join(home, ".config", "loopback-verifier", "signing-key.pem"), "not a key");
    mkdirSync(bin);
    const me = "sa1000-01";
    writeFileSync(join(bin, "id"), `#!/bin/sh\ncase "$1" in -un) echo ${me};; -u) echo 61001;; -Gn) echo switch-agents-1000;; *) echo ${me};; esac\n`, { mode: 0o755 });
    // stat: owner names under the unit belong to the agent user; the signer is root's unless told otherwise.
    writeFileSync(join(bin, "stat"), `#!/bin/sh
fmt="$2"; path="$4"
case "$fmt" in
  %U) case "$path" in ${agents}*) echo ${me};; *) echo root;; esac;;
  %u) case "$path" in ${signer}*) echo ${opts.signerOwner ?? "0"};; *) echo 61001;; esac;;
  %a) case "$path" in *signing-key.pem) echo ${opts.keyMode ?? "600"};; ${signer}) echo ${opts.signerDirMode ?? "755"};; *) echo 644;; esac;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, "ls"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = /home ] && { ${opts.homeVisible ? "echo someone; exit 0" : "exit 2"}; }; done\nexec /bin/ls "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho o/r\n", { mode: 0o755 });
    const r = spawnSync("bash", [SCRIPT, "verifier"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, SWITCH_HOST_SHARED_GROUP: "1", GH_TOKEN: TOKEN, GH_REPO: "o/r",
        LOOPBACK_AGENTS_PARENT: agents, LOOPBACK_SIGNER_DIR: signer, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    rmSync(root, { recursive: true, force: true });
    return r;
  };

  it("passes only when every verifier check holds, and never prints a token or claims isolation", () => {
    const r = setupUnit();
    expect(r.stdout).not.toMatch(/FAIL/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/isolation is not proven by this alone/);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it.each([
    ["/home is visible", { homeVisible: true }, /\/home is visible/],
    ["another agent's directory is visible", { otherAgent: true }, /other agents' directories are visible/],
    ["the signer is not root-owned", { signerOwner: "61001" }, /not root-owned/],
    ["the signer directory is writable by others", { signerDirMode: "775" }, /its files could be swapped/],
    ["the signing key is not mode 600", { keyMode: "644" }, /no signing key owned by/],
  ])("fails when %s", (_n, opts, why) => {
    const r = setupUnit(opts);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(why);
    expect(r.stdout).toMatch(/verdict: NOT PROVEN/);
  });
});
