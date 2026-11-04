/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { InboundMessage } from "@loopback/contracts";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGate, type Gate } from "../../apps/switch-gate/src/app.js";
import { ConfigError, loadGitHubConfig, loadIdentityConfig, loadRuntimeConfig, loadSwitchConfig } from "../../apps/switch-gate/src/config.js";
import type { GitHubClient } from "../../apps/switch-gate/src/github/client.js";
import { getCase, kvSet } from "../../apps/switch-gate/src/persistence/repos.js";
import { evaluateMerge, type CaseEvidence, type LiveSnapshot, type MergePolicy } from "../../apps/switch-gate/src/policy/evaluate.js";
import { findBash } from "../../scripts/sh.mjs";
import { BASE, FakeGitHub, G, REP, createHarness } from "../helpers/harness.js";

// Step 6.6, D12, D17: the nine outcomes of the ruleset proof.
//
//   1  green `test` but no loopback/gate cannot be merged     live only: scripts/ruleset-proof.mjs
//   2  a merge attempt with the fixer's token is refused      live only: scripts/ruleset-proof.mjs
//   3  a gate-status post with the fixer's token is refused   live only: scripts/ruleset-proof.mjs
//   4  a direct push to the run branch is refused             live only: scripts/ruleset-proof.mjs
//   5  the run branch exists before the fixer is tasked       here, and live
//   6  a competing demo branch is refused (WRONG_BASE)        here, and live
//   7  only the configured BASE_BRANCH ever counts            here
//   8  a pre-created run branch makes reset-demo refuse       here
//   9  a moved base is refused (BASE_COMMIT_MISMATCH)         here (startup and hand-off), and live
//
// Rulesets are enforced by GitHub, so 1 to 4 cannot be proved by any test in this repository.

const A = "a".repeat(40);
const OTHER = "e".repeat(40);
const RUN = "20261105-0123456789abcdef";
const RUN_BRANCH = `demo/${RUN}`;
const MAINT = "@switch-user-a1:loopback";
const MROOM = "room-1";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "loopback-base-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the gate itself

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SWITCH_BRIDGE_URL: "http://127.0.0.1:37203", SWITCH_AGENT_ID: "agent-1", SWITCH_AGENT_API_KEY: "test-key",
    SWITCH_ROOM_ID: MROOM, SWITCH_INTAKE_ROOM_ID: "room-2", SWITCH_SELF_ID: "@switch-agent-gate:loopback",
    SWITCH_POLICY_USER_IDS: "2a8934be-9a66-4944-a410-456e9e23b98c", SWITCH_POLICY_AGENT_IDS: "11111111-2222-4333-8444-555555555555",
    LOOPBACK_MAINTAINERS: MAINT, LOOPBACK_REPORTERS: MAINT, LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback", LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
    GH_REPO: "o/r", GH_APP_ID: "123", GH_APP_INSTALLATION_ID: "456", GH_APP_PRIVATE_KEY_PATH: join(dir, "gate.pem"),
    BASE_BRANCH: RUN_BRANCH, DEMO_RUN_ID: RUN, DEMO_RESET_SHA: BASE, REQUIRED_CHECKS: "test", CHECK_SOURCES: "test:github-actions", REQUIRED_CHECK_INTEGRATIONS: "test:15368",
    DB_PATH: join(dir, "loopback.db"), POLL_INTERVAL_MS: "100000",
    ...extra,
  };
}

const quiet = () => undefined;
function build(gh: FakeGitHub, extra: Record<string, string> = {}, postFails = false): { gate: Gate; posts: { room: string; content: string }[]; fatal: string[]; setPostFails: (v: boolean) => void } {
  const env = baseEnv(extra);
  writeFileSync(env.GH_APP_PRIVATE_KEY_PATH ?? "", "not used: GitHub is faked in this test");
  const posts: { room: string; content: string }[] = [];
  const fatal: string[] = [];
  let failing = postFails;
  const chat = { post: async (room: string, content: string) => {
    if (failing) throw new Error("not connected yet");
    posts.push({ room, content });
  } };
  const log = { info: quiet, warn: quiet, debug: quiet, trace: quiet, error: quiet, fatal: (_o: unknown, m: string) => { fatal.push(m); } } as unknown as Logger;
  const cfg = { runtime: loadRuntimeConfig(env), switch: loadSwitchConfig(env), identity: loadIdentityConfig(env), github: loadGitHubConfig(env, { checkKeyFile: false }) };
  return { gate: createGate(cfg, chat, log, { github: gh as unknown as GitHubClient }), posts, fatal, setPostFails: (v) => { failing = v; } };
}
const finish = async (gate: Gate) => { await gate.drain(); gate.stop(); };

let seq = 0;
const msg = (body: string): InboundMessage => {
  seq += 1;
  return { eventId: `b${seq}`, roomId: MROOM, sequence: seq, messageId: `b${seq}`, sender: MAINT, senderKind: null, onBehalfOf: null, senderRole: null, addressed: true, body, threadId: null, timestamp: seq };
};

describe("outcome 9: a moved base at gate startup (D17 d)", () => {
  it("a base at the expected commit starts normally", async () => {
    const { gate, posts, fatal } = build(new FakeGitHub());
    await gate.start();
    expect(gate.halt.halted).toBe(false);
    expect(fatal).toEqual([]);
    expect(posts.filter((p) => p.content.includes("BASE_COMMIT_MISMATCH"))).toEqual([]);
    await finish(gate);
  });

  it("a base anywhere else halts the gate, tells the maintainers and logs it", async () => {
    const gh = new FakeGitHub();
    gh.branchHead = OTHER;
    const { gate, posts, fatal } = build(gh);
    await gate.start();
    expect(gate.halt.halted).toBe(true);
    expect(gate.halt.reason).toContain("BASE_COMMIT_MISMATCH");
    expect(fatal.join("\n")).toContain("BASE_COMMIT_MISMATCH");
    expect(posts.some((p) => p.room === MROOM && p.content.includes("BASE_COMMIT_MISMATCH"))).toBe(true);
    await finish(gate);
  });

  it("merging stays disabled for the run: a merge command is refused and nothing is written", async () => {
    const gh = new FakeGitHub();
    gh.branchHead = OTHER;
    const { gate, posts } = build(gh, { LOOPBACK_PRIVILEGED_ENABLED: "true", MERGE_ENABLED: "true" });
    await gate.start();
    await gate.router.handle(msg(`${G} report slugify drops the percent sign`));
    await gate.router.handle(msg(`${G} merge LB-001`));
    expect(gh.statuses).toEqual([]);
    expect(posts.some((p) => /BASE_COMMIT_MISMATCH|STOPPED|BLOCKED/.test(p.content))).toBe(true);
    await finish(gate);
  });

  it("uses the base the gate last merged to, not the original, once it has merged", async () => {
    const gh = new FakeGitHub();
    gh.branchHead = OTHER;
    const { gate } = build(gh);
    kvSet(gate.db, "expected_base_sha", OTHER);
    await gate.start();
    expect(gate.halt.halted).toBe(false);
    await finish(gate);
  });

  it("GitHub being unavailable is not a mismatch: it does not halt, and it checks again", async () => {
    const gh = new FakeGitHub();
    gh.getBranchHead = async () => { throw new Error("down"); };
    const { gate } = build(gh);
    await gate.start();
    expect(gate.halt.halted).toBe(false);
    gh.getBranchHead = async () => OTHER;
    await gate.checkBaseIntegrity();
    expect(gate.halt.halted).toBe(true);
    await finish(gate);
  });

  it("a merge outcome still unknown may have moved the base, so the verdict waits for it", async () => {
    const gh = new FakeGitHub();
    gh.branchHead = OTHER;
    const { gate } = build(gh);
    gate.db.prepare(`INSERT INTO cases (id, state, reporter_id, room_id, repo, report_text, pr_number, head_sha, state_entered_at, created_at, updated_at) VALUES ('LB-001', 'MergeUnknown', 'r', 'room', 'o/r', 'x', 42, ?, 't', 't', 't')`).run(A);
    gate.db.prepare("INSERT INTO merge_operations (id, case_id, head_sha, attempt, idempotency_key, status, started_at) VALUES ('m1', 'LB-001', ?, 1, ?, 'unknown', 't')").run(A, `LB-001:${A}:1`);
    gh.getPull = async () => { throw new Error("still down"); };
    await gate.checkBaseIntegrity();
    expect(gate.halt.halted).toBe(false);
    gate.db.prepare("UPDATE merge_operations SET status = 'failed' WHERE id = 'm1'").run();
    await gate.checkBaseIntegrity();
    expect(gate.halt.halted).toBe(true);
    await finish(gate);
  });

  it("if chat is not connected yet, the notice is sent on a later check, once", async () => {
    const gh = new FakeGitHub();
    gh.branchHead = OTHER;
    const { gate, posts, setPostFails } = build(gh, {}, true);
    await gate.start();
    expect(gate.halt.halted).toBe(true);
    expect(posts).toEqual([]);
    setPostFails(false);
    await gate.checkBaseIntegrity();
    await gate.checkBaseIntegrity();
    expect(posts.filter((p) => p.content.includes("BASE_COMMIT_MISMATCH"))).toHaveLength(1);
    await finish(gate);
  });

  it("outside a demo run (no DEMO_RESET_SHA) there is no expected base to compare", async () => {
    const gh = new FakeGitHub();
    gh.branchHead = OTHER;
    const { gate } = build(gh, { DEMO_RUN_ID: "", DEMO_RESET_SHA: "", BASE_BRANCH: "main" });
    await gate.start();
    expect(gate.halt.halted).toBe(false);
    await finish(gate);
  });
});

describe("outcome 9: a moved base before the fixer is tasked", () => {
  it("blocks the case with BASE_COMMIT_MISMATCH and never tasks the fixer", async () => {
    const h = createHarness({ expectedBase: BASE });
    h.gh.branchHead = OTHER;
    await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
    const c = getCase(h.db, "LB-001");
    expect(c?.state === "Blocked" || c?.state === "Reported").toBe(true);
    expect(h.posts.some((p) => p.startsWith("@loopback-fixer"))).toBe(false);
  });
});

describe("outcome 5: the run branch must exist before the fixer is tasked", () => {
  it("a base branch that cannot be read never tasks the fixer", async () => {
    const h = createHarness({ expectedBase: BASE });
    h.gh.getBranchHead = async () => { throw new Error("404"); };
    await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
    expect(h.posts.some((p) => p.startsWith("@loopback-fixer"))).toBe(false);
  });
});

describe("outcomes 6 and 7: only the configured base ever counts", () => {
  const policy: MergePolicy = {
    baseBranch: RUN_BRANCH, requiredChecks: ["test"], checkSources: new Map([["test", "github-actions"]]),
    requiredCheckIntegrations: new Map([["test", 15368], ["loopback/gate", 5598944]]), gateStatusContext: "loopback/gate", maintainers: new Set([MAINT]), quorum: 1,
  };
  const evidence: CaseEvidence = {
    caseId: "LB-001", repo: "o/r", prNumber: 42, caseHeadSha: A,
    verificationRuns: [{ seq: 1, headSha: A, status: "pass", repository: "o/r", prNumber: 42 }],
    approvals: [{ headSha: A, approverId: MAINT, decision: "approve", repo: "o/r", prNumber: 42 }],
  };
  const snapshot = (baseRef: string): LiveSnapshot => ({
    changedFilesHeadSha: A, repo: "o/r", prNumber: 42,
    pr: { state: "open", draft: false, merged: false, mergeable: true, headSha: A, baseRef, headRef: "loopback/LB-001", headRepo: "o/r" },
    checks: [{ id: 10, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: A }],
    baseProtection: { requiredStatusChecks: [{ context: "test", integrationId: 15368 }, { context: "loopback/gate", integrationId: 5598944 }], requiresPullRequest: true, requiresUpToDate: true, blocksForcePush: true, restrictsDeletion: true },
    changedFiles: ["src/index.js"],
  });

  it("merges on exactly the configured base", () => {
    expect(evaluateMerge(evidence, snapshot(RUN_BRANCH), policy).action).toBe("merge");
  });

  it.each(["demo/20261105-ffffffffffffffff", "demo/20261105-0123456789abcdef-evil", "demo/", "main", "DEMO/20261105-0123456789ABCDEF"])("refuses a PR on %s with WRONG_BASE, even with perfect evidence", (baseRef) => {
    expect(evaluateMerge(evidence, snapshot(baseRef), policy)).toMatchObject({ action: "block", code: "WRONG_BASE" });
  });

  it("the poller ignores a PR opened against a competing demo branch", async () => {
    const h = createHarness();
    await h.say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
    h.gh.setPull(42, { baseRef: "demo/20261105-ffffffffffffffff" });
    await h.poller.tick();
    expect(h.state()).toBe("FixInProgress");
  });

  it("the gate refuses a BASE_BRANCH that is not the run's own branch", () => {
    expect(() => loadGitHubConfig(baseEnv({ BASE_BRANCH: "demo/20261105-ffffffffffffffff" }), { checkKeyFile: false })).toThrow(ConfigError);
    expect(() => loadGitHubConfig(baseEnv({ DEMO_RESET_SHA: "" }), { checkKeyFile: false })).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------- reset-demo.sh with a fake gh

// The script's own logic against a stand-in `gh` that records every call. Needs bash and jq.
const bash = findBash();
const hasJq = bash !== null && spawnSync(bash, ["-c", "command -v jq"], { encoding: "utf8" }).status === 0;
const REPO = "o/demo";
const RULESET = JSON.stringify({
  enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/demo/*"] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }, { type: "required_status_checks", parameters: { do_not_enforce_on_create: true, required_status_checks: [{ context: "test" }, { context: "loopback/gate" }] } }],
});
const SHA = "1".repeat(40);

interface Fake { ruleset?: string; branchExists?: boolean; shaExists?: boolean }
function runReset(fake: Fake, answer = REPO, env: Record<string, string> = {}): { status: number | null; out: string; calls: string[] } {
  writeFileSync(join(dir, "ruleset.json"), fake.ruleset ?? RULESET);
  const stub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.log"
case "$*" in
  "api repos/${REPO}/commits/"*) ${fake.shaExists === false ? "exit 1" : `echo ${SHA}`} ;;
  "api repos/${REPO}/rulesets/"*) cat "$FAKE_DIR/ruleset.json" ;;
  "api repos/${REPO}/git/ref/tags/demo-reset"*) echo ${SHA} ;;
  "api repos/${REPO}/git/ref/heads/demo/"*) ${fake.branchExists ? "echo exists" : "exit 1"} ;;
  "pr list"*) ;;
  "api repos/${REPO}/git/matching-refs/heads/loopback/"*) ;;
  "api -X POST repos/${REPO}/git/refs"*) echo created ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`;
  writeFileSync(join(dir, "gh"), stub, { mode: 0o755 });
  chmodSync(join(dir, "gh"), 0o755);
  const script = join(process.cwd(), "scripts", "reset-demo.sh").split("\\").join("/");
  const r = spawnSync(bash ?? "bash", [script], {
    encoding: "utf8", input: `${answer}\n`,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, FAKE_DIR: dir.split("\\").join("/"), GH_REPO: REPO, DEMO_RESET_SHA: SHA, RULESET_ID: "1", DB_PATH: join(dir, "absent.db").split("\\").join("/"), MSYS_NO_PATHCONV: "1", ...env },
  });
  let calls: string[] = [];
  try { calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n"); } catch { /* nothing was called */ }
  return { status: r.status, out: r.stdout + r.stderr, calls };
}
const wrote = (calls: string[]) => calls.filter((c) => /-X (POST|DELETE|PATCH|PUT)|pr close/.test(c));

describe.runIf(hasJq)("outcome 8 and the run-branch rules: reset-demo.sh", () => {
  it("creates the run branch through the API from the recorded SHA, never from the demo-reset ref", () => {
    const r = runReset({});
    expect(r.status, r.out).toBe(0);
    const post = wrote(r.calls);
    expect(post).toHaveLength(1);
    expect(post[0]).toMatch(/ref=refs\/heads\/demo\/\d{8}-[0-9a-f]{16}/);
    expect(post[0]).toContain(`sha=${SHA}`);
    expect(r.out).toMatch(/BASE_BRANCH=demo\/\d{8}-[0-9a-f]{16}/);
  });

  it("gives each run an unpredictable id", () => {
    const id = (s: string) => /DEMO_RUN_ID=(\S+)/.exec(s)?.[1];
    expect(id(runReset({}).out)).not.toBe(id(runReset({}).out));
  });

  it("refuses when the run's branch already exists, and changes nothing", () => {
    const r = runReset({ branchExists: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/already exists; refusing/);
    expect(wrote(r.calls)).toEqual([]);
  });

  it("changes nothing without the typed confirmation", () => {
    const r = runReset({}, "something-else");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/nothing changed/);
    expect(r.calls).toEqual([]);
  });

  it.each([
    ["inactive", { enforcement: "evaluate" }, /not active/],
    ["with a bypass actor", { bypass_actors: [{ actor_id: 1 }] }, /bypass list is not empty/],
    ["not targeting demo/*", { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } }, /does not target demo/],
    ["without required checks", { rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }] }, /does not require status check loopback\/gate/],
    ["enforcing checks when a run branch is created", { rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }, { type: "required_status_checks", parameters: { do_not_enforce_on_create: false, required_status_checks: [{ context: "test" }, { context: "loopback/gate" }] } }] }, /do_not_enforce_on_create/],
    ["allowing force pushes", { rules: [{ type: "deletion" }, { type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }, { context: "loopback/gate" }] } }] }, /missing rule non_fast_forward/],
  ])("aborts before any change when the ruleset is %s", (_name, change, message) => {
    const r = runReset({ ruleset: JSON.stringify({ ...(JSON.parse(RULESET) as object), ...change }) });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(message);
    expect(wrote(r.calls)).toEqual([]);
  });

  it("aborts when the recorded SHA does not exist, and refuses the main project repository", () => {
    expect(runReset({ shaExists: false }).out).toMatch(/not found/);
    expect(runReset({}, REPO, { GH_REPO: "puneetnith28/Loopback" }).out).toMatch(/refusing to run demo reset against main/);
  });
});
