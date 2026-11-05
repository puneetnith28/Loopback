import { QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { CaseState } from "@loopback/contracts";
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

type Cursor = string | undefined;
const firstPage: Cursor = undefined;
const nextCursor = <T,>(last: ApiResult<T>): Cursor => last.meta.nextCursor ?? undefined;

export function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: ({ signal }) => apiGet("/overview", Overview, { signal }),
    refetchInterval: POLL.overview,
  });
}

export function useCaseList(state: CaseState | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.cases(state),
    queryFn: ({ signal, pageParam }) => apiGet("/cases", CasePage, { signal, query: { state, cursor: pageParam, limit: PAGE_SIZE } }),
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.lists,
  });
}

/** `id` must already be a validated CaseId (the router guarantees it). */
export function useCase(id: string) {
  return useQuery({
    queryKey: queryKeys.case(id),
    queryFn: ({ signal }) => apiGet(`/cases/${id}`, CaseDetail, { signal }),
    refetchInterval: POLL.caseDetail,
  });
}

export function useCaseAudit(id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.caseAudit(id),
    queryFn: ({ signal, pageParam }) => apiGet(`/cases/${id}/audit`, AuditPage, { signal, query: { cursor: pageParam, limit: PAGE_SIZE } }),
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.caseDetail,
  });
}

export function useAuditFeed(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: ({ signal, pageParam }) =>
      apiGet("/audit", AuditPage, { signal, query: { case: filters.caseId, types: filters.types, cursor: pageParam, limit: PAGE_SIZE } }),
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.lists,
  });
}

export function useVerificationRuns() {
  return useInfiniteQuery({
    queryKey: queryKeys.verificationRuns,
    queryFn: ({ signal, pageParam }) => apiGet("/verification-runs", RunPage, { signal, query: { cursor: pageParam, limit: PAGE_SIZE } }),
    initialPageParam: firstPage,
    getNextPageParam: nextCursor,
    refetchInterval: POLL.lists,
  });
}

export function useConfigSummary() {
  return useQuery({ queryKey: queryKeys.config, queryFn: ({ signal }) => apiGet("/config/summary", ConfigSummary, { signal }) });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => apiGet("/status", SystemStatus, { signal }),
    refetchInterval: POLL.status,
  });
}
