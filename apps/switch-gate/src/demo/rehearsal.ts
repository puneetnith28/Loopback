import { generateKeyPairSync } from "node:crypto";
import type { InboundMessage } from "@loopback/contracts";
import { signReport } from "../agents/signature.js";
import { CaseLocks } from "../cases/lock.js";
import { HaltSwitch } from "../cases/halt.js";
import { MergeExecutor } from "../cases/service.js";
import { Router } from "../commands/router.js";
import { migrate, openDatabase, type Db } from "../persistence/db.js";
import { getCase, kvSet, latestCi, latestRunForHead, listApprovals } from "../persistence/repos.js";
import { recordGateSettings } from "../persistence/settings.js";
import { renderCaseTable, renderDecisionTable } from "../switch/board.js";
import { renderTeam } from "../switch/team.js";
import { Poller } from "../workflow/poller.js";
import { VerificationWorkflow, type WorkflowDeps } from "../workflow/verification.js";
import { RehearsalGitHub } from "./fake-github.js";

// `npm run demo`: one bug from a public report to a merge, with the attacks and mistakes the gate
// exists to stop, in about a minute and with no accounts.
//
// REAL here: the router, admission and authorization, the state machine, the merge policy, the
// SQLite audit log and the Ed25519 signatures. They are the same modules the live gate runs.
// SIMULATED: Switch's delivery, GitHub and the two agents' sessions. Switch is what puts all of this
// in a team's chat in real life, so this rehearses the gate's decisions, not the integration. The
// live evidence is in docs/evidence/.
//
// It checks itself: every scene states what must happen, and a scene that does not happen fails the
// run with exit code 1, so the demo can't quietly stop showing what it claims.

/** Shown wherever the case is, including the console, so its data can't be taken for a real run. */
const REPO = "simulated/rehearsal-not-a-live-run";
const BASE_BRANCH = "main";
const G = "@loopback-gate";
const FIXER = "@switch-agent-fixer:demo";
const VERIFIER = "@switch-agent-verifier:demo";
const SELF = "@switch-agent-gate:demo";
// People's ids in the shape Switch's Slack bridge gives them (`@switch-slack-<bridge>-<username>:<server>`, shortened).
const MAINTAINER = "@switch-slack-puneet:demo";
const REPORTER = "@switch-slack-prashant:demo";
const STRANGER = "@switch-slack-mallory:demo";
const MAINT_ROOM = "loopback-maintainers";
const INTAKE_ROOM = "loopback-intake";
const BASE_SHA = "b".repeat(40);
const COMMIT_A = "a1f4c2e9d07b3c5a8e6f1d2b4c7a9e0f3b5d8c1a";
const COMMIT_B = "c7d92e41b6a03f58e1c4d7a2f9b0e63c5a18d4f7";
const WRONG_SHA = "0".repeat(40);
const MERGE_SHA = "d3e8f1a2c4b6079e5d1f3a8c6b2e4d7f9a0c1b35";
const REPORT = "formatToken throws TypeError when extend({ '%': null }) is used";

const NAMES: Readonly<Record<string, string>> = {
  [MAINTAINER]: "Puneet (maintainer)", [REPORTER]: "Prashant (contributor)", [STRANGER]: "Mallory (not a maintainer)",
  [FIXER]: "loopback-fixer (agent)", [VERIFIER]: "loopback-verifier (agent)",
};

export interface RehearsalOptions {
  /** Where the audit database goes. ":memory:" keeps nothing. */
  readonly dbPath: string;
  readonly print: (line: string) => void;
  /** Called between scenes, so a person can follow along. */
  readonly pause?: () => Promise<void>;
  readonly color?: boolean;
  /** Receives the run as structured events; `npm run demo:page` builds the public page from them. */
  readonly record?: (event: RehearsalEvent) => void;
  /** The clock the gate sees. `npm run demo:page` steps it, so the recorded times read like a real case. */
  readonly now?: () => Date;
  /** Called whenever the database has settled; `npm run demo:page` reads the console's API here. */
  readonly checkpoint?: () => Promise<void>;
}

export type RehearsalEvent =
  | { readonly kind: "scene"; readonly title: string }
  | { readonly kind: "chat"; readonly room: string; readonly who: string; readonly role: "person" | "agent" | "gate"; readonly text: string; readonly refused: boolean; readonly senderId?: string }
  | { readonly kind: "github"; readonly text: string }
  | { readonly kind: "check"; readonly claim: string; readonly held: boolean }
  | { readonly kind: "state"; readonly state: string | null; readonly commit: string | null; readonly ci: string | null; readonly verifier: string | null; readonly approvals: number }
  | { readonly kind: "tables"; readonly board: string; readonly decisions: string };

export interface RehearsalResult {
  readonly db: Db;
  readonly outcomes: readonly { readonly claim: string; readonly held: boolean }[];
  readonly passed: boolean;
}

/** Remove the long, meaningless parts of a chat message for reading. The real text is what was sent. */
function forReading(text: string): string {
  return text
    .replace(/Signing capability: \S+/g, "Signing capability: lbcap1… (lets the signer sign for this one run only)")
    .replace(/```loopback-report\n[\s\S]*?\n```/g, (block) => {
      const r = JSON.parse(block.split("\n")[1] ?? "{}") as { verdict?: string; headSha?: string; signature?: unknown; status?: string };
      if (r.verdict !== undefined) return `[loopback-report: verdict ${r.verdict} on ${(r.headSha ?? "").slice(0, 12)}${r.signature === undefined ? ", unsigned" : ", signed"}]`;
      return `[loopback-report: ${r.status ?? "?"} on ${(r.headSha ?? "").slice(0, 12)}]`;
    });
}

export async function runRehearsal(o: RehearsalOptions): Promise<RehearsalResult> {
  const c = (code: string, s: string) => (o.color === true ? `\u001b[${code}m${s}\u001b[0m` : s);
  const db = openDatabase(o.dbPath);
  migrate(db);
  const github = new RehearsalGitHub(REPO, BASE_BRANCH, BASE_SHA);
  const verifierKeys = generateKeyPairSync("ed25519");
  const issuerKeys = generateKeyPairSync("ed25519");
  const forgedKeys = generateKeyPairSync("ed25519");
  const now = o.now ?? (() => new Date());
  const maintainers = new Set([MAINTAINER]);
  const outcomes: { claim: string; held: boolean }[] = [];
  let lastPosts: string[] = [];
  let mergeCalls = 0;

  const chat = {
    post: (room: string, content: string) => {
      lastPosts.push(content);
      const refused = /^(\[LB-\d+\] )?(REFUSED|BLOCKED)/.test(content);
      o.record?.({ kind: "chat", room, who: "loopback-gate", role: "gate", text: forReading(content), refused });
      o.print(`  ${c("2", `#${room}`)} ${c("36", "loopback-gate")}: ${forReading(content).split("\n").map((l, i) => (i === 0 ? (refused ? c("31", l) : l) : `    ${l}`)).join("\n")}`);
      return Promise.resolve();
    },
  };

  const locks = new CaseLocks();
  const halt = new HaltSwitch();
  const wfDeps: WorkflowDeps = {
    db, chat, github, locks, now, repo: REPO, baseBranch: BASE_BRANCH, requiredChecks: ["test"],
    checkSources: new Map([["test", "github-actions"]]), gateMention: G, fixerAlias: "@loopback-fixer",
    verifierAlias: "@loopback-verifier", verifyTimeoutMs: 1_800_000, fixTimeoutMs: 2_700_000, halt,
    verificationAdvisory: true, verifierPublicKey: verifierKeys.publicKey, expectedBaseSha: () => null,
    runIssuerKey: issuerKeys.privateKey,
  };
  // The settings this rehearsal runs with, recorded as the live gate records its own, for the console.
  recordGateSettings(db, {
    repo: REPO, baseBranch: BASE_BRANCH, requiredChecks: ["test"], verificationMode: "advisory",
    safety: { mergeEnabled: true, privilegedEnabled: true, verifierIsolationProven: false },
    quorum: 1, gateMention: G, pollIntervalMs: 30_000, verifyTimeoutMs: wfDeps.verifyTimeoutMs, fixTimeoutMs: wfDeps.fixTimeoutMs,
  });
  const workflow = new VerificationWorkflow(wfDeps);
  const poller = new Poller(wfDeps, workflow, { warn: () => undefined });
  const executor = new MergeExecutor({
    db, chat, github, locks, now, mergeEnabled: true, configComplete: true, halt, transientRetryLimit: 3, mergeMaxAttempts: 2,
    merger: (n) => {
      mergeCalls += 1;
      github.markMerged(n, MERGE_SHA);
      return Promise.resolve({ merged: true, sha: MERGE_SHA });
    },
    policy: {
      baseBranch: BASE_BRANCH, requiredChecks: ["test"], checkSources: new Map([["test", "github-actions"]]),
      requiredCheckIntegrations: new Map([["test", 1], ["loopback/gate", 100]]), gateStatusContext: "loopback/gate", maintainers, quorum: 1,
    },
    requestVerification: (id) => workflow.requestVerificationLocked(id, "system", false),
    onMergeConfirmed: (sha) => kvSet(db, "expected_base_sha", sha),
    gateMention: G, verificationAdvisory: true,
  });
  const statuses = new Map([["loopback-fixer", "live"], ["loopback-verifier", "live"], ["loopback-gate", "live"]]);
  const router = new Router({
    db, chat, repo: REPO, quorum: 1, requiredChecks: ["test"],
    admission: { selfId: SELF, fixerId: FIXER, verifierId: VERIFIER, gateMention: G, maintainerRoomId: MAINT_ROOM, intakeRoomId: INTAKE_ROOM },
    intakeMaxReportsPerHour: 3,
    identity: { maintainers, reporters: new Set<string>(), privilegedEnabled: true },
    privileged: {
      verify: (ctx, id) => workflow.verifyCommand(ctx, id),
      approve: (ctx, id, sha) => workflow.approve(ctx, id, sha),
      reject: (ctx, id, reason) => workflow.reject(ctx, id, reason),
      retask: (ctx, id, note) => workflow.retask(ctx, id, note),
      merge: (ctx, id) => executor.merge(ctx.msg.sender, id),
    },
    views: {
      why: (id) => executor.why(id),
      team: () => Promise.resolve({ text: renderTeam(["loopback-fixer", "loopback-verifier", "loopback-gate"], statuses), caseId: null }),
    },
    handoff: workflow, agents: workflow, now,
  });

  let seq = 0;
  const say = async (sender: string, body: string, roomId = MAINT_ROOM) => {
    seq += 1;
    lastPosts = [];
    o.record?.({ kind: "chat", room: roomId, who: NAMES[sender] ?? sender, role: sender === FIXER || sender === VERIFIER ? "agent" : "person", text: forReading(body).replace(/\n/g, " "), refused: false, senderId: sender });
    o.print(`  ${c("2", `#${roomId}`)} ${c(sender === FIXER || sender === VERIFIER ? "35" : "32", NAMES[sender] ?? sender)}: ${forReading(body).replace(/\n/g, " ")}`);
    const msg: InboundMessage = { eventId: `demo-${seq}`, roomId, sequence: seq, messageId: `demo-${seq}`, sender, senderKind: null, onBehalfOf: null, senderRole: null, addressed: true, body, threadId: null, timestamp: seq };
    await router.handle(msg);
    recordState();
    await o.checkpoint?.();
  };
  const github_ = (text: string) => {
    o.record?.({ kind: "github", text });
    o.print(`  ${c("33", "[on GitHub, simulated]")} ${text}`);
  };
  const recordState = () => {
    const k = getCase(db, "LB-001");
    const head = k?.headSha ?? null;
    const ci = head === null ? undefined : latestCi(db, "LB-001", head, "test");
    o.record?.({
      kind: "state", state: k?.state ?? null, commit: head?.slice(0, 12) ?? null,
      ci: head === null ? null : ci === undefined || ci.status !== "completed" ? "waiting" : ci.conclusion === "success" ? "passed" : "failed",
      verifier: head === null ? null : latestRunForHead(db, "LB-001", head)?.status ?? "waiting",
      approvals: head === null ? 0 : new Set(listApprovals(db, "LB-001").filter((a) => a.headSha === head && a.decision === "approve").map((a) => a.approverId)).size,
    });
  };
  const scene = async (title: string) => {
    recordState();
    await o.checkpoint?.();
    o.record?.({ kind: "scene", title });
    o.print("");
    o.print(c("1", title));
    await o.pause?.();
  };
  const check = (claim: string, held: boolean) => {
    outcomes.push({ claim, held });
    o.record?.({ kind: "check", claim, held });
    o.print(`  ${held ? c("32", "✓") : c("31", "✗ DID NOT HAPPEN:")} ${claim}`);
  };
  const state = () => getCase(db, "LB-001")?.state;
  const lastRun = () => /Run id: ([0-9a-f-]{36})/.exec(lastPosts.join("\n"))?.[1] ?? "";
  const verifierReport = (runId: string, head: string, key = verifierKeys.privateKey) => {
    const report = { type: "verifier", runId, caseId: "LB-001", repository: REPO, pullRequest: 7, headSha: head, verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "Regression test fails on the base and passes on this commit." };
    return `Checked.\n\`\`\`loopback-report\n${JSON.stringify({ ...report, signature: signReport(report, key) })}\n\`\`\``;
  };

  o.print(c("1", "Loopback rehearsal: real gate logic, simulated Switch delivery, GitHub and agents."));

  await scene("1. A contributor reports a bug in the public room. No agent starts yet.");
  await say(REPORTER, `${G} report ${REPORT}`, INTAKE_ROOM);
  check("the report became case LB-001, waiting for a person", state() === "Reported");

  await scene("2. The same contributor tries to approve it from the public room.");
  await say(REPORTER, `${G} approve LB-001 ${COMMIT_A}`, INTAKE_ROOM);
  check("refused: nothing privileged exists in the public room", state() === "Reported" && lastPosts.some((p) => p.includes("REFUSED")));

  await scene("3. A maintainer checks the agents are there, then accepts. Now the fixer gets the task.");
  await say(MAINTAINER, `${G} team`);
  await say(MAINTAINER, `${G} accept LB-001`);
  check("a person's decision tasked the fixer, with the report fenced as untrusted data", state() === "FixInProgress" && lastPosts.some((p) => p.includes("~~~untrusted-report")));

  await scene("4. The fixer opens a PR. The gate believes GitHub, not the agent, about what was pushed.");
  github_(`the fixer opens PR #7 at ${COMMIT_A.slice(0, 12)}`);
  github.openPull(7, "loopback/LB-001", COMMIT_A);
  lastPosts = [];
  await poller.tick();
  const firstRun = lastRun();
  check("the gate recorded the full commit and asked the verifier about exactly that commit", state() === "Verifying" && lastPosts.some((p) => p.includes(COMMIT_A)));

  await scene("5. Asking why it can't merge shows every requirement at once.");
  await say(MAINTAINER, `${G} why LB-001`);
  check("the checklist shows the missing evidence and does not say it is ready", lastPosts.some((p) => p.includes("⏳")) && !lastPosts.some((p) => p.includes(`${G} merge`)));

  await scene("6. Someone forges a passing verifier report. It is signed, but with the wrong key.");
  await say(VERIFIER, verifierReport(firstRun, COMMIT_A, forgedKeys.privateKey));
  check("refused: the signature does not match the verifier's key, and the run stays open", state() === "Verifying" && lastPosts.some((p) => p.includes("VERIFIER_SIGNATURE_INVALID")));

  await scene("7. CI passes and the real verifier reports. Only now is a person asked to approve.");
  github_(`CI passes on ${COMMIT_A.slice(0, 12)}`);
  github.finishCi(COMMIT_A, 100);
  await say(VERIFIER, verifierReport(firstRun, COMMIT_A));
  await poller.tick();
  check("the case waits for a person, with the evidence bound to one commit", state() === "AwaitingApproval");

  await scene("8. An agent tries to merge its own work. So does someone who isn't a maintainer.");
  await say(FIXER, `${G} merge LB-001`);
  await say(STRANGER, `${G} merge LB-001`);
  check("neither got anywhere: agents have no commands, and strangers no authority", state() === "AwaitingApproval" && mergeCalls === 0);

  await scene("9. The maintainer approves the wrong commit by mistake.");
  await say(MAINTAINER, `${G} approve LB-001 ${WRONG_SHA}`);
  check("refused: an approval names one exact commit, and that isn't the one on the PR", state() === "AwaitingApproval" && lastPosts.some((p) => p.includes("APPROVAL_SHA_MISMATCH")));

  await scene("10. The maintainer approves the right commit.");
  await say(MAINTAINER, `${G} approve LB-001 ${COMMIT_A}`);
  check("approved, and ready to merge", state() === "ReadyToMerge");

  await scene("11. THE POINT OF LOOPBACK. A new commit lands after the approval, then someone says merge.");
  github_(`another commit lands on the PR's branch: ${COMMIT_B.slice(0, 12)}`);
  github.pushCommit(7, COMMIT_B);
  await say(MAINTAINER, `${G} merge LB-001`);
  const secondRun = lastRun();
  check("no merge: the gate re-read GitHub, saw the new commit and threw the old evidence away", mergeCalls === 0 && state() === "Verifying" && secondRun !== "" && secondRun !== firstRun);
  check("the code nobody reviewed did not reach the base branch", github.statuses.length === 0);

  await scene("12. The same question now gives a different answer, because the commit changed.");
  await say(MAINTAINER, `${G} why LB-001`);
  check("the approval shows as stale, and CI, verifier and approval must all be earned again", lastPosts.some((p) => p.includes("older commit")));

  await scene("13. The new commit earns its own evidence, and the maintainer approves it.");
  github_(`CI passes on ${COMMIT_B.slice(0, 12)}`);
  github.finishCi(COMMIT_B, 101);
  await say(VERIFIER, verifierReport(secondRun, COMMIT_B));
  await poller.tick();
  await say(MAINTAINER, `${G} approve LB-001 ${COMMIT_B}`);
  check("approved again, for the new commit only", state() === "ReadyToMerge");

  await scene("14. Merge. The gate re-checks everything live, merges that exact commit, then confirms with GitHub.");
  await say(MAINTAINER, `${G} merge LB-001`);
  check("merged once, by the gate, only after every check passed on the same commit", mergeCalls === 1 && github.statuses.some((s) => s.sha === COMMIT_B && s.state === "success"));
  await executor.reconcileUnknown();
  check("GitHub's own answer closed the case", state() === "Merged");

  const boardFacts = { db, requiredChecks: ["test"], quorum: 1, maintainers, gateMention: G };
  await scene("15. What the whole room can read: the gate's documents, kept in the Switch room.");
  o.print("Loopback case board");
  o.print(renderCaseTable(boardFacts));
  o.print("");
  o.print("Loopback decision log (newest first)");
  o.print(renderDecisionTable(db));
  o.record?.({ kind: "tables", board: renderCaseTable(boardFacts), decisions: renderDecisionTable(db) });
  recordState();
  await o.checkpoint?.();

  const passed = outcomes.every((x) => x.held);
  o.print("");
  o.print(c(passed ? "32;1" : "31;1", `${outcomes.filter((x) => x.held).length} of ${outcomes.length} expected outcomes observed. ${passed ? "Rehearsal passed." : "REHEARSAL FAILED."}`));
  return { db, outcomes, passed };
}
