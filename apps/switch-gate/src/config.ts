import { statSync } from "node:fs";
import { z } from "zod";
import { FullSha, ParticipantId, RepoSlug } from "@loopback/contracts";

/**
 * Configuration is validated per capability group, when the component that consumes
 * the group starts (D7). A failing group disables its feature; it never yields a
 * partially valid group. Errors name the variable and never contain its value.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(group: string, issues: readonly ConfigIssue[]) {
    super(`Invalid ${group} configuration: ${issues.map((i) => `${i.variable} (${i.message})`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const nonEmpty = z.string().trim().min(1, "required");
const idList = z.string().trim().min(1, "required").transform((s, ctx) => {
  const ids = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.includes("*")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "wildcard is not allowed; list explicit participant ids" });
    return z.NEVER;
  }
  for (const id of ids) {
    if (!ParticipantId.safeParse(id).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each entry must be a participant id" });
      return z.NEVER;
    }
  }
  return new Set(ids);
});
const positiveInt = (fallback: number) =>
  z.string().optional().transform((s, ctx) => {
    if (s === undefined || s.trim() === "") return fallback;
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a positive integer" });
      return z.NEVER;
    }
    return n;
  });
const bool = (fallback: boolean) =>
  z.string().optional().transform((s, ctx) => {
    if (s === undefined || s.trim() === "") return fallback;
    if (s === "true") return true;
    if (s === "false") return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be true or false" });
    return z.NEVER;
  });

// ---------------------------------------------------------------------------

const SwitchSchema = z.object({
  SWITCH_BRIDGE_URL: z.string().url("must be a URL"),
  SWITCH_AGENT_ID: nonEmpty,
  SWITCH_AGENT_API_KEY: nonEmpty,
  SWITCH_ROOM_ID: nonEmpty,
  SWITCH_SELF_ID: ParticipantId,
  SWITCH_HUMAN_SENDER_KIND: z.string().trim().optional().transform((s) => (s ? s : null)),
});

export interface SwitchConfig {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly roomId: string;
  readonly selfId: string;
  /** Verified human sender_kind; null keeps privileged commands disabled (D16). */
  readonly humanSenderKind: string | null;
}

const IdentitySchema = z.object({
  LOOPBACK_MAINTAINERS: idList,
  LOOPBACK_REPORTERS: idList,
  LOOPBACK_FIXER_ID: ParticipantId,
  LOOPBACK_VERIFIER_ID: ParticipantId,
  LOOPBACK_FIXER_ALIAS: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/).default("@loopback-fixer"),
  LOOPBACK_VERIFIER_ALIAS: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/).default("@loopback-verifier"),
});

export interface IdentityConfig {
  readonly maintainers: ReadonlySet<string>;
  readonly reporters: ReadonlySet<string>;
  readonly fixerId: string;
  readonly verifierId: string;
  readonly fixerAlias: string;
  readonly verifierAlias: string;
}

const DEMO_RUN_ID = /^\d{8}-[0-9a-f]{16}$/;

const GitHubSchema = z.object({
  GH_REPO: RepoSlug,
  GH_APP_ID: z.string().regex(/^\d+$/, "must be numeric"),
  GH_APP_INSTALLATION_ID: z.string().regex(/^\d+$/, "must be numeric"),
  GH_APP_PRIVATE_KEY_PATH: nonEmpty,
  BASE_BRANCH: z.string().trim().min(1).regex(/^[A-Za-z0-9._/-]+$/, "invalid branch name"),
  REQUIRED_CHECKS: nonEmpty,
  CHECK_SOURCES: nonEmpty,
  GATE_STATUS_CONTEXT: z.string().trim().min(1).default("loopback/gate"),
  DEMO_RUN_ID: z.string().trim().optional().transform((s) => (s ? s : null)),
  DEMO_RESET_SHA: z.string().trim().optional().transform((s) => (s ? s : null)),
});

export interface GitHubConfig {
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyPath: string;
  readonly baseBranch: string;
  readonly requiredChecks: readonly string[];
  /** check name -> expected app slug */
  readonly checkSources: ReadonlyMap<string, string>;
  readonly gateStatusContext: string;
  readonly demoRunId: string | null;
  readonly demoResetSha: string | null;
}

const RuntimeSchema = z.object({
  DB_PATH: z.string().trim().min(1).default("./data/loopback.db"),
  MERGE_ENABLED: bool(false),
  POLL_INTERVAL_MS: positiveInt(10_000),
  VERIFY_TIMEOUT_MS: positiveInt(600_000),
  FIX_TIMEOUT_MS: positiveInt(2_700_000),
  TRANSIENT_RETRY_LIMIT: positiveInt(3),
  MERGE_MAX_ATTEMPTS: positiveInt(2),
  QUORUM: positiveInt(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HTTP_PORT: positiveInt(8787),
});

export interface RuntimeConfig {
  readonly dbPath: string;
  readonly mergeEnabled: boolean;
  readonly pollIntervalMs: number;
  readonly verifyTimeoutMs: number;
  readonly fixTimeoutMs: number;
  readonly transientRetryLimit: number;
  readonly mergeMaxAttempts: number;
  readonly quorum: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly httpPort: number;
}

// ---------------------------------------------------------------------------

function pick(env: Env, keys: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = env[k];
  return out;
}

function issuesFrom(error: z.ZodError): ConfigIssue[] {
  // Messages come from our schemas, never from input values.
  return error.issues.map((i) => ({ variable: String(i.path[0] ?? "?"), message: i.message }));
}

function parseGroup<T extends z.ZodTypeAny>(group: string, schema: T, env: Env): z.output<T> {
  const keys = Object.keys((schema as unknown as z.AnyZodObject).shape);
  const result = schema.safeParse(pick(env, keys));
  if (!result.success) throw new ConfigError(group, issuesFrom(result.error));
  return result.data as z.output<T>;
}

export function loadSwitchConfig(env: Env): SwitchConfig {
  const v = parseGroup("Switch", SwitchSchema, env);
  return {
    bridgeUrl: v.SWITCH_BRIDGE_URL,
    agentId: v.SWITCH_AGENT_ID,
    apiKey: v.SWITCH_AGENT_API_KEY,
    roomId: v.SWITCH_ROOM_ID,
    selfId: v.SWITCH_SELF_ID,
    humanSenderKind: v.SWITCH_HUMAN_SENDER_KIND,
  };
}

export function loadIdentityConfig(env: Env): IdentityConfig {
  const v = parseGroup("identity", IdentitySchema, env);
  const agents = new Set([v.LOOPBACK_FIXER_ID, v.LOOPBACK_VERIFIER_ID]);
  const issues: ConfigIssue[] = [];
  if (v.LOOPBACK_FIXER_ID === v.LOOPBACK_VERIFIER_ID) {
    issues.push({ variable: "LOOPBACK_VERIFIER_ID", message: "must differ from LOOPBACK_FIXER_ID" });
  }
  for (const id of agents) {
    if (v.LOOPBACK_MAINTAINERS.has(id)) {
      issues.push({ variable: "LOOPBACK_MAINTAINERS", message: "must not contain an agent id" });
    }
    if (v.LOOPBACK_REPORTERS.has(id)) {
      issues.push({ variable: "LOOPBACK_REPORTERS", message: "must not contain an agent id" });
    }
  }
  if (issues.length > 0) throw new ConfigError("identity", issues);
  return {
    maintainers: v.LOOPBACK_MAINTAINERS,
    reporters: v.LOOPBACK_REPORTERS,
    fixerId: v.LOOPBACK_FIXER_ID,
    verifierId: v.LOOPBACK_VERIFIER_ID,
    fixerAlias: v.LOOPBACK_FIXER_ALIAS,
    verifierAlias: v.LOOPBACK_VERIFIER_ALIAS,
  };
}

/** Throws unless the key file exists and is not group- or world-accessible (owner-only). */
export function assertPrivateKeyFile(path: string, stat: (p: string) => { mode: number; isFile(): boolean } = statSync): void {
  let st: { mode: number; isFile(): boolean };
  try {
    st = stat(path);
  } catch {
    throw new ConfigError("GitHub", [{ variable: "GH_APP_PRIVATE_KEY_PATH", message: "file not found or unreadable" }]);
  }
  if (!st.isFile()) {
    throw new ConfigError("GitHub", [{ variable: "GH_APP_PRIVATE_KEY_PATH", message: "not a regular file" }]);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ConfigError("GitHub", [{ variable: "GH_APP_PRIVATE_KEY_PATH", message: "file must not be group- or world-accessible (chmod 600)" }]);
  }
}

export function loadGitHubConfig(env: Env, opts: { checkKeyFile?: boolean } = {}): GitHubConfig {
  const v = parseGroup("GitHub", GitHubSchema, env);
  const issues: ConfigIssue[] = [];
  const required = v.REQUIRED_CHECKS.split(",").map((s: string) => s.trim()).filter(Boolean);
  const sources = new Map<string, string>();
  for (const pair of v.CHECK_SOURCES.split(",").map((s: string) => s.trim()).filter(Boolean)) {
    const m = /^([^:]+):([a-z0-9-]+)$/.exec(pair);
    if (!m) {
      issues.push({ variable: "CHECK_SOURCES", message: "entries must be <check>:<app-slug>" });
      continue;
    }
    sources.set(m[1]!, m[2]!);
  }
  if (required.length === 0) issues.push({ variable: "REQUIRED_CHECKS", message: "at least one check required" });
  for (const check of required) {
    if (!sources.has(check)) issues.push({ variable: "CHECK_SOURCES", message: "every required check needs a source app" });
  }
  if (v.DEMO_RUN_ID !== null) {
    if (!DEMO_RUN_ID.test(v.DEMO_RUN_ID)) {
      issues.push({ variable: "DEMO_RUN_ID", message: "must be <yyyymmdd>-<16 lower-case hex>" });
    } else if (v.BASE_BRANCH !== `demo/${v.DEMO_RUN_ID}`) {
      issues.push({ variable: "BASE_BRANCH", message: "must equal demo/<DEMO_RUN_ID> during a demo run" });
    }
    if (v.DEMO_RESET_SHA === null || !FullSha.safeParse(v.DEMO_RESET_SHA).success) {
      issues.push({ variable: "DEMO_RESET_SHA", message: "full SHA required when DEMO_RUN_ID is set" });
    }
  } else if (v.BASE_BRANCH.startsWith("demo/")) {
    issues.push({ variable: "DEMO_RUN_ID", message: "required when BASE_BRANCH is a demo branch" });
  }
  if (issues.length > 0) throw new ConfigError("GitHub", issues);
  if (opts.checkKeyFile !== false) assertPrivateKeyFile(v.GH_APP_PRIVATE_KEY_PATH);
  const [owner, name] = v.GH_REPO.split("/") as [string, string];
  return {
    repo: v.GH_REPO,
    owner,
    name,
    appId: v.GH_APP_ID,
    installationId: v.GH_APP_INSTALLATION_ID,
    privateKeyPath: v.GH_APP_PRIVATE_KEY_PATH,
    baseBranch: v.BASE_BRANCH,
    requiredChecks: required,
    checkSources: sources,
    gateStatusContext: v.GATE_STATUS_CONTEXT,
    demoRunId: v.DEMO_RUN_ID,
    demoResetSha: v.DEMO_RESET_SHA,
  };
}

export function loadRuntimeConfig(env: Env): RuntimeConfig {
  const v = parseGroup("runtime", RuntimeSchema, env);
  return {
    dbPath: v.DB_PATH,
    mergeEnabled: v.MERGE_ENABLED,
    pollIntervalMs: v.POLL_INTERVAL_MS,
    verifyTimeoutMs: v.VERIFY_TIMEOUT_MS,
    fixTimeoutMs: v.FIX_TIMEOUT_MS,
    transientRetryLimit: v.TRANSIENT_RETRY_LIMIT,
    mergeMaxAttempts: v.MERGE_MAX_ATTEMPTS,
    quorum: v.QUORUM,
    logLevel: v.LOG_LEVEL,
    httpPort: v.HTTP_PORT,
  };
}
