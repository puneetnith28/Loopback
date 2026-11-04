import type { KeyObject } from "node:crypto";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { FullSha, ParticipantId, RepoSlug } from "@loopback/contracts";
import { PublicKeyError, parsePublicKey } from "./agents/signature.js";

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
    ctx.addIssue({ code: "custom", message: "wildcard is not allowed; list explicit participant ids" });
    return z.NEVER;
  }
  for (const id of ids) {
    if (!ParticipantId.safeParse(id).success) {
      ctx.addIssue({ code: "custom", message: "each entry must be a participant id" });
      return z.NEVER;
    }
  }
  return new Set(ids);
});
/** Comma-separated Switch row ids (UUIDs): ExternalUser ids or Switch agent ids. */
const uuidList = z.string().trim().min(1, "required").transform((s, ctx) => {
  const ids = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    ctx.addIssue({ code: "custom", message: "must be a comma-separated list of lower-case UUIDs" });
    return z.NEVER;
  }
  return new Set(ids);
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One optional Switch row id (UUID); empty means unset. */
const optionalUuid = z.string().trim().optional().transform((s, ctx) => {
  if (s === undefined || s === "") return null;
  if (!UUID.test(s)) {
    ctx.addIssue({ code: "custom", message: "must be a lower-case UUID" });
    return z.NEVER;
  }
  return s;
});
const positiveInt = (fallback: number) =>
  z.string().optional().transform((s, ctx) => {
    if (s === undefined || s.trim() === "") return fallback;
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: "custom", message: "must be a positive integer" });
      return z.NEVER;
    }
    return n;
  });
const bool = (fallback: boolean) =>
  z.string().optional().transform((s, ctx) => {
    if (s === undefined || s.trim() === "") return fallback;
    if (s === "true") return true;
    if (s === "false") return false;
    ctx.addIssue({ code: "custom", message: "must be true or false" });
    return z.NEVER;
  });

// ---------------------------------------------------------------------------

const SwitchSchema = z.object({
  // https, or http only to a loopback host: the agent API key travels on this connection.
  SWITCH_BRIDGE_URL: z.string().refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
    } catch {
      return false;
    }
  }, "must be an https URL (http only for a loopback host)"),
  SWITCH_AGENT_ID: nonEmpty,
  SWITCH_AGENT_API_KEY: nonEmpty,
  // D26: the private maintainers' room and the public intake room; must differ.
  SWITCH_ROOM_ID: nonEmpty,
  SWITCH_INTAKE_ROOM_ID: nonEmpty,
  SWITCH_SELF_ID: ParticipantId,
  // How messages address the gate; the registered agent name (verified live before use).
  SWITCH_GATE_MENTION: z.string().trim().regex(/^@[a-z0-9][a-z0-9._-]*$/, "must be @ followed by the agent name").default("@loopback-gate"),
  // The gate's Switch addressing policy must admit exactly these (startup self-check):
  // ExternalUser ids of the people who may address it, and Switch agent ids of the
  // fixer and verifier. Not participant ids; see docs/setup.md.
  SWITCH_POLICY_USER_IDS: uuidList,
  SWITCH_POLICY_AGENT_IDS: uuidList,
});

export interface SwitchConfig {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  /** The private maintainers' room (privileged commands, agent reports). */
  readonly roomId: string;
  /** The public intake room (reports, help, own status only). */
  readonly intakeRoomId: string;
  readonly selfId: string;
  /** The @mention that addresses the gate in a message body. */
  readonly gateMention: string;
  /** ExternalUser ids the Switch addressing policy must admit (and nothing else). */
  readonly policyUserIds: ReadonlySet<string>;
  /** Switch agent ids the Switch addressing policy must admit (and nothing else). */
  readonly policyAgentIds: ReadonlySet<string>;
}

const IdentitySchema = z.object({
  LOOPBACK_MAINTAINERS: idList,
  LOOPBACK_REPORTERS: idList,
  LOOPBACK_FIXER_ID: ParticipantId,
  LOOPBACK_VERIFIER_ID: ParticipantId,
  LOOPBACK_FIXER_ALIAS: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/).default("@loopback-fixer"),
  LOOPBACK_VERIFIER_ALIAS: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/).default("@loopback-verifier"),
  // Privileged commands (verify, approve, reject, merge, retask). Off unless exactly "true".
  LOOPBACK_PRIVILEGED_ENABLED: bool(false),
  // D28: true only after every verifier-isolation proof passed; until then verification is advisory.
  VERIFIER_ISOLATION_PROVEN: bool(false),
  // D26: public intake reports accepted per sender per hour.
  INTAKE_MAX_REPORTS_PER_HOUR: positiveInt(3),
  // D28: the verifier's Ed25519 public key (PEM SPKI or raw 32-byte base64). Never a private key.
  VERIFIER_PUBLIC_KEY: z.string().optional().transform((s) => (s === undefined || s.trim() === "" ? null : s)),
  // D28: Switch agent ids (UUIDs) of the fixer and verifier, as in SWITCH_POLICY_AGENT_IDS.
  // LOOPBACK_FIXER_ID / LOOPBACK_VERIFIER_ID are participant ids, a different identifier.
  LOOPBACK_FIXER_AGENT_ID: optionalUuid,
  LOOPBACK_VERIFIER_AGENT_ID: optionalUuid,
});

export interface IdentityConfig {
  readonly maintainers: ReadonlySet<string>;
  readonly reporters: ReadonlySet<string>;
  readonly fixerId: string;
  readonly verifierId: string;
  readonly fixerAlias: string;
  readonly verifierAlias: string;
  readonly privilegedEnabled: boolean;
  readonly verifierIsolationProven: boolean;
  readonly intakeMaxReportsPerHour: number;
  /** D28: verifier signing key; required (and enforced) when verifierIsolationProven. */
  readonly verifierPublicKey: KeyObject | null;
  readonly fixerAgentId: string | null;
  readonly verifierAgentId: string | null;
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
  REQUIRED_CHECK_INTEGRATIONS: nonEmpty,
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
  /** check context -> expected ruleset integration id */
  readonly requiredCheckIntegrations: ReadonlyMap<string, number>;
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
  const shape = (schema as unknown as z.ZodObject).shape as Record<string, unknown>;
  const keys = Object.keys(shape);
  const result = schema.safeParse(pick(env, keys));
  if (!result.success) throw new ConfigError(group, issuesFrom(result.error));
  return result.data;
}

export function loadSwitchConfig(env: Env): SwitchConfig {
  const v = parseGroup("Switch", SwitchSchema, env);
  return {
    bridgeUrl: v.SWITCH_BRIDGE_URL,
    agentId: v.SWITCH_AGENT_ID,
    apiKey: v.SWITCH_AGENT_API_KEY,
    roomId: v.SWITCH_ROOM_ID,
    intakeRoomId: v.SWITCH_INTAKE_ROOM_ID,
    selfId: v.SWITCH_SELF_ID,
    gateMention: v.SWITCH_GATE_MENTION,
    policyUserIds: v.SWITCH_POLICY_USER_IDS,
    policyAgentIds: v.SWITCH_POLICY_AGENT_IDS,
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
  let verifierPublicKey: KeyObject | null = null;
  if (v.VERIFIER_PUBLIC_KEY !== null) {
    try {
      verifierPublicKey = parsePublicKey(v.VERIFIER_PUBLIC_KEY);
    } catch (e) {
      issues.push({ variable: "VERIFIER_PUBLIC_KEY", message: e instanceof PublicKeyError ? e.message : "could not be parsed" });
    }
  }
  // D28: isolated mode is never silently downgraded; every requirement must hold or startup fails.
  if (v.VERIFIER_ISOLATION_PROVEN) {
    if (v.VERIFIER_PUBLIC_KEY === null) issues.push({ variable: "VERIFIER_PUBLIC_KEY", message: "required when VERIFIER_ISOLATION_PROVEN=true" });
    if (v.LOOPBACK_FIXER_AGENT_ID === null) issues.push({ variable: "LOOPBACK_FIXER_AGENT_ID", message: "required when VERIFIER_ISOLATION_PROVEN=true" });
    if (v.LOOPBACK_VERIFIER_AGENT_ID === null) issues.push({ variable: "LOOPBACK_VERIFIER_AGENT_ID", message: "required when VERIFIER_ISOLATION_PROVEN=true" });
  }
  if (v.LOOPBACK_FIXER_AGENT_ID !== null && v.LOOPBACK_FIXER_AGENT_ID === v.LOOPBACK_VERIFIER_AGENT_ID) {
    issues.push({ variable: "LOOPBACK_VERIFIER_AGENT_ID", message: "must differ from LOOPBACK_FIXER_AGENT_ID" });
  }
  if (issues.length > 0) throw new ConfigError("identity", issues);
  return {
    maintainers: v.LOOPBACK_MAINTAINERS,
    reporters: v.LOOPBACK_REPORTERS,
    fixerId: v.LOOPBACK_FIXER_ID,
    verifierId: v.LOOPBACK_VERIFIER_ID,
    fixerAlias: v.LOOPBACK_FIXER_ALIAS,
    verifierAlias: v.LOOPBACK_VERIFIER_ALIAS,
    privilegedEnabled: v.LOOPBACK_PRIVILEGED_ENABLED,
    verifierIsolationProven: v.VERIFIER_ISOLATION_PROVEN,
    intakeMaxReportsPerHour: v.INTAKE_MAX_REPORTS_PER_HOUR,
    verifierPublicKey,
    fixerAgentId: v.LOOPBACK_FIXER_AGENT_ID,
    verifierAgentId: v.LOOPBACK_VERIFIER_AGENT_ID,
  };
}

/**
 * Cross-group identity checks: the gate's own id must never be a maintainer, a
 * reporter or an agent, so its own (echoed) messages can never carry authority.
 */
export function assertIdentityConsistency(
  sw: Pick<SwitchConfig, "selfId" | "roomId" | "intakeRoomId"> & Partial<Pick<SwitchConfig, "policyAgentIds">>,
  id: IdentityConfig,
): void {
  const issues: ConfigIssue[] = [];
  if (id.maintainers.has(sw.selfId)) issues.push({ variable: "LOOPBACK_MAINTAINERS", message: "must not contain SWITCH_SELF_ID" });
  if (id.reporters.has(sw.selfId)) issues.push({ variable: "LOOPBACK_REPORTERS", message: "must not contain SWITCH_SELF_ID" });
  if (sw.roomId === sw.intakeRoomId) {
    issues.push({ variable: "SWITCH_INTAKE_ROOM_ID", message: "must differ from SWITCH_ROOM_ID" });
  }
  if (sw.selfId === id.fixerId || sw.selfId === id.verifierId) {
    issues.push({ variable: "SWITCH_SELF_ID", message: "must differ from the fixer and verifier ids" });
  }
  // D28: in isolated mode both agents must be exactly the ones Switch admits to address the gate.
  if (id.verifierIsolationProven) {
    const listed = sw.policyAgentIds;
    for (const [variable, agentId] of [["LOOPBACK_FIXER_AGENT_ID", id.fixerAgentId], ["LOOPBACK_VERIFIER_AGENT_ID", id.verifierAgentId]] as const) {
      if (agentId === null || listed === undefined || !listed.has(agentId)) {
        issues.push({ variable, message: "must be listed in SWITCH_POLICY_AGENT_IDS when VERIFIER_ISOLATION_PROVEN=true" });
      }
    }
  }
  if (issues.length > 0) throw new ConfigError("identity", issues);
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
  // The directory holding the key must not let anyone else replace it. Read access is not
  // required to be closed: a container bind-mounting the single file gets a 0755 parent.
  // The local secrets/ directory is created 0700 regardless.
  let dir: { mode: number };
  try {
    dir = stat(dirname(path));
  } catch {
    throw new ConfigError("GitHub", [{ variable: "GH_APP_PRIVATE_KEY_PATH", message: "directory not found or unreadable" }]);
  }
  if ((dir.mode & 0o022) !== 0) {
    throw new ConfigError("GitHub", [{ variable: "GH_APP_PRIVATE_KEY_PATH", message: "directory must not be group- or world-writable (chmod 700)" }]);
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
  if (required.includes(v.GATE_STATUS_CONTEXT)) {
    issues.push({ variable: "REQUIRED_CHECKS", message: "gate status context must not be included in REQUIRED_CHECKS" });
  }
  for (const check of required) {
    if (!sources.has(check)) issues.push({ variable: "CHECK_SOURCES", message: "every required check needs a source app" });
  }
  const integrations = new Map<string, number>();
  for (const rawPair of v.REQUIRED_CHECK_INTEGRATIONS.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) {
      issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "entries must be <check>:<integration-id>" });
      continue;
    }
    const ctx = pair.slice(0, colonIdx).trim();
    const rawId = pair.slice(colonIdx + 1).trim();
    if (!ctx || !rawId) {
      issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "check context and integration id must not be empty" });
      continue;
    }
    if (!/^\d+$/.test(rawId)) {
      issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "integration id must be numeric" });
      continue;
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "integration id must be a positive safe integer" });
      continue;
    }
    if (integrations.has(ctx) && integrations.get(ctx) !== id) {
      issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "conflicting integration ids for the same check" });
      continue;
    }
    integrations.set(ctx, id);
  }
  for (const check of required) {
    if (!integrations.has(check)) issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "every required check needs an integration id" });
  }
  const gateAppId = Number(v.GH_APP_ID);
  if (!Number.isSafeInteger(gateAppId) || gateAppId <= 0) {
    issues.push({ variable: "GH_APP_ID", message: "must be a positive integer" });
  } else {
    if (integrations.has(v.GATE_STATUS_CONTEXT) && integrations.get(v.GATE_STATUS_CONTEXT) !== gateAppId) {
      issues.push({ variable: "REQUIRED_CHECK_INTEGRATIONS", message: "gate status context integration id must match GH_APP_ID" });
    }
    integrations.set(v.GATE_STATUS_CONTEXT, gateAppId);
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
    requiredCheckIntegrations: integrations,
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
