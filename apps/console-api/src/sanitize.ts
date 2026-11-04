// Audit payloads are redacted when the gate writes them. This repeats the job at the boundary, in
// case an older row or a future event carries something it should not: anything that looks like a
// credential is removed from what a browser can see.

const SECRET_KEY = /token|key|secret|password|authorization|credential|cookie|capability/i;
/** The gate records the signature's status in a field of this name, never the signature itself. */
const SIGNATURE_STATUS = /^(valid|absent|unverified|invalid)$/;
const SECRET_VALUE = /(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|lbcap1\.[A-Za-z0-9_.-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/g;
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

export const REDACTED = "[redacted]";

export function scrubText(text: string): string {
  const cleaned = text.replace(SECRET_VALUE, REDACTED);
  return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…[truncated]` : cleaned;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "signature") out[k] = typeof v === "string" && SIGNATURE_STATUS.test(v) ? v : REDACTED;
      else out[k] = SECRET_KEY.test(k) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Only https links to GitHub reach the browser; anything else is dropped. */
export function githubUrlOrNull(url: string | null): string | null {
  return url !== null && /^https:\/\/github\.com\/[^\s"'<>]*$/.test(url) ? url : null;
}
