/**
 * Per-case mutual exclusion shared by the poller, approvals, verification
 * ingestion and the merge path (implementation §11, step 8.3).
 * In-process only: Loopback is a single-instance service (documented limit).
 */
export class CaseLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async with<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(caseId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => current);
    this.tails.set(caseId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(caseId) === tail) this.tails.delete(caseId);
    }
  }
}
