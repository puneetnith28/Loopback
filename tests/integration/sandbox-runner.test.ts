import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES, RESULT_TTL_MS, forceRemove, processPending, pruneResults } from "../../scripts/sandbox-runner.mjs";
import { awaitResult, submitJob } from "../../scripts/run-in-sandbox.mjs";

// D29: PR code runs only in the runner sandbox (no network, no credentials, no signer). The
// verifier submits a copy of the tree through a jobs directory it alone can write; the runner
// copies it into its private workspace and returns a bounded result through a results directory
// it alone can write. Exercised with real child processes and real directories.

const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: process groups, POSIX signals and the Linux-only runner container.

let root = "";
let jobs = "";
let results = "";
let work = "";
let tree = "";
const node = process.execPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loopback-runner-"));
  for (const d of ["jobs", "results", "work", "tree"]) mkdirSync(join(root, d));
  [jobs, results, work, tree] = ["jobs", "results", "work", "tree"].map((d) => join(root, d)) as [string, string, string, string];
  writeFileSync(join(tree, "t.js"), "console.log('cwd ok', require('fs').existsSync('t.js')); console.log('token:' + (process.env.GH_TOKEN ?? 'none'));");
  mkdirSync(join(tree, ".git"));
  writeFileSync(join(tree, ".git", "config"), "[core]\n\thooksPath = /tmp/evil\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const run = async (argv: string[], opts: { timeoutSec?: number } = {}) => {
  const id = submitJob({ jobsDir: jobs, tree, argv, timeoutSec: opts.timeoutSec ?? 30 });
  await processPending({ jobsDir: jobs, resultsDir: results, workDir: work, env: { PATH: process.env.PATH ?? "", GH_TOKEN: "leak" } });
  const result = await awaitResult({ resultsDir: results, id, timeoutMs: 5000, pollMs: 20 });
  rmSync(join(jobs, id), { recursive: true, force: true }); // as the CLI does
  return { id, result };
};

describe.skipIf(ON_WINDOWS)("sandbox runner", () => {
  it("runs the job in a private copy of the tree, without .git, with a minimal environment", async () => {
    const { result } = await run([node, "t.js"]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(result.stdout).toContain("cwd ok true");
    expect(result.stdout).toContain("token:none"); // nothing from the runner's own environment leaks in
    expect(readdirSync(work)).toEqual([]); // the workspace is removed afterwards
  });

  it("the submitted copy excludes .git (no repository config or hooks reach the runner)", () => {
    const id = submitJob({ jobsDir: jobs, tree, argv: [node, "t.js"], timeoutSec: 30 });
    expect(existsSync(join(jobs, id, "tree", "t.js"))).toBe(true);
    expect(existsSync(join(jobs, id, "tree", ".git"))).toBe(false);
  });

  it("reports a failing test run as ok:true with its exit code", async () => {
    writeFileSync(join(tree, "fail.js"), "process.exit(3)");
    expect((await run([node, "fail.js"])).result).toMatchObject({ ok: true, exitCode: 3 });
  });

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("kills the whole process group on timeout, grandchildren included", async () => {
    const pidFile = join(root, "grandchild.pid");
    writeFileSync(join(tree, "hang.js"), `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const { result } = await run([node, "hang.js"], { timeoutSec: 1 });
    expect(result).toMatchObject({ ok: true, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(8000);
    const gc = Number(readFileSync(pidFile, "utf8"));
    await new Promise((ok) => setTimeout(ok, 200));
    expect(alive(gc)).toBe(false);
  });

  it("is not frozen by a grandchild that leaves the process group and keeps the output pipes open", async () => {
    const pidFile = join(root, "daemon.pid");
    // setsid: a new session, so the group kill cannot reach it; it inherits stdout/stderr.
    writeFileSync(join(tree, "daemonize.js"), `const c = require('child_process').spawn('setsid', [process.execPath, '-e', 'setInterval(()=>{}, 1000)'], { stdio: 'inherit', detached: false }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); process.exit(0);`);
    const t0 = Date.now();
    const { result } = await run([node, "daemonize.js"], { timeoutSec: 3 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    // Clean up the escaped process (inside the container the runner sweeps such strays itself).
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
  });

  it("keeps processing later jobs when one job cannot be answered", async () => {
    writeFileSync(join(tree, "ok.js"), "console.log('ok')");
    const id = submitJob({ jobsDir: jobs, tree, argv: [node, "ok.js"], timeoutSec: 30 });
    // An earlier-sorted entry whose results cannot be written (its result path is a directory).
    const bad = "00000000-0000-4000-8000-000000000001";
    mkdirSync(join(jobs, bad, "tree"), { recursive: true });
    writeFileSync(join(jobs, bad, "job.json"), JSON.stringify({ argv: ["x"], timeoutSec: 5 }));
    mkdirSync(join(results, `${bad}.json.blocker`));
    mkdirSync(join(results, `.${bad}.tmp`)); // writeResult's temp path is a directory: that job throws
    await processPending({ jobsDir: jobs, resultsDir: results, workDir: work, env: { PATH: process.env.PATH ?? "" } });
    expect(await awaitResult({ resultsDir: results, id, timeoutMs: 2000, pollMs: 20 })).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("preserves symlinks inside the tree as symlinks (they are not followed into the runner's view of the host)", async () => {
    symlinkSync("/etc/hostname", join(tree, "link"));
    writeFileSync(join(tree, "readlink.js"), "console.log('target=' + require('fs').readlinkSync('link'))");
    const { result } = await run([node, "readlink.js"]);
    expect(result.stdout).toContain("target=/etc/hostname");
  });

  it("survives PR code that makes its workspace undeletable (chmod 000), and answers the next job", async () => {
    writeFileSync(join(tree, "lock.js"), "const fs = require('fs'); fs.mkdirSync('d'); fs.writeFileSync('d/f', 'x'); fs.chmodSync('d', 0)");
    expect((await run([node, "lock.js"])).result).toMatchObject({ ok: true, exitCode: 0 });
    expect(readdirSync(work)).toEqual([]);
    writeFileSync(join(tree, "ok.js"), "console.log('next')");
    expect((await run([node, "ok.js"])).result.stdout).toContain("next");
  });

  it("forceRemove never throws on a missing path", () => {
    expect(() => forceRemove(join(root, "nope"))).not.toThrow();
  });

  it("accepts only one pending job at a time (PR code can never see another PR's job id)", () => {
    submitJob({ jobsDir: jobs, tree, argv: [node, "t.js"], timeoutSec: 30 });
    expect(() => submitJob({ jobsDir: jobs, tree, argv: [node, "t.js"], timeoutSec: 30 })).toThrow(/another sandbox job is pending/);
  });

  it("refuses a result that is a symlink (no read of the verifier's own files through the results volume)", async () => {
    const id = "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
    writeFileSync(join(root, "secret.json"), JSON.stringify({ ok: true, stdout: "verifier secret" }));
    symlinkSync(join(root, "secret.json"), join(results, `${id}.json`));
    await expect(awaitResult({ resultsDir: results, id, timeoutMs: 500, pollMs: 20 })).rejects.toThrow(/not a regular file/);
  });

  it("prunes old results and leaves fresh ones", () => {
    const oldId = "00000000-0000-4000-8000-0000000000aa";
    const newId = "00000000-0000-4000-8000-0000000000bb";
    writeFileSync(join(results, `${oldId}.json`), "{}");
    writeFileSync(join(results, `${newId}.json`), "{}");
    const past = (Date.now() - RESULT_TTL_MS - 60_000) / 1000;
    utimesSync(join(results, `${oldId}.json`), past, past);
    pruneResults(results, Date.now());
    expect(readdirSync(results)).toEqual([`${newId}.json`]);
  });

  it("bounds captured output", async () => {
    writeFileSync(join(tree, "loud.js"), `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES * 4}))`);
    const { result } = await run([node, "loud.js"]);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 64);
    expect(result.stdoutTruncated).toBe(true);
  });

  it.each([
    ["an empty argv", { argv: [] }],
    ["a non-string argument", { argv: ["node", 1] }],
    ["too many arguments", { argv: Array.from({ length: 65 }, () => "a") }],
    ["an over-long argument", { argv: ["a".repeat(5000)] }],
    ["a zero timeout", { argv: ["node"], timeoutSec: 0 }],
    ["an excessive timeout", { argv: ["node"], timeoutSec: 100_000 }],
    ["an extra field", { argv: ["node"], timeoutSec: 5, env: { GH_TOKEN: "x" } }],
  ])("rejects a job with %s and runs nothing", async (_n, job) => {
    const id = "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
    mkdirSync(join(jobs, id, "tree"), { recursive: true });
    writeFileSync(join(jobs, id, "job.json"), JSON.stringify({ timeoutSec: 5, ...job }));
    await processPending({ jobsDir: jobs, resultsDir: results, workDir: work, env: {} });
    expect(JSON.parse(readFileSync(join(results, `${id}.json`), "utf8"))).toMatchObject({ ok: false, error: "INVALID_JOB" });
  });

  it("ignores entries that are not job directories (path-shaped names, files, symlinks, incomplete jobs)", async () => {
    mkdirSync(join(jobs, "not-a-uuid"));
    writeFileSync(join(jobs, "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2d"), "file");
    symlinkSync(root, join(jobs, "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2e"));
    mkdirSync(join(jobs, "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2f")); // no job.json yet
    await processPending({ jobsDir: jobs, resultsDir: results, workDir: work, env: {} });
    expect(readdirSync(results)).toEqual([]);
  });

  it("does not run a job twice", async () => {
    writeFileSync(join(tree, "count.js"), `require('fs').appendFileSync(${JSON.stringify(join(root, "count"))}, 'x')`);
    const id = submitJob({ jobsDir: jobs, tree, argv: [node, "count.js"], timeoutSec: 30 });
    for (let i = 0; i < 3; i++) await processPending({ jobsDir: jobs, resultsDir: results, workDir: work, env: { PATH: process.env.PATH ?? "" } });
    expect(readFileSync(join(root, "count"), "utf8")).toBe("x");
    expect(existsSync(join(results, `${id}.json`))).toBe(true);
  });

  it("the client times out when no result arrives", async () => {
    await expect(awaitResult({ resultsDir: results, id: "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", timeoutMs: 100, pollMs: 20 })).rejects.toThrow(/no result/);
  });

  it("the client refuses an oversized or malformed result instead of trusting it", async () => {
    const id = "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
    writeFileSync(join(results, `${id}.json`), "{not json");
    await expect(awaitResult({ resultsDir: results, id, timeoutMs: 500, pollMs: 20 })).rejects.toThrow(/malformed/);
    writeFileSync(join(results, `${id}.json`), JSON.stringify({ ok: true, stdout: "x".repeat(1_000_000) }));
    await expect(awaitResult({ resultsDir: results, id, timeoutMs: 500, pollMs: 20 })).rejects.toThrow(/too large/);
  });
});

const CLI = join(process.cwd(), "scripts", "run-in-sandbox.mjs");
function cli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = ""; let stderr = "";
    c.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    c.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(ON_WINDOWS)("run-in-sandbox.mjs CLI", () => {
  it("refuses bad usage with exit 2", async () => {
    expect((await cli([], {})).code).toBe(2);
    expect((await cli(["--tree", tree], {})).code).toBe(2);
    expect((await cli(["--tree", tree, "--timeout", "x", "--", "node"], { LOOPBACK_JOBS_DIR: jobs, LOOPBACK_RESULTS_DIR: results })).code).toBe(2);
  });

  it("exits with the job's exit code, 124 on timeout, 125 when the runner answers ok:false", async () => {
    writeFileSync(join(tree, "three.js"), "process.exit(3)");
    const env = { LOOPBACK_JOBS_DIR: jobs, LOOPBACK_RESULTS_DIR: results };
    const runnerLoop = setInterval(() => { void processPending({ jobsDir: jobs, resultsDir: results, workDir: work, env: { PATH: process.env.PATH ?? "" } }); }, 50);
    try {
      expect((await cli(["--tree", tree, "--", node, "three.js"], env)).code).toBe(3);
      writeFileSync(join(tree, "sleep.js"), "setInterval(() => {}, 1000)");
      expect((await cli(["--timeout", "1", "--tree", tree, "--", node, "sleep.js"], env)).code).toBe(124);
      expect((await cli(["--tree", tree, "--", "/nonexistent/binary"], env)).code).toBe(125);
    } finally {
      clearInterval(runnerLoop);
    }
  }, 30_000);
});
