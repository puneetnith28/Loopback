import type { z } from "zod";

export const MAX_REPORT_BYTES = 16_384;

export type ExtractFailure = "NO_BLOCK" | "TOO_LARGE" | "INVALID_JSON" | "SCHEMA";

export type ExtractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ExtractFailure; readonly detail: string };

/**
 * Find the last fenced block whose opening fence is a whole line "```loopback-report"
 * and whose closing fence is a whole line "```". Linear-time line scan: no regex
 * backtracking, and fences appearing mid-line or inside other text never count.
 */
function lastReportBlock(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let last: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "```loopback-report") continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim() === "```") {
        last = lines.slice(i + 1, j).join("\n");
        i = j;
        break;
      }
      if (lines[j]!.trim().startsWith("```")) break; // a nested/unterminated fence: not a report
    }
  }
  return last;
}

export const MAX_BODY_CHARS = 20_000;

/**
 * Extract and validate the LAST fenced `loopback-report` block from an agent
 * message (implementation §7). Agent output is untrusted: anything that is not
 * a single, size-capped, schema-valid JSON object is a failure, never a pass.
 */
export function extractReport<S extends z.ZodTypeAny>(body: string, schema: S): ExtractResult<z.output<S>> {
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "TOO_LARGE", detail: "message too large" };
  const last = lastReportBlock(body);
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
