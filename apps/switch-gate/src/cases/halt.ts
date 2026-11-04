/**
 * A one-way halt for privileged operations, shared by the merge executor and the
 * verification workflow.
 *
 * When the gate stops because its Switch addressing policy is no longer the expected
 * one, a privileged operation may already be running (waiting on GitHub). Its
 * authorization was decided before the policy failed, but it must not cross any
 * further write boundary: it checks `assertRunning` immediately before each one and
 * stops by throwing. Stopping there is equivalent to the process ending at that point,
 * which startup reconciliation already recovers from (decisions D9, D15, D18).
 *
 * This cannot cancel a GitHub merge request that has already been sent.
 */

export class HaltedError extends Error {
  constructor(readonly operation: string, readonly reason: string) {
    super(`${operation} stopped: the gate is halted (${reason})`);
    this.name = "HaltedError";
  }
}

export interface HaltGuard {
  /** Throws HaltedError once the gate is halted. Call right before a write boundary. */
  assertRunning(operation: string): void;
}

export class HaltSwitch implements HaltGuard {
  private why: string | null = null;

  /** Halt for good. The first reason is kept; later calls change nothing. */
  halt(reason: string): void {
    if (this.why === null) this.why = reason;
  }

  get halted(): boolean {
    return this.why !== null;
  }

  get reason(): string | null {
    return this.why;
  }

  assertRunning(operation: string): void {
    if (this.why !== null) throw new HaltedError(operation, this.why);
  }
}
