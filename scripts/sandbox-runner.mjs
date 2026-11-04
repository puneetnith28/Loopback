#!/usr/bin/env node
// Loopback runner sandbox daemon (D29). Runs inside the loopback-runner container: uid 10004,
// --network none, no credentials, no route to the signer. It is the ONLY place PR-controlled
// code (tests, build scripts) is executed for the verifier.
//
// Protocol: the verifier writes <jobs>/<uuid>/tree/ (a copy of the checkout, without .git) and
// then <jobs>/<uuid>/job.json = {"argv": [...], "timeoutSec": n}. The jobs volume is read-only
// here. The runner copies the tree into its private workspace, runs argv (no shell) with a
// minimal environment, kills the whole process group on timeout, and writes a bounded result to
// <results>/<uuid>.json (the results volume is read-only for the verifier). Results are produced
// next to PR code and are therefore untrusted: they inform the verifier, they never authorize.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_SEC = 1800;
const MAX_JOB_BYTES = 4096;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const POLL_MS = 1000;
/** After the job's process exits, how long its (possibly inherited) pipes may stay open. */
const EXIT_GRACE_MS = 500;
/** Results older than this are removed (the verifier reads its result within seconds). */
export const RESULT_TTL_MS = 30 * 60_000;
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The job, or null when it is not exactly {argv: string[1..64], timeoutSec: 1..1800}. */
export function validateJob(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== "argv" || keys[1] !== "timeoutSec") return null;
  const { argv, timeoutSec } = raw;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS) return null;
  if (!argv.every((a) => typeof a === "string" && a.length > 0 && a.length <= MAX_ARG_CHARS && !a.includes("\0"))) return null;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) return null;
  return { argv, timeoutSec };
}

function writeResult(resultsDir, id, result) {
  const tmp = join(resultsDir, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(result), { mode: 0o644 });
  renameSync(tmp, join(resultsDir, `${id}.json`));
}

function collector() {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(c) {
      if (size >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const room = MAX_OUTPUT_BYTES - size;
      if (c.length > room) truncated = true;
      chunks.push(c.subarray(0, room));
      size += Math.min(c.length, room);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

function killGroup(pid) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

/**
 * Inside the runner container only (this daemon is PID 1 and the role is "runner"): kill every
 * other process this uid can signal, including ones that escaped the job's process group with
 * setsid. kill(-1) excludes the caller and PID 1, i.e. this daemon. Never done outside the
 * container, where it would hit the user's own processes.
 */
function sweepStrays() {
  if (process.pid !== 1 || process.env.LOOPBACK_AGENT_ROLE !== "runner") return;
  try { process.kill(-1, "SIGKILL"); } catch { /* nothing else to kill */ }
}

function runJob(job, cwd, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = collector();
    const err = collector();
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(job.argv[0], job.argv.slice(1), {
        cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false,
        env: { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: cwd, CI: "1" },
      });
    } catch {
      resolve({ ok: false, error: "SPAWN_FAILED" });
      return;
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, job.timeoutSec * 1000);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", () => finish({ ok: false, error: "SPAWN_FAILED" }));
    const done = (code, signal) => finish({
      ok: true, exitCode: code, signal, timedOut, durationMs: Date.now() - started,
      stdout: out.text(), stderr: err.text(), stdoutTruncated: out.truncated(), stderrTruncated: err.truncated(),
    });
    // "close" waits for the pipes; a process that escaped the group can hold them open forever,
    // so after "exit" the pipes get a short grace period and are then destroyed.
    child.on("close", done);
    child.on("exit", (code, signal) => { setTimeout(() => done(code, signal), EXIT_GRACE_MS).unref(); });
  });
}

/**
 * Remove a job workspace even when PR code made parts of it unreadable (chmod 000 dirs):
 * restore owner permissions bottom-up, then delete. Never throws.
 */
export function forceRemove(path) {
  try { rmSync(path, { recursive: true, force: true }); return; } catch { /* fall through */ }
  const walk = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    try { chmodSync(p, 0o700); } catch { /* not ours */ }
    let names;
    try { names = readdirSync(p); } catch { return; }
    for (const n of names) walk(join(p, n));
  };
  walk(path);
  try { rmSync(path, { recursive: true, force: true }); } catch { /* left for the startup wipe */ }
}

/** Remove result files older than RESULT_TTL_MS (late or unread results never accumulate). */
export function pruneResults(resultsDir, nowMs) {
  for (const name of readdirSync(resultsDir)) {
    const p = join(resultsDir, name);
    try {
      if (nowMs - statSync(p).mtimeMs > RESULT_TTL_MS) rmSync(p, { force: true });
    } catch { /* raced with another removal */ }
  }
}

let busy = false;

/** Process every complete, not yet answered job once. Re-entrant calls return immediately. */
export async function processPending({ jobsDir, resultsDir, workDir, env }) {
  if (busy) return;
  busy = true;
  try {
    for (const id of readdirSync(jobsDir).sort()) {
      try {
        await processOne({ id, jobsDir, resultsDir, workDir, env });
      } catch (e) {
        // One job that cannot be read or answered never blocks the queue.
        process.stderr.write(`runner: job ${id}: ${e instanceof Error ? e.message : "error"}\n`);
      }
    }
  } finally {
    busy = false;
  }
}

async function processOne({ id, jobsDir, resultsDir, workDir, env }) {
  {
    // A single job: skipped (return) unless complete and not yet answered.
    if (!JOB_ID.test(id)) return;
    const dir = join(jobsDir, id);
    if (!lstatSync(dir).isDirectory()) return; // files and symlinks are never jobs
    if (existsSync(join(resultsDir, `${id}.json`))) return; // answered already
    const jobFile = join(dir, "job.json");
    const st = lstatSync(jobFile, { throwIfNoEntry: false });
    if (!st?.isFile()) return; // incomplete: the verifier writes job.json last
    let job = null;
    if (st.size <= MAX_JOB_BYTES) {
      try { job = validateJob(JSON.parse(readFileSync(jobFile, "utf8"))); } catch { job = null; }
    }
    const tree = join(dir, "tree");
    if (job === null || !lstatSync(tree, { throwIfNoEntry: false })?.isDirectory()) {
      writeResult(resultsDir, id, { ok: false, error: "INVALID_JOB" });
      return;
    }
    const ws = join(workDir, id);
    forceRemove(ws);
    let result;
    try {
      cpSync(tree, ws, { recursive: true, verbatimSymlinks: true });
      result = await runJob(job, ws, env);
    } catch {
      result = { ok: false, error: "RUNNER_ERROR" };
    } finally {
      sweepStrays();
      forceRemove(ws);
    }
    writeResult(resultsDir, id, result);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const jobsDir = process.env.LOOPBACK_JOBS_DIR || "/jobs";
  const resultsDir = process.env.LOOPBACK_RESULTS_DIR || "/results";
  const workDir = process.env.LOOPBACK_WORK_DIR || "/work";
  mkdirSync(workDir, { recursive: true });
  for (const n of readdirSync(workDir)) forceRemove(join(workDir, n)); // nothing survives a restart
  const env = { PATH: process.env.PATH };
  for (;;) {
    try {
      await processPending({ jobsDir, resultsDir, workDir, env });
      pruneResults(resultsDir, Date.now());
    } catch (e) { process.stderr.write(`runner: ${e instanceof Error ? e.message : "error"}\n`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
