#!/usr/bin/env node
// Run a command on a copy of a checkout in the runner sandbox (D29). Use this from the verifier
// container INSTEAD of running PR code yourself: the verifier holds the signer token, the runner
// holds nothing and has no network.
//
//   node /opt/loopback/run-in-sandbox.mjs [--timeout <sec>] --tree <dir> -- <argv...>
//   e.g. node /opt/loopback/run-in-sandbox.mjs --tree . -- npm test
//
// Prints the result JSON ({ok, exitCode, signal, timedOut, durationMs, stdout, stderr, ...}) and
// exits with the command's exit code (124 on timeout, 125 when the runner could not run it).
// The copy excludes every .git directory. Results come from next to PR code: treat as untrusted.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const MAX_RESULT_BYTES = 256 * 1024;

/**
 * One job at a time: while a job is pending, PR code running in the runner could read its id and
 * pre-write its result. With a single pending job, PR code can only ever touch its own result
 * (which the runner overwrites after the job), never another PR's.
 */
export function submitJob({ jobsDir, tree, argv, timeoutSec }) {
  const pending = readdirSync(jobsDir).filter((n) => !n.startsWith("."));
  if (pending.length > 0) throw new Error(`another sandbox job is pending (${pending.length}); run jobs one at a time`);
  const id = randomUUID();
  const dir = join(jobsDir, id);
  mkdirSync(dir, { mode: 0o755 });
  const root = resolve(tree);
  try {
    cpSync(root, join(dir, "tree"), {
      recursive: true, verbatimSymlinks: true,
      filter: (src) => !relative(root, src).split(sep).includes(".git"),
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const tmp = join(dir, ".job.json.tmp");
  writeFileSync(tmp, JSON.stringify({ argv, timeoutSec }), { mode: 0o644 });
  renameSync(tmp, join(dir, "job.json")); // written last: the runner ignores incomplete jobs
  return id;
}

export async function awaitResult({ resultsDir, id, timeoutMs, pollMs = 500 }) {
  const file = join(resultsDir, `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lstatSync(file, { throwIfNoEntry: false })) {
      // O_NOFOLLOW + fstat on the same descriptor: the file cannot be swapped for a symlink to
      // one of the verifier's own files between the check and the read.
      let fd;
      try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error("the runner's result is not a regular file"); }
      let text;
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error("the runner's result is not a regular file");
        if (st.size > MAX_RESULT_BYTES) throw new Error("the runner's result is too large");
        const buf = Buffer.alloc(st.size);
        readSync(fd, buf, 0, st.size, 0);
        text = buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
      let r;
      try { r = JSON.parse(text); } catch { throw new Error("the runner's result is malformed"); }
      if (r === null || typeof r !== "object" || typeof r.ok !== "boolean") throw new Error("the runner's result is malformed");
      return r;
    }
    await new Promise((ok) => setTimeout(ok, pollMs));
  }
  throw new Error("no result from the runner in time");
}

function usage() {
  process.stderr.write("usage: run-in-sandbox.mjs [--timeout <sec>] --tree <dir> -- <argv...>\n");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dd = args.indexOf("--");
  if (dd < 0 || dd === args.length - 1) usage();
  const opts = args.slice(0, dd);
  const argv = args.slice(dd + 1);
  const treeAt = opts.indexOf("--tree");
  const tree = treeAt >= 0 ? opts[treeAt + 1] : undefined;
  const timeoutAt = opts.indexOf("--timeout");
  const timeoutSec = timeoutAt >= 0 ? Number(opts[timeoutAt + 1]) : 600;
  if (!tree || !existsSync(tree) || !Number.isInteger(timeoutSec)) usage();
  const jobsDir = process.env.LOOPBACK_JOBS_DIR || "/jobs";
  const resultsDir = process.env.LOOPBACK_RESULTS_DIR || "/results";
  if (!isAbsolute(jobsDir) || !isAbsolute(resultsDir)) usage();
  let id;
  try { id = submitJob({ jobsDir, tree, argv, timeoutSec }); } catch (e) {
    process.stderr.write(`run-in-sandbox: ${e instanceof Error ? e.message : "error"}\n`);
    process.exit(125);
  }
  let result;
  try {
    result = await awaitResult({ resultsDir, id, timeoutMs: (timeoutSec + 60) * 1000 });
  } catch (e) {
    process.stderr.write(`run-in-sandbox: ${e instanceof Error ? e.message : "error"}\n`);
    rmSync(join(jobsDir, id), { recursive: true, force: true });
    process.exit(125);
  }
  rmSync(join(jobsDir, id), { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(!result.ok ? 125 : result.timedOut ? 124 : typeof result.exitCode === "number" ? result.exitCode : 125);
}
