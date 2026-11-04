/**
 * Outbound chat. Implemented by the Switch transport (verified against the
 * installed Switch version) and by in-memory fakes in tests.
 */
export interface ChatPort {
  post(roomId: string, content: string, threadId: string | null): Promise<void>;
}

/** Prefix replies with the case id when they cannot be threaded (Q8 fallback). */
export function withCaseTag(content: string, caseId: string | null, threadId: string | null): string {
  return caseId !== null && threadId === null ? `[${caseId}] ${content}` : content;
}
