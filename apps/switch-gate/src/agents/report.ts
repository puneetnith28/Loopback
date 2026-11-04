import type { z } from "zod";

export const MAX_REPORT_BYTES = 16_384;

export type ExtractFailure = "NO_BLOCK" | "TOO_LARGE" | "INVALID_JSON" | "SCHEMA";

export type ExtractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ExtractFailure; readonly detail: string };

const BLOCK = /```loopback-report[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

/**
 * Extract and validate the LAST fenced `loopback-report` block from an agent
 * message (implementation §7). Agent output is untrusted: anything that is not
 * a single, size-capped, schema-valid JSON object is a failure, never a pass.
 */
export function extractReport<S extends z.ZodTypeAny>(body: string, schema: S): ExtractResult<z.output<S>> {
  let last: string | undefined;
  for (const m of body.matchAll(BLOCK)) last = m[1];
  if (last === undefined) return { ok: false, reason: "NO_BLOCK", detail: "no loopback-report block found" };
  if (Buffer.byteLength(last, "utf8") > MAX_REPORT_BYTES) {
    return { ok: false, reason: "TOO_LARGE", detail: `report exceeds ${MAX_REPORT_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    return { ok: false, reason: "INVALID_JSON", detail: "report block is not valid JSON" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: "SCHEMA",
      detail: issue ? `${issue.path.join(".") || "report"}: ${issue.message}` : "schema validation failed",
    };
  }
  return { ok: true, value: parsed.data as z.output<S> };
}
