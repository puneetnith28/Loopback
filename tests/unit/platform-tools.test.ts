import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessReadiness, isDesktopDaemon, type ReadinessFacts } from "../../scripts/live-readiness.mjs";
import { bashCandidates, findBash, isMainModule } from "../../scripts/sh.mjs";
import { diffPlan, roleToken, testPlan } from "../../scripts/host-agent-tool.mjs";
import { assessDesktopDaemon, githubGetOptions } from "../../scripts/verify-isolation.mjs";
import { gracefulSignals } from "../../apps/switch-gate/src/run.js";

// The cross-platform tooling: finding Git Bash (never the WSL launcher), the Node backup, and the
// Windows forms of the readiness and isolation reports.

const WIN_ENV = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };

describe("findBash", () => {
  it("prefers LOOPBACK_BASH, then Git's own install, then the usual locations", () => {
    const list = bashCandidates({ ...WIN_ENV, LOOPBACK_BASH: "D:\\tools\\bash.exe" }, "D:/Git/mingw64/libexec/git-core");
    expect(list.slice(0, 3)).toEqual(["D:\\tools\\bash.exe", "D:\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]);
  });
  it("never offers the WSL launcher, even when configured", () => {
    expect(bashCandidates({ LOOPBACK_BASH: "C:\\Windows\\System32\\bash.exe" })).toEqual([]);
  });
  it("reports null when Git Bash is missing, and plain bash elsewhere", () => {
    expect(findBash("win32", WIN_ENV, () => false, () => "")).toBeNull();
    expect(findBash("win32", WIN_ENV, (p) => p.startsWith("C:\\Program Files\\Git"), () => "")).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(findBash("linux", {}, () => false, () => "")).toBe("bash");
  });
});

describe("isMainModule", () => {
  it("tolerates Windows drive-letter case and compares exactly elsewhere", () => {
    const script = join(process.cwd(), "scripts", "x.mjs");
    const url = pathToFileURL(script).href;
    expect(isMainModule(url, script)).toBe(true);
    expect(isMainModule(url, undefined)).toBe(false);
    expect(isMainModule(url, join(process.cwd(), "scripts", "y.mjs"))).toBe(false);
    if (process.platform === "win32") expect(isMainModule(url, script.toLowerCase())).toBe(true);
  });
});

describe("gracefulSignals", () => {
  it("adds the signals Windows really delivers, and only there", () => {
    expect(gracefulSignals("linux")).toEqual(["SIGTERM", "SIGINT"]);
    expect(gracefulSignals("win32")).toEqual(["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"]);
  });
});

describe("backup-db.mjs", () => {
  let dir = "";
  const script = join(process.cwd(), "scripts", "backup-db.mjs");
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...env } });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopback-backup-"));
    const db = new Database(join(dir, "loopback.db"));
    db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (42);");
    db.close();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes a verified copy", () => {
    const r = run({ DB_PATH: join(dir, "loopback.db"), BACKUP_DIR: join(dir, "b"), KEEP: "3" });
    expect(r.status, r.stderr).toBe(0);
    const [name] = readdirSync(join(dir, "b"));
    const copy = new Database(join(dir, "b", name ?? ""), { readonly: true });
    expect(copy.prepare("SELECT x FROM t").get()).toEqual({ x: 42 });
    copy.close();
  });

  it("refuses a missing database and a bad KEEP without creating anything", () => {
    expect(run({ DB_PATH: join(dir, "absent.db"), BACKUP_DIR: join(dir, "b") }).stderr).toMatch(/database not found/);
    expect(run({ DB_PATH: join(dir, "loopback.db"), BACKUP_DIR: join(dir, "b"), KEEP: "0" }).stderr).toMatch(/KEEP must be/);
    expect(existsSync(join(dir, "b"))).toBe(false);
  });

  it("keeps only the newest KEEP backups", () => {
    const backups = join(dir, "b");
    const seed = run({ DB_PATH: join(dir, "loopback.db"), BACKUP_DIR: backups, KEEP: "1" });
    expect(seed.status).toBe(0);
    const first = readdirSync(backups)[0] ?? "";
    const older = first.replace(/\d{8}T/, "19990101T");
    new Database(join(backups, older)).close();
    expect(run({ DB_PATH: join(dir, "loopback.db"), BACKUP_DIR: backups, KEEP: "1" }).status).toBe(0);
    expect(readdirSync(backups)).not.toContain(older);
    expect(readdirSync(backups)).toHaveLength(1);
  }, 20_000);
});

describe("Windows readiness facts", () => {
  const facts = (over: Partial<ReadinessFacts>): ReadinessFacts => ({ env: { GH_APP_PRIVATE_KEY_PATH: "x" }, keyModes: {}, daemon: true, desktop: true, containers: [], credFiles: {}, tagRuleset: true, ...over });
  const texts = (f: ReadinessFacts) => assessReadiness(f).map((i) => `${i.ok ? "ok" : "no"} ${i.text}`).join("\n");

  it("reports an ACL verdict instead of a mode", () => {
    expect(texts(facts({ keyModes: { GH_APP_PRIVATE_KEY_PATH: { aclProblem: null } } }))).toMatch(/ok GH_APP_PRIVATE_KEY_PATH: private to you \(ACL\)/);
    expect(texts(facts({ keyModes: { GH_APP_PRIVATE_KEY_PATH: { aclProblem: "file must be accessible only to you" } } }))).toMatch(/no GH_APP_PRIVATE_KEY_PATH: file must be/);
  });

  it("judges credential files by ACL too, and still lists missing names", () => {
    const t = texts(facts({ credFiles: { "fixer.env": { mode: { aclProblem: null }, names: ["GH_TOKEN"] }, "verifier.env": { mode: { aclProblem: "open" }, names: ["GH_TOKEN", "GH_REPO"] } } }));
    expect(t).toMatch(/no fixer.env: private to you \(ACL\), missing GH_REPO/);
    expect(t).toMatch(/no verifier.env: open/);
  });

  it("names Docker Desktop and missing tools", () => {
    expect(texts(facts({ daemon: false }))).toMatch(/no Docker Desktop not running \(start Docker Desktop\)/);
    expect(texts(facts({ tools: { gh: false, "Git Bash": true } }))).toMatch(/no gh not found[\s\S]*ok Git Bash found/);
  });

  it("accepts only Docker Desktop with Linux containers", () => {
    expect(isDesktopDaemon("Docker Desktop/linux\r\n")).toBe(true);
    expect(isDesktopDaemon("Docker Desktop/windows")).toBe(false);
    expect(isDesktopDaemon("Ubuntu 24.04/linux")).toBe(false);
  });
});

describe("assessDesktopDaemon", () => {
  const good = { OperatingSystem: "Docker Desktop", OSType: "linux", SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"] };
  const failures = (r: { level: string; text: string }[]) => r.filter((x) => x.level === "fail").map((x) => x.text).join("\n");

  it("passes Docker Desktop, and states the rootful difference instead of hiding it", () => {
    const r = assessDesktopDaemon(good, undefined);
    expect(failures(r)).toBe("");
    expect(r.some((x) => x.level === "info" && /not rootless/.test(x.text))).toBe(true);
  });

  it.each([
    [{ ...good, OperatingSystem: "Ubuntu" }, undefined, /not Docker Desktop/],
    [{ ...good, OSType: "windows" }, undefined, /not Linux/],
    [good, "tcp://10.0.0.1:2375", /DOCKER_HOST is set/],
    [{ ...good, SecurityOptions: [] }, undefined, /no seccomp/],
    [undefined, undefined, /not Docker Desktop/],
  ])("fails %#", (info, host, pattern) => {
    expect(failures(assessDesktopDaemon(info, host))).toMatch(pattern);
  });
});

describe("host-agent-tool.mjs", () => {
  it("reads only the role's GH_TOKEN line", () => {
    expect(roleToken("GH_REPO=o/r\nGH_TOKEN=abc\n")).toBe("abc");
    expect(roleToken("GH_TOKEN=abc\r\nX=y\r\n")).toBe("abc");
    expect(roleToken("X=y\n")).toBeNull();
  });

  it("runs only a full commit SHA, in a directory named after it", () => {
    const sha = "a".repeat(40);
    expect(testPlan(sha, [])).toEqual({ dir: `/home/verifier/runs/${sha}`, command: ["node", "--test", "test/index.test.js"] });
    expect(testPlan(sha, ["npm", "test"])?.command).toEqual(["npm", "test"]);
    for (const bad of [undefined, "abc", `${sha}; rm -rf /`, "../../etc/passwd", sha.toUpperCase()]) expect(testPlan(bad, [])).toBeNull();
  });

  it("diffs only two full SHAs: git diff's own options can write files, such as a hook", () => {
    const [a, b] = ["a".repeat(40), "b".repeat(40)];
    expect(diffPlan(a, b)).toEqual(["diff", "--no-ext-diff", "--no-textconv", a, b]);
    for (const bad of [undefined, "--output=.git/hooks/reference-transaction", "--no-index", "HEAD", "abc", `${a} ${b}`]) {
      expect(diffPlan(bad, b)).toBeNull();
      expect(diffPlan(a, bad)).toBeNull();
    }
  });

  it("the verifier's permission template allows no raw git diff and leaves signing to a person", () => {
    const template = readFileSync("templates/opencode-verifier.jsonc", "utf8");
    const allowed = [...template.matchAll(/"([^"]+)": "allow"/g)].map((m) => m[1]!);
    expect(allowed.filter((rule) => /^git diff/.test(rule))).toEqual([]);
    expect(allowed.filter((rule) => /host-agent-tool\.mjs (sign|gh)/.test(rule))).toEqual([]);
    expect(allowed).toEqual(expect.arrayContaining(["git fetch origin", "node <LOOPBACK>/scripts/host-agent-tool.mjs diff *", "node <LOOPBACK>/scripts/host-agent-tool.mjs test *"]));
  });
});

describe("backup-db.mjs", () => {
  it("refuses to write a backup into a cloud-synced folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lb-backup-"));
    try {
      const dbPath = join(dir, "x.db");
      new Database(dbPath).close();
      // Windows matches variable names case-insensitively, so the machine's own value must go first.
      const others = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^onedrive/i.test(name)));
      const r = spawnSync(process.execPath, ["scripts/backup-db.mjs"], {
        encoding: "utf8",
        env: { ...others, DB_PATH: dbPath, BACKUP_DIR: join(dir, "synced", "backups"), OneDrive: join(dir, "synced") },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cloud-synced/);
      expect(existsSync(join(dir, "synced"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the verifier's GitHub read through its tunnel", () => {
  it("sends a Host header with no port: GitHub answers api.github.com:80 with 400", async () => {
    const { request } = await import("node:http");
    const opts = githubGetOptions("/repos/o/r", "t");
    expect(opts.headers.host).toBe("api.github.com");
    const { Socket } = await import("node:net");
    const req = request({ ...opts, createConnection: () => new Socket() });
    req.on("error", () => undefined); // destroying it below reports a hang-up, which is expected
    expect(req.getHeader("host")).toBe("api.github.com");
    req.destroy();
  });
});
