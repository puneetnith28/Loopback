#!/usr/bin/env node
// For agents Switch Console runs on the host, outside the isolation containers. Verification stays
// advisory for these agents, because they share the desktop user's files. This at least keeps PR
// code in the network-less runner and gets real signatures from the signer.
//
//   node host-agent-tool.mjs gh fixer|verifier <gh arguments...>   gh with only that role's token
//   node host-agent-tool.mjs test <full sha> [-- <argv>]           run a commit's tests in the runner
//   node host-agent-tool.mjs sign <lbcap1...> < report.json        ask the signer to sign a report
//
// Run `test` from a clone of the repository. Prints no token.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "./sh.mjs";

const VERIFIER = "loopback-verifier";

function die(message) {
  process.stderr.write(`host-agent-tool: ${message}\n`);
  process.exit(2);
}

/** A role's token from its env file. A token from the caller's environment is never used. */
export function roleToken(text) {
  const m = /^GH_TOKEN=(\S+)\s*$/m.exec(text);
  return m ? m[1] : null;
}

/** The argv for a test run, after checking the arguments cannot reach a shell as code. */
export function testPlan(sha, argv) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return null;
  const command = argv.length > 0 ? argv : ["node", "--test", "test/index.test.js"];
  return { dir: `/home/verifier/runs/${sha}`, command };
}

function gh(role, args) {
  if (role !== "fixer" && role !== "verifier") die("usage: gh fixer|verifier <arguments>");
  const dir = process.env.LOOPBACK_AGENT_CRED_DIR || join(homedir(), ".config", "loopback-agents");
  const token = roleToken(readFileSync(join(dir, `${role}.env`), "utf8"));
  if (!token) die(`${role}.env has no GH_TOKEN`);
  const installed = "C:\\Program Files\\GitHub CLI\\gh.exe";
  const env = { ...process.env, GH_TOKEN: token };
  delete env.GITHUB_TOKEN;
  const r = spawnSync(existsSync(installed) ? installed : "gh", args, { stdio: "inherit", env });
  if (r.error) die(`could not run gh: ${r.error.message}`);
  return r.status ?? 1;
}

/** Copy the commit, without .git, into the verifier container; the runner takes it from there. */
function test(sha, argv) {
  const plan = testPlan(sha, argv);
  if (plan === null) die("usage: test <full 40-character sha> [-- <argv>]");
  execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  const unpack = spawnSync("docker", ["exec", VERIFIER, "sh", "-c", 'rm -rf "$1" && mkdir -p "$1"', "sh", plan.dir], { stdio: "inherit" });
  if (unpack.status !== 0) die("could not prepare the run directory; is the verifier container running?");
  return new Promise((resolve) => {
    const archive = spawn("git", ["archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "inherit"] });
    const tar = spawn("docker", ["exec", "-i", VERIFIER, "tar", "-x", "-C", plan.dir], { stdio: ["pipe", "inherit", "inherit"] });
    archive.stdout.pipe(tar.stdin);
    tar.on("close", (code) => {
      if (code !== 0) { resolve(code ?? 1); return; }
      const run = spawnSync("docker", ["exec", "-w", plan.dir, VERIFIER, "node", "/opt/loopback/run-in-sandbox.mjs", "--tree", ".", "--", ...plan.command], { stdio: "inherit" });
      resolve(run.status ?? 1);
    });
  });
}

function sign(capability) {
  if (!/^lbcap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(capability ?? "")) die("usage: sign <lbcap1...> < report.json");
  const r = spawnSync("docker", ["exec", "-i", VERIFIER, "node", "/opt/loopback/request-signature.mjs", "--capability", capability], { stdio: "inherit" });
  return r.status ?? 1;
}

if (isMainModule(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "gh") {
    process.exitCode = gh(rest[0], rest.slice(1));
  } else if (command === "test") {
    const at = rest.indexOf("--");
    process.exitCode = await test(rest[0], at >= 0 ? rest.slice(at + 1) : []);
  } else if (command === "sign") {
    process.exitCode = sign(rest[0]);
  } else {
    die("usage: gh fixer|verifier <args> | test <sha> [-- <argv>] | sign <capability>");
  }
}
