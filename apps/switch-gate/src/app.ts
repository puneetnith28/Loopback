import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { CaseLocks } from "./cases/lock.js";
import { MergeExecutor } from "./cases/service.js";
import type { ChatPort } from "./chat/port.js";
import { Router } from "./commands/router.js";
import type { GitHubConfig, IdentityConfig, RuntimeConfig, SwitchConfig } from "./config.js";
import { GitHubClient } from "./github/client.js";
import { createMerger } from "./github/merge.js";
import { GitHubTransport } from "./github/transport.js";
import { migrate, openDatabase, type Db } from "./persistence/db.js";
import { kvGet, kvSet } from "./persistence/repos.js";
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
  /** Reconcile interrupted merges, then start polling and sweeping. */
  start(): Promise<void>;
  stop(): void;
}

/** Build the gate from validated configuration and a chat transport (composition root). */
export function createGate(cfg: GateConfig, chat: ChatPort, log: Logger, deps: { github?: GitHubClient; now?: () => Date } = {}): Gate {
  const now = deps.now ?? (() => new Date());
  const db = openDatabase(cfg.runtime.dbPath);
  migrate(db);
  const transport = new GitHubTransport({
    appId: cfg.github.appId, installationId: cfg.github.installationId,
    privateKeyPem: readFileSync(cfg.github.privateKeyPath, "utf8"),
  });
  const github = deps.github ?? new GitHubClient(transport, cfg.github.repo, cfg.github.gateStatusContext);
  const locks = new CaseLocks();
  const gateMention = cfg.switch.gateMention;
  const expectedBaseSha = () => (cfg.github.demoResetSha === null ? null : kvGet(db, "expected_base_sha") ?? cfg.github.demoResetSha);

  const wfDeps: WorkflowDeps = {
    db, chat, github, locks, now, repo: cfg.github.repo, baseBranch: cfg.github.baseBranch,
    requiredChecks: cfg.github.requiredChecks, checkSources: cfg.github.checkSources, gateMention,
    fixerAlias: cfg.identity.fixerAlias, verifierAlias: cfg.identity.verifierAlias,
    verifyTimeoutMs: cfg.runtime.verifyTimeoutMs, fixTimeoutMs: cfg.runtime.fixTimeoutMs, expectedBaseSha,
    log: { error: (o, m) => log.error(o, m) },
  };
  const workflow = new VerificationWorkflow(wfDeps);
  const poller = new Poller(wfDeps, workflow, { warn: (o, m) => log.warn(o, m) });
  const executor = new MergeExecutor({
    db, chat, github, merger: createMerger(transport, cfg.github.repo), locks, now,
    mergeEnabled: cfg.runtime.mergeEnabled,
    // Privileged commands are refused until sender attribution is verified (D16).
    configComplete: cfg.switch.humanSenderKind !== null,
    transientRetryLimit: cfg.runtime.transientRetryLimit, mergeMaxAttempts: cfg.runtime.mergeMaxAttempts,
    policy: {
      baseBranch: cfg.github.baseBranch, requiredChecks: cfg.github.requiredChecks, checkSources: cfg.github.checkSources,
      gateStatusContext: cfg.github.gateStatusContext, maintainers: cfg.identity.maintainers, quorum: cfg.runtime.quorum,
    },
    requestVerification: (id) => workflow.requestVerificationLocked(id, "system", false),
    onMergeConfirmed: (sha) => { if (cfg.github.demoResetSha !== null) kvSet(db, "expected_base_sha", sha); },
    log: { warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) },
  });
  const router = new Router({
    db, chat, gateMention, repo: cfg.github.repo, quorum: cfg.runtime.quorum, requiredChecks: cfg.github.requiredChecks,
    fixerId: cfg.identity.fixerId, verifierId: cfg.identity.verifierId,
    identity: {
      maintainers: cfg.identity.maintainers, reporters: cfg.identity.reporters,
      agentSenders: new Set([cfg.identity.fixerId, cfg.identity.verifierId, cfg.switch.selfId]),
      humanSenderKind: cfg.switch.humanSenderKind,
    },
    privileged: {
      verify: (ctx, id) => workflow.verifyCommand(ctx, id),
      approve: (ctx, id, sha) => workflow.approve(ctx, id, sha),
      reject: (ctx, id, reason) => workflow.reject(ctx, id, reason),
      retask: (ctx, id, note) => workflow.retask(ctx, id, note),
      merge: (ctx, id) => executor.merge(ctx.msg.sender, id),
    },
    handoff: workflow, agents: workflow, now,
  });

  const timers: NodeJS.Timeout[] = [];
  let stopping = false;
  const every = (ms: number, op: string, fn: () => Promise<void>) => {
    timers.push(setInterval(() => {
      if (stopping) return;
      fn().catch((e: unknown) => log.error({ op, err: e instanceof Error ? e.name : "unknown" }, "background task failed"));
    }, ms));
  };

  return {
    db, router, poller, workflow, executor,
    async start() {
      await executor.reconcileStartup();
      every(cfg.runtime.pollIntervalMs, "poll", () => poller.tick());
      every(cfg.runtime.pollIntervalMs, "reconcile", () => executor.reconcileUnknown());
      every(Math.max(10_000, Math.floor(cfg.runtime.verifyTimeoutMs / 10)), "sweep", () => workflow.sweep());
    },
    stop() {
      stopping = true;
      for (const t of timers) clearInterval(t);
      db.close();
    },
  };
}
