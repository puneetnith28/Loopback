import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { HaltSwitch } from "./cases/halt.js";
import { admissionPolicyOf } from "./startup.js";
import { CaseLocks } from "./cases/lock.js";
import { MergeExecutor } from "./cases/service.js";
import type { ChatPort } from "./chat/port.js";
import { formatReason } from "./chat/reasons.js";
import { Router } from "./commands/router.js";
import { assertIdentityConsistency, loadRunIssuerKey, type GitHubConfig, type IdentityConfig, type RuntimeConfig, type SwitchConfig } from "./config.js";
import { GitHubClient } from "./github/client.js";
import { createMerger } from "./github/merge.js";
import { GitHubTransport } from "./github/transport.js";
import { migrate, openDatabase, type Db } from "./persistence/db.js";
import { kvGet, kvSet, listUnfinishedMergeOps } from "./persistence/repos.js";
import { RoomBoard, type RoomBoardDeps } from "./switch/board.js";
import { agentName, renderTeam, type RoomStatuses } from "./switch/team.js";
import { Poller } from "./workflow/poller.js";
import { VerificationWorkflow, type WorkflowDeps } from "./workflow/verification.js";

export interface GateConfig {
  readonly runtime: RuntimeConfig;
  readonly github: GitHubConfig;
  readonly identity: IdentityConfig;
  readonly switch: SwitchConfig;
}

export interface Gate {
  readonly db: Db;
  readonly router: Router;
  readonly poller: Poller;
  readonly workflow: VerificationWorkflow;
  readonly executor: MergeExecutor;
  /** The GitHub client, for readiness (rate limit) only outside the composition root. */
  readonly github: GitHubClient;
  /** One-way halt shared by privileged operations; set when the Switch policy fails. */
  readonly halt: HaltSwitch;
  /** Reconcile interrupted merges and open cases, then start polling and sweeping. */
  start(): Promise<void>;
  /**
   * Reconcile every open case and interrupted merge against GitHub now (step 8.9): at
   * startup and after Switch reports a delivery gap. Never merges (D15).
   */
  reconcileNow(): Promise<void>;
  /** D17(d): compare the base branch with its expected commit until there is a definite answer. */
  checkBaseIntegrity(): Promise<void>;
  /**
   * Stop scheduling background work and wait for any task already running (poll,
   * reconcile, sweep, triage notices) to finish. Call before stop(), so no task can run
   * against a closed database (step 9.7, residual risk 6).
   */
  drain(): Promise<void>;
  stop(): void;
}

/** Build the gate from validated configuration and a chat transport (composition root). */
export function createGate(cfg: GateConfig, chat: ChatPort, log: Logger, deps: {
  github?: GitHubClient;
  now?: () => Date;
  /** D34: Switch's view of the agents in the maintainers' room. */
  roomStatuses?: RoomStatuses;
  /** D34: what the gate needs to keep its documents in the maintainers' room. */
  roomDocs?: Pick<RoomBoardDeps, "connectionId" | "call">;
} = {}): Gate {
  const now = deps.now ?? (() => new Date());
  assertIdentityConsistency(cfg.switch, cfg.identity);
  const db = openDatabase(cfg.runtime.dbPath);
  migrate(db);
  const transport = new GitHubTransport({
    appId: cfg.github.appId, installationId: cfg.github.installationId,
    privateKeyPem: readFileSync(cfg.github.privateKeyPath, "utf8"),
  });
  const github = deps.github ?? new GitHubClient(transport, cfg.github.repo, cfg.github.gateStatusContext);
  const locks = new CaseLocks();
  const halt = new HaltSwitch();
  const gateMention = cfg.switch.gateMention;
  const expectedBaseSha = () => (cfg.github.demoResetSha === null ? null : kvGet(db, "expected_base_sha") ?? cfg.github.demoResetSha);

  const wfDeps: WorkflowDeps = {
    db, chat, github, locks, now, repo: cfg.github.repo, baseBranch: cfg.github.baseBranch,
    requiredChecks: cfg.github.requiredChecks, checkSources: cfg.github.checkSources, gateMention,
    fixerAlias: cfg.identity.fixerAlias, verifierAlias: cfg.identity.verifierAlias,
    verifyTimeoutMs: cfg.runtime.verifyTimeoutMs, fixTimeoutMs: cfg.runtime.fixTimeoutMs, expectedBaseSha, halt,
    verificationAdvisory: !cfg.identity.verifierIsolationProven,
    verifierPublicKey: cfg.identity.verifierPublicKey,
    runIssuerKey: cfg.identity.runIssuerKeyPath === null ? null : loadRunIssuerKey(cfg.identity.runIssuerKeyPath),
    ...(deps.roomStatuses === undefined ? {} : { roomStatuses: deps.roomStatuses }),
    log: { error: (o, m) => log.error(o, m) },
  };
  const workflow = new VerificationWorkflow(wfDeps);
  const poller = new Poller(wfDeps, workflow, { warn: (o, m) => log.warn(o, m) });
  const executor = new MergeExecutor({
    db, chat, github, merger: createMerger(transport, cfg.github.repo), locks, now,
    mergeEnabled: cfg.runtime.mergeEnabled, halt,
    // Merging needs privileged commands explicitly enabled and at least one maintainer.
    configComplete: cfg.identity.privilegedEnabled && cfg.identity.maintainers.size > 0,
    transientRetryLimit: cfg.runtime.transientRetryLimit, mergeMaxAttempts: cfg.runtime.mergeMaxAttempts,
    policy: {
      baseBranch: cfg.github.baseBranch, requiredChecks: cfg.github.requiredChecks, checkSources: cfg.github.checkSources,
      requiredCheckIntegrations: cfg.github.requiredCheckIntegrations,
      gateStatusContext: cfg.github.gateStatusContext, maintainers: cfg.identity.maintainers, quorum: cfg.runtime.quorum,
    },
    requestVerification: (id) => workflow.requestVerificationLocked(id, "system", false),
    onMergeConfirmed: (sha) => { if (cfg.github.demoResetSha !== null) kvSet(db, "expected_base_sha", sha); },
    gateMention, verificationAdvisory: !cfg.identity.verifierIsolationProven,
    log: { warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) },
  });
  const board = deps.roomDocs === undefined ? null : new RoomBoard({
    db, requiredChecks: cfg.github.requiredChecks, quorum: cfg.runtime.quorum, maintainers: cfg.identity.maintainers,
    gateMention, now, ...deps.roomDocs, log: { warn: (o, m) => log.warn(o, m) },
    notify: (text) => chat.post(cfg.switch.roomId, text, null),
  });
  const router = new Router({
    db, chat, repo: cfg.github.repo, quorum: cfg.runtime.quorum, requiredChecks: cfg.github.requiredChecks,
    admission: admissionPolicyOf(cfg),
    intakeMaxReportsPerHour: cfg.identity.intakeMaxReportsPerHour,
    identity: {
      maintainers: cfg.identity.maintainers, reporters: cfg.identity.reporters,
      privilegedEnabled: cfg.identity.privilegedEnabled,
    },
    privileged: {
      verify: (ctx, id) => workflow.verifyCommand(ctx, id),
      approve: (ctx, id, sha) => workflow.approve(ctx, id, sha),
      reject: (ctx, id, reason) => workflow.reject(ctx, id, reason),
      retask: (ctx, id, note) => workflow.retask(ctx, id, note),
      merge: (ctx, id) => executor.merge(ctx.msg.sender, id),
    },
    views: {
      why: (id) => executor.why(id),
      team: async () => ({
        text: renderTeam([cfg.identity.fixerAlias, cfg.identity.verifierAlias, gateMention].map(agentName), deps.roomStatuses === undefined ? null : await deps.roomStatuses()),
        caseId: null,
      }),
    },
    handoff: workflow, agents: workflow, now,
    log: { error: (o, m) => log.error(o, m) },
  });

  // D17(d): a base branch that is not at the expected commit keeps merges disabled for the whole
  // run. Only a definite answer decides: GitHub being unreachable says nothing about the base, and
  // a merge whose outcome is still unknown may have moved it legitimately, so both wait for a
  // later check. The maintainers' notice may also have to wait, for the rooms to connect.
  let baseVerdict: "pending" | "ok" | "mismatch" = cfg.github.demoResetSha === null ? "ok" : "pending";
  let baseNoticeSent = false;
  const checkBaseIntegrity = async () => {
    if (baseVerdict === "pending" && listUnfinishedMergeOps(db).length === 0) {
      const problem = await workflow.baseProblem();
      if (problem === null) {
        baseVerdict = "ok";
      } else if (problem === "BASE_COMMIT_MISMATCH") {
        baseVerdict = "mismatch";
        halt.halt("BASE_COMMIT_MISMATCH: the base branch is not at its expected commit");
        log.fatal({ op: "base.integrity", reasonCode: problem, baseBranch: cfg.github.baseBranch }, "BASE_COMMIT_MISMATCH: the base branch is not at its expected commit; merging is disabled for this run");
      }
    }
    if (baseVerdict === "mismatch" && !baseNoticeSent) {
      try {
        await chat.post(cfg.switch.roomId, formatReason("BASE_COMMIT_MISMATCH", {}), null);
        baseNoticeSent = true;
      } catch (e) {
        log.warn({ op: "base.integrity", err: e instanceof Error ? e.name : "unknown" }, "could not post the base mismatch notice yet; will retry");
      }
    }
  };

  const timers: NodeJS.Timeout[] = [];
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  const every = (ms: number, op: string, fn: () => Promise<void>) => {
    if (stopping) return; // draining has begun (e.g. a signal during start): schedule nothing
    timers.push(setInterval(() => {
      if (stopping) return;
      const task = fn()
        .catch((e: unknown) => log.error({ op, err: e instanceof Error ? e.name : "unknown" }, "background task failed"))
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }, ms));
  };

  return {
    db, router, poller, workflow, executor, halt, github, checkBaseIntegrity,
    async reconcileNow() {
      await poller.tick();
      await executor.reconcileUnknown();
    },
    async start() {
      await executor.reconcileStartup();
      // Open cases too, before any new command is handled; a GitHub outage here is logged
      // and retried by the periodic tasks rather than preventing startup.
      try {
        await this.reconcileNow();
      } catch (e) {
        log.error({ op: "reconcile.startup", err: e instanceof Error ? e.name : "unknown" }, "startup reconciliation of open cases failed; will retry");
      }
      await checkBaseIntegrity();
      try {
        await router.announcePendingTriage();
      } catch (e) {
        log.error({ op: "triage.startup", err: e instanceof Error ? e.name : "unknown" }, "re-sending pending triage notices failed; will retry");
      }
      every(cfg.runtime.pollIntervalMs, "poll", () => poller.tick());
      every(cfg.runtime.pollIntervalMs, "triage", () => router.announcePendingTriage());
      every(cfg.runtime.pollIntervalMs, "reconcile", () => executor.reconcileUnknown());
      every(cfg.runtime.pollIntervalMs, "base", checkBaseIntegrity);
      if (board !== null) every(cfg.runtime.pollIntervalMs, "board", () => board.sync());
      every(Math.max(10_000, Math.floor(cfg.runtime.verifyTimeoutMs / 10)), "sweep", () => workflow.sweep());
    },
    async drain() {
      stopping = true;
      for (const t of timers) clearInterval(t);
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      await workflow.noticesSettled();
    },
    stop() {
      stopping = true;
      for (const t of timers) clearInterval(t);
      if (inFlight.size > 0) log.warn({ op: "stop", running: inFlight.size }, "closing the database while background tasks still run; call drain() first");
      db.close();
    },
  };
}
