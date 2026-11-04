import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplayStore } from "./policy.js";

/** Run ids are lowercase UUIDs; anything else never becomes a filename. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * D29: durable one-signature-per-run record. Each claim creates `<dir>/<runId>` exclusively
 * (O_CREAT|O_EXCL), so concurrent requests and restarts cannot sign a run twice. The directory
 * must be a real directory that no one else can write (it decides what counts as a replay).
 */
export class FileReplayStore implements ReplayStore {
  constructor(private readonly dir: string) {
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`replay state ${dir} is not a directory`);
    if ((st.mode & 0o022) !== 0) throw new Error(`replay state ${dir} is writable by others`);
  }

  claim(runId: string, reportDigest: string): boolean {
    if (!RUN_ID.test(runId)) throw new Error("invalid run id");
    try {
      writeFileSync(join(this.dir, runId), `${JSON.stringify({ runId, reportDigest, signedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }
}
