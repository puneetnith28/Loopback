import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AUDIT_EVENT_TYPES, CASE_STATES, CaseId, REASON_CODES, isTransient } from "@loopback/contracts";
import {
  AGENT_ACTIVITY_TYPES, API_VERSION, ActivityQuery, ApiError, ApprovalListResponse, AuditPageResponse, AuditQuery, CaseDetail, CaseListQuery, CaseListResponse, CiListResponse,
  CommitListResponse, GateStatusResponse, HealthResponse, MergeListResponse, MetaResponse, NoQuery, SummaryResponse, VerificationListResponse,
  type ApiErrorCode,
} from "@loopback/console-contracts";
import type { z } from "zod";
import type { ConsoleConfig } from "./config.js";
import {
  DatabaseUnavailable, SchemaMismatch, caseDetail, currentHead, listActivity, listApprovals, listAudit, listCases, listChecks, listCommits, listMerges, listRuns, schemaVersion, summary, withDatabase,
} from "./store.js";

// The console's read-only API. GET and preflight only; nothing here can change the gate's state,
// and nothing here holds a GitHub, signer, Switch or merge credential. Bound to 127.0.0.1, with the
// Host header checked so a web page cannot reach it through DNS rebinding.

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  DATABASE_UNAVAILABLE: 503, SCHEMA_MISMATCH: 503, INTERNAL: 500,
};

class Refusal extends Error {
  constructor(readonly code: ApiErrorCode, message: string) { super(message); }
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const CASE_PATH = /^\/api\/v1\/cases\/([^/]+)(?:\/(commits|verification-runs|checks|approvals|merge-operations|audit))?$/;
const GATE_TIMEOUT_MS = 2000;

/** Sent to the browser only after passing the schema: undeclared fields cannot leave this API. */
const checked = <T extends z.ZodType>(schema: T, body: z.input<T>): z.output<T> => schema.parse(body);

function queryOf<T extends z.ZodType>(schema: T, url: URL): z.output<T> {
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new Refusal("BAD_REQUEST", parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "));
  return parsed.data;
}

async function gateStatus(cfg: ConsoleConfig, now: Date): Promise<z.output<typeof GateStatusResponse>> {
  const get = async (path: string): Promise<{ status: number; body: { failing?: unknown } } | null> => {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.gatePort}${path}`, { signal: AbortSignal.timeout(GATE_TIMEOUT_MS) });
      return { status: res.status, body: (await res.json()) as { failing?: unknown } };
    } catch {
      return null;
    }
  };
  const [live, ready] = await Promise.all([get("/healthz"), get("/readyz")]);
  const failing = Array.isArray(ready?.body.failing) ? ready.body.failing.filter((f): f is string => typeof f === "string") : [];
  return { reachable: live !== null, live: live?.status === 200, ready: ready?.status === 200, failing, checkedAt: now.toISOString() };
}

export interface ConsoleServerOptions {
  readonly now?: () => Date;
  readonly log?: (line: Record<string, unknown>) => void;
}

export function startConsoleServer(cfg: ConsoleConfig, opts: ConsoleServerOptions = {}): Promise<Server> {
  const now = opts.now ?? (() => new Date());
  const expected = digest(cfg.token);
  const hosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice("Bearer ".length)), expected);
  };

  const route = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    const path = url.pathname;
    if (path === "/api/v1/health") return checked(HealthResponse, { status: "ok" });
    if (!authorized(req)) throw new Refusal("UNAUTHORIZED", "Send Authorization: Bearer <token>.");

    if (path === "/api/v1/meta") {
      queryOf(NoQuery, url);
      return withDatabase(cfg.dbPath, (db) => checked(MetaResponse, {
        apiVersion: API_VERSION, schemaVersion: schemaVersion(db), caseStates: [...CASE_STATES], auditEventTypes: [...AUDIT_EVENT_TYPES],
        reasonCodes: REASON_CODES.map((code) => ({ code, transient: isTransient(code) })), agentActivityTypes: [...AGENT_ACTIVITY_TYPES],
      }));
    }
    if (path === "/api/v1/summary") {
      queryOf(NoQuery, url);
      return withDatabase(cfg.dbPath, (db) => checked(SummaryResponse, summary(db, now())));
    }
    if (path === "/api/v1/gate") {
      queryOf(NoQuery, url);
      return checked(GateStatusResponse, await gateStatus(cfg, now()));
    }
    if (path === "/api/v1/cases") {
      const q = queryOf(CaseListQuery, url);
      return withDatabase(cfg.dbPath, (db) => checked(CaseListResponse, listCases(db, q)));
    }
    if (path === "/api/v1/audit") {
      const q = queryOf(AuditQuery, url);
      return withDatabase(cfg.dbPath, (db) => checked(AuditPageResponse, listAudit(db, q)));
    }
    if (path === "/api/v1/activity") {
      const q = queryOf(ActivityQuery, url);
      return withDatabase(cfg.dbPath, (db) => checked(AuditPageResponse, listActivity(db, q)));
    }

    const m = CASE_PATH.exec(path);
    if (m === null) throw new Refusal("NOT_FOUND", "No such endpoint.");
    const id = CaseId.safeParse(m[1]);
    if (!id.success) throw new Refusal("NOT_FOUND", "No such case.");
    const caseId = id.data;
    const sub = m[2] as "commits" | "verification-runs" | "checks" | "approvals" | "merge-operations" | "audit" | undefined;
    const audit = sub === "audit" ? queryOf(ActivityQuery, url) : (queryOf(NoQuery, url), null);
    return withDatabase(cfg.dbPath, (db) => {
      const found = currentHead(db, caseId);
      if (found === null) throw new Refusal("NOT_FOUND", "No such case.");
      const { head } = found;
      switch (sub) {
        case "commits": return checked(CommitListResponse, { items: listCommits(db, caseId, head) });
        case "verification-runs": return checked(VerificationListResponse, { items: listRuns(db, caseId, head) });
        case "checks": return checked(CiListResponse, { items: listChecks(db, caseId, head) });
        case "approvals": return checked(ApprovalListResponse, { items: listApprovals(db, caseId, head) });
        case "merge-operations": return checked(MergeListResponse, { items: listMerges(db, caseId) });
        case "audit": return checked(AuditPageResponse, listAudit(db, { ...audit!, caseId }));
        case undefined: return checked(CaseDetail, caseDetail(db, caseId)!);
      }
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const requestId = randomUUID();
    const origin = req.headers.origin;
    const send = (status: number, body?: unknown) => {
      const headers: Record<string, string> = {
        "x-request-id": requestId, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      };
      if (cfg.allowedOrigin !== null && origin === cfg.allowedOrigin) {
        headers["access-control-allow-origin"] = cfg.allowedOrigin;
        headers.vary = "Origin";
        headers["access-control-expose-headers"] = "x-request-id";
      }
      if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
      res.writeHead(status, headers);
      res.end(body === undefined ? undefined : JSON.stringify(body));
      // The path only, never the query or headers.
      opts.log?.({ method: req.method, path: (req.url ?? "").split("?")[0], status, ms: Date.now() - started, requestId });
    };
    const refuse = (code: ApiErrorCode, message: string) => send(STATUS[code], ApiError.parse({ error: { code, message, requestId } }));

    try {
      if (!hosts.has(req.headers.host ?? "")) return refuse("FORBIDDEN", "Unexpected Host header.");
      if (origin !== undefined && origin !== cfg.allowedOrigin) return refuse("FORBIDDEN", "This origin is not allowed.");
      if (req.method === "OPTIONS") {
        if (cfg.allowedOrigin === null || origin !== cfg.allowedOrigin) return refuse("FORBIDDEN", "This origin is not allowed.");
        res.setHeader("access-control-allow-methods", "GET");
        res.setHeader("access-control-allow-headers", "authorization");
        res.setHeader("access-control-max-age", "600");
        return send(204);
      }
      if (req.method !== "GET") {
        res.setHeader("allow", "GET, OPTIONS");
        return refuse("METHOD_NOT_ALLOWED", "This API is read-only.");
      }
      send(200, await route(req, new URL(req.url ?? "/", "http://127.0.0.1")));
    } catch (e) {
      if (e instanceof Refusal) return refuse(e.code, e.message);
      if (e instanceof DatabaseUnavailable) return refuse("DATABASE_UNAVAILABLE", "The gate's database cannot be read yet.");
      if (e instanceof SchemaMismatch) return refuse("SCHEMA_MISMATCH", "The gate's database version does not match this API.");
      // Never the exception's text: it could describe paths or data.
      opts.log?.({ op: "internal_error", name: e instanceof Error ? e.name : "unknown", requestId });
      refuse("INTERNAL", "Internal error.");
    }
  };

  const server = createServer((req, res) => { void handle(req, res); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => resolve(server));
  });
}
