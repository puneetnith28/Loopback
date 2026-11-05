/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import type { InboundMessage } from "@loopback/contracts";
import { vi } from "vitest";
import { CaseLocks } from "../../apps/switch-gate/src/cases/lock.js";
import { MergeExecutor } from "../../apps/switch-gate/src/cases/service.js";
import { Router } from "../../apps/switch-gate/src/commands/router.js";
import { GitHubError, RateLimited, type CheckRunDetails, type GitHubReader, type PullDetails } from "../../apps/switch-gate/src/github/client.js";
import type { Merger } from "../../apps/switch-gate/src/github/merge.js";
import { migrate, openDatabase, type Db } from "../../apps/switch-gate/src/persistence/db.js";
import { getCase, kvSet } from "../../apps/switch-gate/src/persistence/repos.js";
import type { BaseProtection, LiveSnapshot } from "../../apps/switch-gate/src/policy/evaluate.js";
import { Poller } from "../../apps/switch-gate/src/workflow/poller.js";
import { VerificationWorkflow, type WorkflowDeps } from "../../apps/switch-gate/src/workflow/verification.js";
import { HaltSwitch } from "../../apps/switch-gate/src/cases/halt.js";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { signReport } from "../../apps/switch-gate/src/agents/signature.js";
import { renderTeam, type RoomStatuses } from "../../apps/switch-gate/src/switch/team.js";

/** Test-only verifier signing key, generated per test process (D28). Never persisted. */
export const TEST_VERIFIER_KEYS = generateKeyPairSync("ed25519");
/** Sign a verifier report with the test verifier key (as the D29 signer service would). */
/** D29: the gate's run-issuer key in tests. */
export const TEST_ISSUER_KEYS = generateKeyPairSync("ed25519");

export const signTestReport = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, signature: signReport(r, TEST_VERIFIER_KEYS.privateKey) });

export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const BASE = "c".repeat(40);
export const MAINT = "@switch-user-maint:x";
export const MAINT2 = "@switch-user-maint2:x";
export const REP = "@switch-user-rep:x";
export const OUT = "@switch-user-out:x";
export const FIXER = "@switch-agent-fixer:x";
export const VERIFIER = "@switch-agent-verifier:x";
export const SELF = "@switch-agent-gate:x";
export const G = "@loopback-gate";
export const REPO = "o/r";
/** The maintainers' room (D26); harness messages default to it. */
export const MROOM = "room";
/** The public intake room (D26). */
export const IROOM = "intake-room";

/** A scriptable GitHub for tests. Mutate its fields to simulate GitHub state and failures. */
export class FakeGitHub implements GitHubReader {
  pulls = new Map<number, PullDetails>();
  checks = new Map<string, CheckRunDetails[]>();
  files = new Map<number, string[]>();
  rules: BaseProtection = {
    requiredStatusChecks: [
      { context: "test", integrationId: 1 },
      { context: "loopback/gate", integrationId: 100 },
    ],
    requiresPullRequest: true,
    requiresUpToDate: true,
    blocksForcePush: true,
    restrictsDeletion: true,
  };
  branchHead = BASE;
  statuses: { sha: string; state: string; description: string }[] = [];
  failGetPull = false;
  rateLimited = false;
  failStatus = false;
  /** Called after each getPull; lets a test move the head mid-flow. */
  onGetPull: ((n: number) => void) | null = null;

  private gate(): void {
    if (this.rateLimited) throw new RateLimited("rate limited", 429, 60);
  }

  setPull(n: number, over: Partial<PullDetails> = {}): void {
    this.pulls.set(n, {
      number: n, state: "open", draft: false, merged: false, mergeable: true, headSha: A, headRef: "loopback/LB-001",
      headRepo: REPO, baseRef: "main", baseSha: BASE, mergeCommitSha: null, ...this.pulls.get(n), ...over,
    });
  }
  pass(sha: string, conclusion = "success", id = 100): void {
    this.checks.set(sha, [{ id, name: "test", appSlug: "github-actions", status: "completed", conclusion, headSha: sha, htmlUrl: "u" }]);
  }

  async getPull(n: number): Promise<PullDetails> {
    this.gate();
    if (this.failGetPull) throw new GitHubError("unavailable", 503);
    const p = this.pulls.get(n);
    if (!p) throw new GitHubError("not found", 404);
    const snapshot = { ...p };
    this.onGetPull?.(n);
    return snapshot;
  }
  async findOpenPullByBranch(branch: string): Promise<PullDetails | undefined> {
    this.gate();
    return [...this.pulls.values()].find((p) => p.headRef === branch && p.state === "open");
  }
  async listCheckRuns(sha: string): Promise<CheckRunDetails[]> {
    this.gate();
    return this.checks.get(sha) ?? [];
  }
  async listPullFiles(n: number): Promise<string[] | undefined> {
    return this.files.get(n) ?? ["slugify.js", "test/slugify.js"];
  }
  async getBranchRules(): Promise<BaseProtection> {
    return this.rules;
  }
  async getBranchHead(): Promise<string> {
    this.gate();
    return this.branchHead;
  }
  async setGateStatus(sha: string, state: "success" | "failure" | "pending" | "error", description: string): Promise<void> {
    if (this.failStatus) throw new GitHubError("status failed", 500);
    this.statuses.push({ sha, state, description });
  }
  async snapshot(n: number): Promise<{ snapshot: LiveSnapshot; pull: PullDetails | undefined }> {
    this.gate();
    try {
      const before = await this.getPull(n);
      const after = await this.getPull(n);
      return {
        pull: after,
        snapshot: {
          repo: REPO, prNumber: n, pr: after, checks: await this.listCheckRuns(before.headSha),
          baseProtection: await this.getBranchRules(), changedFiles: await this.listPullFiles(n), changedFilesHeadSha: before.headSha,
        },
      };
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      return { pull: undefined, snapshot: { repo: REPO, prNumber: n, pr: undefined, checks: undefined, baseProtection: undefined, changedFiles: undefined, changedFilesHeadSha: undefined } };
    }
  }
}

export interface Harness {
  db: Db;
  gh: FakeGitHub;
  posts: string[];
  /** Every post with its room, in order. */
  roomPosts: { room: string; content: string }[];
  /** Set to make posts to a room fail (simulates a stopped connection or a Switch 5xx). */
  failPostsTo: { room: string | null };
  merger: ReturnType<typeof vi.fn<Merger>>;
  router: Router;
  wf: VerificationWorkflow;
  poller: Poller;
  exec: MergeExecutor;
  halt: HaltSwitch;
  clock: { now: Date };
  say(sender: string, body: string, over?: Partial<InboundMessage>): Promise<void>;
  lastRunId(): string;
  lastCapability(): string;
  verifierReply(verdict: "pass" | "fail", over?: Record<string, unknown>): Promise<void>;
  driveToAwaitingApproval(): Promise<void>;
  driveToReady(): Promise<void>;
  state(id?: string): string | undefined;
}

export function createHarness(opts: { db?: Db; gh?: FakeGitHub; runIssuerKey?: KeyObject | null; verifierPublicKey?: KeyObject | null; verificationAdvisory?: boolean; intakeMaxReportsPerHour?: number; mergeEnabled?: boolean; expectedBase?: string | null; quorum?: number; retryLimit?: number; maxAttempts?: number; privilegedEnabled?: boolean; roomStatuses?: RoomStatuses } = {}): Harness {
  const db = opts.db ?? openDatabase(":memory:");
  migrate(db);
  const gh = opts.gh ?? new FakeGitHub();
  const posts: string[] = [];
  const roomPosts: { room: string; content: string }[] = [];
  const failPostsTo: { room: string | null } = { room: null };
  const clock = { now: new Date("2026-11-05T10:00:00Z") };
  const now = () => new Date(clock.now);
  const chat = {
    post: async (room: string, content: string) => {
      if (failPostsTo.room === room) throw new Error("post failed");
      posts.push(content);
      roomPosts.push({ room, content });
    },
  };
  const locks = new CaseLocks();
  const halt = new HaltSwitch();
  const maintainers = new Set([MAINT, MAINT2]);
  const wfDeps: WorkflowDeps = {
    db, chat, github: gh, locks, now, repo: REPO, baseBranch: "main", requiredChecks: ["test"],
    checkSources: new Map([["test", "github-actions"]]), gateMention: G, fixerAlias: "@loopback-fixer",
    verifierAlias: "@loopback-verifier", verifyTimeoutMs: 600_000, fixTimeoutMs: 2_700_000, halt,
    verificationAdvisory: opts.verificationAdvisory ?? false,
    // Isolated mode (the default here) checks signatures against the test key.
    verifierPublicKey: opts.verifierPublicKey === undefined ? TEST_VERIFIER_KEYS.publicKey : opts.verifierPublicKey,
    expectedBaseSha: () => opts.expectedBase ?? null,
    runIssuerKey: opts.runIssuerKey === undefined ? TEST_ISSUER_KEYS.privateKey : opts.runIssuerKey,
    ...(opts.roomStatuses === undefined ? {} : { roomStatuses: opts.roomStatuses }),
  };
  const wf = new VerificationWorkflow(wfDeps);
  const poller = new Poller(wfDeps, wf, { warn: () => undefined });
  const merger = vi.fn<Merger>(async (n) => {
    gh.setPull(n, { merged: true, state: "closed", mergeCommitSha: "d".repeat(40) });
    return { merged: true, sha: "d".repeat(40) };
  });
  const exec = new MergeExecutor({
    db, chat, github: gh, merger, locks, now, mergeEnabled: opts.mergeEnabled ?? true, configComplete: true, halt,
    transientRetryLimit: opts.retryLimit ?? 3, mergeMaxAttempts: opts.maxAttempts ?? 2,
    policy: {
      baseBranch: "main",
      requiredChecks: ["test"],
      checkSources: new Map([["test", "github-actions"]]),
      requiredCheckIntegrations: new Map([["test", 1], ["loopback/gate", 100]]),
      gateStatusContext: "loopback/gate",
      maintainers,
      quorum: opts.quorum ?? 1,
    },
    requestVerification: (id) => wf.requestVerificationLocked(id, "system", false),
    onMergeConfirmed: (sha) => kvSet(db, "expected_base_sha", sha),
    gateMention: G, verificationAdvisory: opts.verificationAdvisory ?? false,
  });
  const router = new Router({
    db, chat, repo: REPO, quorum: opts.quorum ?? 1, requiredChecks: ["test"],
    admission: { selfId: SELF, fixerId: FIXER, verifierId: VERIFIER, gateMention: G, maintainerRoomId: MROOM, intakeRoomId: IROOM },
    intakeMaxReportsPerHour: opts.intakeMaxReportsPerHour ?? 3,
    identity: { maintainers, reporters: new Set([REP]), privilegedEnabled: opts.privilegedEnabled ?? true },
    privileged: {
      verify: (ctx, id) => wf.verifyCommand(ctx, id),
      approve: (ctx, id, sha) => wf.approve(ctx, id, sha),
      reject: (ctx, id, reason) => wf.reject(ctx, id, reason),
      retask: (ctx, id, note) => wf.retask(ctx, id, note),
      merge: (ctx, id) => exec.merge(ctx.msg.sender, id),
    },
    views: {
      why: (id) => exec.why(id),
      team: async () => ({ text: renderTeam(["loopback-fixer", "loopback-verifier", "loopback-gate"], opts.roomStatuses === undefined ? null : await opts.roomStatuses()), caseId: null }),
    },
    handoff: wf, agents: wf, now,
  });
  let seq = 0;
  const say = async (sender: string, body: string, over: Partial<InboundMessage> = {}) => {
    seq += 1;
    await router.handle({ eventId: `e${seq}`, roomId: MROOM, sequence: seq, messageId: `e${seq}`, sender, senderKind: null, onBehalfOf: null, senderRole: null, addressed: true, body, threadId: null, timestamp: seq, ...over });
  };
  const lastRunId = () => {
    const m = [...posts].reverse().map((p) => /Run id: ([0-9a-f-]{36})/.exec(p)).find(Boolean);
    if (!m) throw new Error("no verification request posted");
    return m[1]!;
  };
  const lastCapability = () => {
    const m = [...posts].reverse().map((p) => /Signing capability: (lbcap1\.[A-Za-z0-9_.-]+)/.exec(p)).find(Boolean);
    if (!m) throw new Error("no capability posted");
    return m[1]!;
  };
  const h: Harness = {
    db, gh, posts, roomPosts, failPostsTo, merger, router, wf, poller, exec, halt, clock, say, lastRunId, lastCapability,
    state: (id = "LB-001") => getCase(db, id)?.state,
    async verifierReply(verdict, over = {}) {
      const c = getCase(db, "LB-001")!;
      const base: Record<string, unknown> = { type: "verifier", runId: lastRunId(), caseId: "LB-001", repository: REPO, pullRequest: c.prNumber, headSha: c.headSha, verdict, regressionTestFailsBeforeFix: true, findings: [], summary: "checked", ...over };
      // Signed with the test verifier key unless the test sets `signature` itself
      // (`signature: undefined` sends an unsigned report).
      const report = "signature" in over
        ? Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined))
        : signTestReport(base);
      await say(VERIFIER, "Summary.\n```loopback-report\n" + JSON.stringify(report) + "\n```");
    },
    async driveToAwaitingApproval() {
      await say(REP, `${G} report slugify.extend({'%': null}) throws a TypeError`);
      gh.setPull(42);
      gh.pass(A);
      await poller.tick(); // FixInProgress -> PRCreated -> Verifying, verifier asked
      await h.verifierReply("pass");
      await poller.tick(); // CI evidence -> AwaitingApproval
    },
    async driveToReady() {
      await h.driveToAwaitingApproval();
      await say(MAINT, `${G} approve LB-001 ${A}`);
    },
  };
  return h;
}
