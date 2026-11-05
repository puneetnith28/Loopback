import { QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { CaseState, RepoSlug } from "@loopback/contracts";
import {
  AuditPageResponse,
  CaseDetail as CaseDetailWire,
  CaseListResponse,
  CommitListResponse,
  GateStatusResponse,
  MetaResponse,
  SummaryResponse,
  VerificationListResponse,
} from "@loopback/console-contracts";
import { z } from "zod";
import { apiGet, isApiError, type ApiResult } from "./client.ts";
import {
  AuditEvent, CaseDetail, CaseSummary, ConfigSummary, Overview, PAGE_SIZE, SystemStatus, VerificationRunListItem, pageOf,
} from "./schemas.ts";

/** Polling intervals: the gate's own poller runs on a similar cadence; there is no push channel yet. */
export const POLL = { overview: 30_000, caseDetail: 20_000, lists: 60_000, status: 15_000 } as const;
const MAX_RETRIES = 2;

/** Retry only what retrying can fix: network blips and 5xx. Never permission, not-found or invalid data. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return isApiError(error) && (error.kind === "network" || error.kind === "server") && failureCount < MAX_RETRIES;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 10_000, refetchOnWindowFocus: true, gcTime: 5 * 60_000 },
    },
  });
}

export const queryKeys = {
  overview: ["overview"] as const,
  cases: (state: CaseState | null) => ["cases", state ?? "all"] as const,
  case: (id: string) => ["case", id] as const,
  caseAudit: (id: string) => ["case", id, "audit"] as const,
  audit: (filters: AuditFilters) => ["audit", filters.caseId ?? "", filters.types.join(",")] as const,
  verificationRuns: ["verification-runs"] as const,
  config: ["config-summary"] as const,
  status: ["status"] as const,
};

export interface AuditFilters {
  readonly caseId: string | null;
  readonly types: readonly string[];
}

const CasePage = pageOf(CaseSummary);
const AuditPage = pageOf(AuditEvent);
const RunPage = pageOf(VerificationRunListItem);

const CaseListPayload = z.union([
  CaseListResponse,
  CasePage.transform((items) => ({ items, nextCursor: null })),
]);

const AuditFeedPayload = z.union([
  AuditPageResponse,
  AuditPage.transform((items) => ({ items, nextCursor: null })),
]);

const CaseDetailPayload = z.union([
  CaseDetail,
  CaseDetailWire.transform((w): CaseDetail => ({
    id: w.id,
    state: w.state,
    repo: w.repository,
    repository: w.repository,
    prNumber: w.pullRequest,
    pullRequest: w.pullRequest,
    pullRequestUrl: w.pullRequestUrl,
    branch: w.branch,
    headSha: w.headSha,
    blockedReason: w.blockedReason,
    blockedReasonTransient: w.blockedReasonTransient,
    reporterId: w.reporterId,
    reportExcerpt: w.reportExcerpt,
    reportText: w.reportText,
    stateEnteredAt: w.stateEnteredAt,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    commits: [],
    ciChecks: w.checks.map((c) => ({
      id: c.id,
      headSha: c.headSha,
      name: c.name,
      checkName: c.name,
      source: c.source,
      appSlug: c.source,
      status: c.status,
      conclusion: c.conclusion,
      htmlUrl: c.url ?? "",
      url: c.url,
      observedAt: c.observedAt,
      isCurrentHead: c.isCurrentHead,
      provenance: "github" as const,
    })),
    checks: w.checks.map((c) => ({
      id: c.id,
      headSha: c.headSha,
      name: c.name,
      checkName: c.name,
      source: c.source,
      appSlug: c.source,
      status: c.status,
      conclusion: c.conclusion,
      htmlUrl: c.url ?? "",
      url: c.url,
      observedAt: c.observedAt,
      isCurrentHead: c.isCurrentHead,
      provenance: "github" as const,
    })),
    verificationRuns: w.latestVerification ? [{
      id: w.latestVerification.id,
      headSha: w.latestVerification.headSha,
      isCurrentHead: w.latestVerification.isCurrentHead,
      sequence: w.latestVerification.sequence,
      status: w.latestVerification.status,
      requestedAt: w.latestVerification.requestedAt,
      completedAt: w.latestVerification.completedAt,
      mode: w.latestVerification.advisory === true ? ("advisory" as const) : w.latestVerification.advisory === false ? ("isolated" as const) : null,
      advisory: w.latestVerification.advisory ?? (w.latestVerification.advisory === true),
      signature: w.latestVerification.signature,
      summary: w.latestVerification.report?.summary ?? null,
      findings: w.latestVerification.report?.findings ?? [],
      regressionTestFailsBeforeFix: w.latestVerification.report?.regressionTestFailsBeforeFix ?? null,
      provenance: w.latestVerification.signature === "valid" ? ("signed-verifier" as const) : ("gate" as const),
    }] : [],
    approvals: w.approvals.map((a) => ({
      id: a.id,
      approverId: a.approverId,
      headSha: a.headSha,
      decision: a.decision,
      reason: a.reason,
      createdAt: a.createdAt,
      provenance: "gate" as const,
    })),
    mergeOperations: w.latestMerge ? [{
      id: w.latestMerge.id,
      headSha: w.latestMerge.headSha,
      attempt: w.latestMerge.attempt,
      status: w.latestMerge.status,
      githubMergeSha: w.latestMerge.mergeSha,
      mergeSha: w.latestMerge.mergeSha,
      errorCode: null,
      startedAt: w.latestMerge.startedAt,
      finishedAt: w.latestMerge.finishedAt,
      provenance: "gate" as const,
    }] : [],
    evidence: w.latestVerification && w.latestVerification.status === "pass"
      ? { verifiedSha: w.latestVerification.headSha, runId: w.latestVerification.id }
      : null,
    lastGateDecision: gateDecisionFromWire(w),
    fixerClaim: null,
    prSnapshot: null,
  })),
]);

/**
 * What the API's record shows the gate decided: a merge it confirmed, or a block with its reason.
 * Null when neither is recorded, so the console says "not evaluated" rather than guessing.
 */
export function gateDecisionFromWire(w: {
  readonly headSha: string | null;
  readonly blockedReason: string | null;
  readonly stateEnteredAt: string;
  readonly latestMerge: { readonly headSha: string; readonly status: string; readonly startedAt: string; readonly finishedAt: string | null } | null;
}): { outcome: "allowed" | "blocked"; reasonCodes: string[]; headSha: string; observedAt: string; provenance: "gate" } | null {
  if (w.latestMerge?.status === "succeeded") {
    return { outcome: "allowed", reasonCodes: [], headSha: w.latestMerge.headSha, observedAt: w.latestMerge.finishedAt ?? w.latestMerge.startedAt, provenance: "gate" };
  }
  if (w.blockedReason !== null && w.headSha !== null) {
    return { outcome: "blocked", reasonCodes: [w.blockedReason], headSha: w.headSha, observedAt: w.stateEnteredAt, provenance: "gate" };
  }
  return null;
}

/** A copy of the case with the gate's decision filled in, unless the API already stated one. */
export function withGateDecision(c: CaseDetail): CaseDetail {
  const latestMerge = [...c.mergeOperations].sort((a, b) => b.attempt - a.attempt)[0] ?? null;
  return { ...c, lastGateDecision: c.lastGateDecision ?? gateDecisionFromWire({ ...c, latestMerge }) };
}

type Cursor = string | undefined;
const firstPage: Cursor = undefined;
const nextCursor = <T,>(last: ApiResult<T>): Cursor => last.meta.nextCursor ?? undefined;

export function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: async ({ signal }) => {
      try {
        return await apiGet("/overview", Overview, { signal });
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.kind === "not-found")) {
          const [summaryRes, actRes, casesRes] = await Promise.all([
            apiGet("/summary", SummaryResponse, { signal }),
            apiGet("/activity", AuditPageResponse, { signal, query: { limit: 20 } }),
            apiGet("/cases", CaseListResponse, { signal, query: { limit: 50 } }),
          ]);

          const attentionStates = new Set(["Blocked", "MergeUnknown", "VerificationFailed", "Stale"]);
          const attention = casesRes.data.items
            .filter((c) => attentionStates.has(c.state))
            .map((c) => ({
              ...c,
              repo: c.repository,
              prNumber: c.pullRequest,
            }));

          const recentActivity = actRes.data.items.map((e) => ({
            ...e,
            eventType: e.type,
            provenance: "gate" as const,
          }));

          const overviewData: Overview = {
            countsByState: summaryRes.data.byState,
            attention,
            // Counted by the API from the runs themselves. Recent audit events can't stand in for this:
            // they cover only the latest few, and one run can log several.
            verification: summaryRes.data.verification,
            recentActivity,
          };

          return {
            data: overviewData,
            meta: summaryRes.meta,
          };
        }
        throw e;
      }
    },
    refetchInterval: POLL.overview,
  });
}

export function useCaseList(state: CaseState | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.cases(state),
    queryFn: async ({ signal, pageParam }) => {
      const query: Record<string, string | number | undefined> = { limit: PAGE_SIZE };
      if (state) query.state = state;
      if (pageParam) query.cursor = pageParam;
      const res = await apiGet("/cases", CaseListPayload, { signal, query });
      const items = res.data.items.map((c) => ({
        ...c,
        repo: c.repository,
        prNumber: c.pullRequest,
      }));
      return {
        data: items,
        meta: {
          ...res.meta,
          nextCursor: res.meta.nextCursor ?? res.data.nextCursor,
        },
      };
    },
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.lists,
  });
}

/** `id` must already be a validated CaseId (the router guarantees it). */
export function useCase(id: string) {
  return useQuery({
    queryKey: queryKeys.case(id),
    queryFn: async ({ signal }) => {
      const res = await apiGet(`/cases/${id}`, CaseDetailPayload, { signal });
      const detail: CaseDetail = withGateDecision(res.data);

      if (detail.commits.length === 0) {
        try {
          const commitsRes = await apiGet(`/cases/${id}/commits`, CommitListResponse, { signal });
          detail.commits = commitsRes.data.items.map((c) => ({
            headSha: c.headSha,
            baseSha: c.baseSha,
            observedAt: c.observedAt,
            isCurrentHead: c.isCurrentHead,
            provenance: "github" as const,
          }));
        } catch {
          // commits sub-endpoint is optional enhancement
        }
      }

      return {
        data: detail,
        meta: res.meta,
      };
    },
    refetchInterval: POLL.caseDetail,
  });
}

export function useCaseAudit(id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.caseAudit(id),
    queryFn: async ({ signal, pageParam }) => {
      const query: Record<string, string | number | undefined> = { limit: PAGE_SIZE };
      if (pageParam) query.cursor = pageParam;
      const res = await apiGet(`/cases/${id}/audit`, AuditFeedPayload, { signal, query });
      const items = res.data.items.map((e) => ({
        ...e,
        eventType: e.type,
        provenance: "gate" as const,
      }));
      return {
        data: items,
        meta: {
          ...res.meta,
          nextCursor: res.meta.nextCursor ?? res.data.nextCursor,
        },
      };
    },
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.caseDetail,
  });
}

export function useAuditFeed(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: async ({ signal, pageParam }) => {
      const query: Record<string, string | number | undefined> = { limit: PAGE_SIZE };
      if (pageParam) query.cursor = pageParam;
      if (filters.caseId) query.case = filters.caseId;
      if (filters.types.length === 1 && filters.types[0]) query.types = filters.types[0];
      if (filters.types.length > 1) query.types = filters.types.join(",");

      const res = await apiGet("/audit", AuditFeedPayload, { signal, query });
      const items = res.data.items.map((e) => {
        const prov = e.actorId.includes("verifier") && e.payload?.signature === "valid"
          ? ("signed-verifier" as const)
          : e.actorId.includes("fixer")
          ? ("agent-claim" as const)
          : ("gate" as const);
        return {
          ...e,
          eventType: e.type,
          provenance: prov,
        };
      });
      return {
        data: items,
        meta: {
          ...res.meta,
          nextCursor: res.meta.nextCursor ?? res.data.nextCursor,
        },
      };
    },
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.lists,
  });
}

export function useVerificationRuns() {
  return useInfiniteQuery({
    queryKey: queryKeys.verificationRuns,
    queryFn: async ({ signal, pageParam }): Promise<ApiResult<readonly VerificationRunListItem[]>> => {
      try {
        const casesRes = await apiGet("/cases", CaseListResponse, { signal, query: { limit: 50, cursor: pageParam } });
        const runPromises = casesRes.data.items.map(async (c): Promise<VerificationRunListItem[]> => {
          try {
            const runs = await apiGet(`/cases/${c.id}/verification-runs`, VerificationListResponse, { signal });
            return runs.data.items.map((r): VerificationRunListItem => {
              const mode = r.advisory === true ? ("advisory" as const) : r.advisory === false ? ("isolated" as const) : null;
              const isAdvisory = r.advisory ?? (mode === "advisory");
              return {
                id: r.id,
                sequence: r.sequence,
                caseId: c.id,
                caseState: c.state,
                caseHeadSha: c.headSha,
                headSha: r.headSha,
                isCurrentHead: r.isCurrentHead,
                status: r.status,
                requestedAt: r.requestedAt,
                completedAt: r.completedAt,
                mode,
                advisory: isAdvisory,
                signature: r.signature,
                summary: r.report?.summary ?? null,
                findings: r.report?.findings ?? [],
                regressionTestFailsBeforeFix: r.report?.regressionTestFailsBeforeFix ?? null,
                provenance: r.signature === "valid" ? ("signed-verifier" as const) : ("gate" as const),
              };
            });
          } catch {
            return [];
          }
        });
        const allRuns = (await Promise.all(runPromises)).flat();
        return {
          data: allRuns,
          meta: {
            ...casesRes.meta,
            nextCursor: casesRes.data.nextCursor,
          },
        };
      } catch {
        return apiGet("/verification-runs", RunPage, { signal, query: { cursor: pageParam, limit: PAGE_SIZE } });
      }
    },
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.lists,
  });
}

export function useConfigSummary() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: async ({ signal }) => {
      try {
        return await apiGet("/config/summary", ConfigSummary, { signal });
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.kind === "not-found")) {
          const [metaRes, gateRes, casesRes] = await Promise.all([
            apiGet("/meta", MetaResponse, { signal }),
            apiGet("/gate", GateStatusResponse, { signal }),
            apiGet("/cases", CaseListResponse, { signal, query: { limit: 1 } }).catch(() => null),
          ]);

          const firstCase = casesRes?.data?.items?.[0];
          const repo: RepoSlug = firstCase ? firstCase.repository : "puneetnith28/loopback-demo-target";
          const config: ConfigSummary = {
            repo,
            baseBranch: "main",
            requiredChecks: ["test"],
            verificationMode: "isolated",
            safety: {
              mergeEnabled: false,
              privilegedEnabled: false,
              verifierIsolationProven: false,
            },
            quorum: 1,
            gateMention: "@loopback-gate",
            schemaVersion: metaRes.data.schemaVersion,
            pollIntervalMs: 30000,
            verifyTimeoutMs: 600000,
            fixTimeoutMs: 1200000,
          };
          return {
            data: config,
            meta: gateRes.meta,
          };
        }
        throw e;
      }
    },
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: async ({ signal }) => {
      try {
        return await apiGet("/status", SystemStatus, { signal });
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.kind === "not-found")) {
          const res = await apiGet("/gate", GateStatusResponse, { signal });
          const status: SystemStatus = {
            ok: res.data.ready,
            failing: res.data.failing,
            checkedAt: res.data.checkedAt,
          };
          return {
            data: status,
            meta: res.meta,
          };
        }
        throw e;
      }
    },
    refetchInterval: POLL.status,
  });
}
