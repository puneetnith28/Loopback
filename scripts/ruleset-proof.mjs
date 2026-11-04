#!/usr/bin/env node
// OWNER STEP (plan 6.6): prove on GitHub what the demo repository's rulesets actually enforce, and
// write the outcomes as evidence. Rulesets are enforced by GitHub, so no test here can prove this.
//
//   node scripts/ruleset-proof.mjs                dry run: shows every request; sends nothing
//   node scripts/ruleset-proof.mjs --apply        runs it, after you type the repository name
//
//   Required: GH_REPO=owner/repo, RUN_BRANCH=demo/<yyyymmdd>-<16 hex> (from scripts/reset-demo.sh),
//             DEMO_RESET_SHA=<the commit that branch was created from>.
//   Tokens:   the fixer's from <cred dir>/fixer.env; the maintainer's from LOOPBACK_OWNER_TOKEN or
//             `gh auth token`. They are sent only in Authorization headers and never printed.
//   Optional: --out <file> (default docs/evidence/phase-06-ruleset-proof.md).
//
// WHAT IT DOES TO THE REPOSITORY. On the fixer's token it creates a loopback/proof-* branch and PR,
// and it closes and deletes them afterwards. It leaves a demo/proof-* branch that can never be
// deleted (the ruleset restricts deletion and has no bypass list), and a loopback/gate status from
// the maintainer's account on the throwaway commit. Every refusal it expects is a merge, push, status
// or tag change that WOULD happen if the rules were wrong: a FAIL may mean a real write happened,
// always on throwaway branches, and a moved tag is put back at once. It changes no ruleset.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { isMainModule } from "./sh.mjs";

const TAG = "demo-reset";
const GATE_CONTEXT = "loopback/gate";
const CI_CHECK = "test";
const CI_WAIT_MS = 5 * 60_000;
const CI_POLL_MS = 10_000;
/** A refusal from a ruleset: anything else, above all 2xx, is not evidence of one. */
const REFUSED_MERGE = [403, 405, 409, 422];
const REFUSED_WRITE = [403, 409, 422];
const REFUSED_NO_PERMISSION = [403, 404];

export function validateInputs({ repo, runBranch, resetSha }) {
  const problems = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) problems.push("GH_REPO must be owner/repo");
  if (/\/loopback$/i.test(repo ?? "")) problems.push("refusing to run against the main Loopback repository");
  if (!/^demo\/\d{8}-[0-9a-f]{16}$/.test(runBranch ?? "")) problems.push("RUN_BRANCH must be demo/<yyyymmdd>-<16 hex>, from scripts/reset-demo.sh");
  if (!/^[0-9a-f]{40}$/.test(resetSha ?? "")) problems.push("DEMO_RESET_SHA must be a full commit SHA");
  return problems;
}

/**
 * Run the proof. `api(actor, method, path, body?)` returns { status, body }; `actor` is "owner" or
 * "fixer". Returns { outcomes, pr }. An outcome is { id, title, expected, actual, verdict } with a
 * verdict of PASS, FAIL or NOT RUN, and the proof passes only if every outcome is PASS.
 */
export async function runProof(api, { repo, runBranch, resetSha, nonce, wait = () => sleep(CI_POLL_MS), now = () => Date.now(), ciWaitMs = CI_WAIT_MS }) {
  const r = `repos/${repo}`;
  const outcomes = [];
  const note = (id, title, expected, actual, verdict) => outcomes.push({ id, title, expected, actual, verdict });
  const refused = (id, title, allowed, res) => note(id, title, `refused (${allowed.join("/")})`, String(res.status), allowed.includes(res.status) ? "PASS" : "FAIL");
  const notRun = (id, title, why) => note(id, title, "refused", `not run: ${why}`, "NOT RUN");

  // 5: the run branch exists, at the recorded commit, before any agent acts.
  const branch = await api("owner", "GET", `${r}/git/ref/heads/${runBranch}`);
  const runHead = branch.body?.object?.sha;
  note("5", "the run branch exists before the fixer is tasked", "200", String(branch.status), branch.status === 200 ? "PASS" : "FAIL");
  note("9a", "the run branch is at the recorded commit", resetSha, runHead ?? "(none)", runHead === resetSha ? "PASS" : "FAIL");
  if (branch.status !== 200) return { outcomes, pr: null };

  // A throwaway PR into the run branch, from the fixer, as a real run would make.
  const work = `loopback/proof-${nonce}`;
  const cleanups = [];
  let pr = null;
  try {
    const made = await api("fixer", "POST", `${r}/git/refs`, { ref: `refs/heads/${work}`, sha: resetSha });
    note("setup", "the fixer can create its case branch", "201", String(made.status), made.status === 201 ? "PASS" : "FAIL");
    if (made.status !== 201) return { outcomes, pr };
    cleanups.push(() => api("owner", "DELETE", `${r}/git/refs/heads/${work}`));

    const content = Buffer.from(`ruleset proof ${nonce}\n`).toString("base64");
    const commit = await api("fixer", "PUT", `${r}/contents/proof/${nonce}.txt`, { message: `test: ruleset proof ${nonce}`, content, branch: work });
    const head = commit.body?.commit?.sha;
    const opened = commit.status === 201 ? await api("fixer", "POST", `${r}/pulls`, { title: `Ruleset proof ${nonce} (do not merge)`, head: work, base: runBranch, body: "Created and closed by scripts/ruleset-proof.mjs." }) : { status: commit.status };
    pr = opened.body?.number ?? null;
    note("setup", "the fixer can commit and open a PR", "201", String(opened.status), opened.status === 201 && head ? "PASS" : "FAIL");
    if (pr === null || !head) return { outcomes, pr };
    cleanups.unshift(() => api("owner", "PATCH", `${r}/pulls/${pr}`, { state: "closed" }));

    // 1 needs CI to be green first: otherwise a refusal would prove nothing about the gate's status.
    const deadline = now() + ciWaitMs;
    let conclusion = null;
    while (conclusion === null && now() < deadline) {
      const checks = await api("owner", "GET", `${r}/commits/${head}/check-runs?check_name=${CI_CHECK}`);
      const run = checks.body?.check_runs?.[0];
      if (run?.status === "completed") conclusion = run.conclusion;
      else await wait();
    }
    const green = conclusion === "success";
    note("setup", `the \`${CI_CHECK}\` check is green on the PR head`, "success", conclusion ?? "not finished in time", green ? "PASS" : "FAIL");

    const merge = { sha: head, merge_method: "squash" };
    if (green) {
      refused("1", "green CI but no loopback/gate: the maintainer's account cannot merge", REFUSED_MERGE, await api("owner", "PUT", `${r}/pulls/${pr}/merge`, merge));
    } else {
      notRun("1", "green CI but no loopback/gate: the maintainer's account cannot merge", "CI was not green");
    }
    refused("2", "the fixer's token cannot merge", REFUSED_MERGE, await api("fixer", "PUT", `${r}/pulls/${pr}/merge`, merge));
    refused("3", "the fixer's token cannot post loopback/gate", REFUSED_NO_PERMISSION, await api("fixer", "POST", `${r}/statuses/${head}`, { state: "success", context: GATE_CONTEXT }));
    // The check is pinned to the gate's App, so a success from anyone else must not satisfy it.
    const forged = await api("owner", "POST", `${r}/statuses/${head}`, { state: "success", context: GATE_CONTEXT, description: "ruleset proof: from the wrong source" });
    if (forged.status === 201 && green) {
      refused("3b", "a loopback/gate success from another source does not unlock a merge", REFUSED_MERGE, await api("owner", "PUT", `${r}/pulls/${pr}/merge`, merge));
    } else {
      notRun("3b", "a loopback/gate success from another source does not unlock a merge", green ? `could not post the status (${forged.status})` : "CI was not green");
    }
    refused("4", "the fixer's token cannot push directly to the run branch", REFUSED_WRITE, await api("fixer", "PUT", `${r}/contents/proof/direct-${nonce}.txt`, { message: "test: direct push", content, branch: runBranch }));
    refused("4b", "the fixer's token cannot change a workflow", REFUSED_NO_PERMISSION, await api("fixer", "PUT", `${r}/contents/.github/workflows/proof-${nonce}.yml`, { message: "test: workflow change", content, branch: work }));

    // 6: GitHub may let the fixer create this branch. What matters is that the gate never accepts
    // it, which tests/security/demo-base-integrity.test.ts proves; this records GitHub's half.
    const competing = await api("fixer", "POST", `${r}/git/refs`, { ref: `refs/heads/demo/proof-${nonce}`, sha: resetSha });
    note("6", "a competing demo branch (the gate refuses a PR on it: WRONG_BASE, see the test)", "either; recorded", String(competing.status), [201, 403, 422].includes(competing.status) ? "PASS" : "FAIL");

    // 9: the tag. Without a tag ruleset this request WOULD move it, so it needs one to exist first.
    const rulesets = await api("owner", "GET", `${r}/rulesets`);
    const tagProtected = Array.isArray(rulesets.body) && rulesets.body.some((s) => s.target === "tag" && s.enforcement === "active");
    const tagRef = await api("owner", "GET", `${r}/git/ref/tags/${TAG}`);
    const tagSha = tagRef.body?.object?.sha;
    if (!tagProtected) {
      notRun("9b", "the demo-reset tag cannot be moved", "no active tag ruleset (deploy/github/protect-demo-reset-tag.sh)");
    } else if (!tagSha) {
      notRun("9b", "the demo-reset tag cannot be moved", "the tag could not be read");
    } else {
      const moved = await api("owner", "PATCH", `${r}/git/refs/tags/${TAG}`, { sha: head, force: true });
      refused("9b", "the demo-reset tag cannot be moved", REFUSED_WRITE, moved);
      if (moved.status >= 200 && moved.status < 300) {
        const restored = await api("owner", "PATCH", `${r}/git/refs/tags/${TAG}`, { sha: tagSha, force: true });
        note("9c", "the tag was put back after moving", "200", String(restored.status), restored.status === 200 ? "PASS" : "FAIL");
      }
    }
    return { outcomes, pr };
  } finally {
    for (const clean of cleanups) {
      try {
        const res = await clean();
        if (res.status >= 400 && res.status !== 404 && res.status !== 422) note("cleanup", "remove the throwaway PR and branch", "2xx", String(res.status), "FAIL");
      } catch {
        note("cleanup", "remove the throwaway PR and branch", "2xx", "request failed", "FAIL");
      }
    }
  }
}

export const passed = (outcomes) => outcomes.length > 0 && outcomes.every((o) => o.verdict === "PASS");

export function renderEvidence({ repo, runBranch, resetSha, when, outcomes, pr }) {
  const cell = (s) => String(s).replace(/\|/g, "\\|");
  const rows = outcomes.map((o) => `| ${cell(o.id)} | ${cell(o.title)} | ${cell(o.expected)} | ${cell(o.actual)} | **${o.verdict}** |`);
  return [
    "# Ruleset proof (step 6.6)", "",
    `Run ${when} by \`scripts/ruleset-proof.mjs\` against \`${repo}\`, run branch \`${runBranch}\` at \`${resetSha}\`${pr ? `, throwaway PR #${pr}` : ""}.`,
    "Outcomes 6, 7, 8 and the gate's half of 9 are also proved by `tests/security/demo-base-integrity.test.ts`.", "",
    "| # | Outcome | Expected | Actual | Verdict |", "|---|---|---|---|---|", ...rows, "",
    `**Overall: ${passed(outcomes) ? "every outcome passed" : "NOT PROVEN"}.**`, "",
  ].join("\n");
}

function envValue(path, name) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\S+)/.exec(line);
    if (m && m[1] === name) return m[2];
  }
  return null;
}

function usage(problems) {
  for (const p of problems) process.stderr.write(`ruleset-proof: ${p}\n`);
  process.exit(2);
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const outAt = argv.indexOf("--out");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = outAt >= 0 ? argv[outAt + 1] : join(root, "docs", "evidence", "phase-06-ruleset-proof.md");
  const repo = process.env.GH_REPO;
  const runBranch = process.env.RUN_BRANCH;
  const resetSha = process.env.DEMO_RESET_SHA;
  const problems = validateInputs({ repo, runBranch, resetSha });
  if (problems.length > 0) usage(problems);

  const nonce = randomBytes(6).toString("hex");
  if (!apply) {
    // A dry run: the same logic, recording requests against an API that answers as a correct setup would.
    const planned = [];
    const fake = (actor, method, path) => {
      planned.push(`${actor.padEnd(5)} ${method.padEnd(6)} ${path}`);
      if (path.endsWith(`/git/ref/heads/${runBranch}`)) return { status: 200, body: { object: { sha: resetSha } } };
      if (path.endsWith("/check-runs?check_name=test")) return { status: 200, body: { check_runs: [{ status: "completed", conclusion: "success" }] } };
      if (path.endsWith("/rulesets")) return { status: 200, body: [{ target: "tag", enforcement: "active" }] };
      if (path.endsWith(`/git/ref/tags/${TAG}`)) return { status: 200, body: { object: { sha: resetSha } } };
      if (path.endsWith("/pulls") && method === "POST") return { status: 201, body: { number: 0 } };
      if (path.includes(`/contents/proof/${nonce}.txt`)) return { status: 201, body: { commit: { sha: "HEAD" } } };
      if (method === "POST" && path.endsWith("/git/refs")) return { status: 201, body: {} };
      return { status: method === "GET" ? 200 : 403, body: {} };
    };
    await runProof((a, m, p) => Promise.resolve(fake(a, m, p)), { repo, runBranch, resetSha, nonce });
    process.stdout.write(`DRY RUN: nothing was sent. These requests would be made (PR numbers and SHAs are placeholders):\n${planned.join("\n")}\nRe-run with --apply to make them.\n`);
    return 0;
  }

  const credDir = process.env.LOOPBACK_AGENT_CRED_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "loopback-agents");
  const fixerFile = join(credDir, "fixer.env");
  if (!existsSync(fixerFile)) usage([`missing ${fixerFile} (GH_TOKEN, GH_REPO)`]);
  const fixerToken = envValue(fixerFile, "GH_TOKEN");
  if (!fixerToken) usage([`${fixerFile} has no GH_TOKEN`]);
  let ownerToken = process.env.LOOPBACK_OWNER_TOKEN;
  if (!ownerToken) {
    try { ownerToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { usage(["set LOOPBACK_OWNER_TOKEN, or log in with gh"]); }
  }
  if (ownerToken === fixerToken) usage(["the maintainer's and fixer's tokens are the same token"]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This attempts merges, pushes and a tag move on ${repo} that the rules should refuse, and leaves an undeletable demo/proof-* branch. Type the repository name to continue: `);
  rl.close();
  if (answer.trim() !== repo) { process.stdout.write("confirmation did not match; nothing was sent\n"); return 1; }

  const tokens = { owner: ownerToken, fixer: fixerToken };
  const api = async (actor, method, path, body) => {
    const res = await globalThis.fetch(`https://api.github.com/${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[actor]}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "loopback-ruleset-proof" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* an empty body */ }
    return { status: res.status, body: parsed };
  };
  const { outcomes, pr } = await runProof(api, { repo, runBranch, resetSha, nonce });
  const text = renderEvidence({ repo, runBranch, resetSha, when: new Date().toISOString(), outcomes, pr });
  writeFileSync(out, text);
  process.stdout.write(`${text}\nEvidence written to ${out}\n`);
  return passed(outcomes) ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
