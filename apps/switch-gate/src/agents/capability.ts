import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { CaseId, FullSha, RepoSlug } from "@loopback/contracts";
import { z } from "zod";
import { canonicalize } from "./signature.js";

/**
 * D29: run capabilities. For every verification run the gate issues a short-lived token,
 * signed with its own Ed25519 run-issuer key, naming exactly one run context (run id, case,
 * repository, PR, full head SHA). The verifier signer signs a report only when it presents
 * a valid capability for the same context. The capability is not secret (it is posted in the
 * room); it proves that the gate issued this run, nothing more.
 *
 * Format: "lbcap1." + base64url(UTF-8 JSON payload) + "." + base64url(64-byte signature).
 * Signed bytes: UTF-8 of CAPABILITY_CONTEXT + canonicalize(payload) (see signature.ts).
 * Pure functions only.
 */

export const CAPABILITY_PREFIX = "lbcap1";
export const CAPABILITY_CONTEXT = "loopback-run-capability-v1\n";
/** A capability never lives longer than a day, whatever the issuer asks for. */
export const CAPABILITY_MAX_TTL_MS = 24 * 60 * 60_000;
/** Tolerated clock difference between gate and signer. */
export const CAPABILITY_MAX_SKEW_MS = 60_000;
const MAX_TOKEN_CHARS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;
const SIG_B64URL = /^[A-Za-z0-9_-]{86}$/;

export const RunContext = z.object({
  runId: z.string().uuid(),
  caseId: CaseId,
  repository: RepoSlug,
  pullRequest: z.number().int().positive(),
  headSha: FullSha,
}).strict();
export type RunContext = z.infer<typeof RunContext>;

const IsoTime = z.string().datetime();
const CapabilityPayload = RunContext.extend({ v: z.literal(1), issuedAt: IsoTime, expiresAt: IsoTime }).strict()
  .refine((p) => {
    const life = Date.parse(p.expiresAt) - Date.parse(p.issuedAt);
    return life > 0 && life <= CAPABILITY_MAX_TTL_MS;
  }, "lifetime must be in (0, max]");
export type RunCapability = z.infer<typeof CapabilityPayload>;

export type CapabilityFailure = "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "unsupported_key";
export type CapabilityCheck = { readonly ok: true; readonly capability: RunCapability } | { readonly ok: false; readonly reason: CapabilityFailure };

const isEd25519 = (k: KeyObject, type: "public" | "private") => k.type === type && k.asymmetricKeyType === "ed25519";
const bytesOf = (payload: unknown) => Buffer.from(CAPABILITY_CONTEXT + canonicalize(payload), "utf8");

function encode(payload: Record<string, unknown>, issuerKey: KeyObject): string {
  if (!isEd25519(issuerKey, "private")) throw new Error("the run-issuer key must be an Ed25519 private key");
  const sig = cryptoSign(null, bytesOf(payload), issuerKey);
  return `${CAPABILITY_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${sig.toString("base64url")}`;
}

/** Issue a capability for one run. Throws on an invalid context, key or lifetime. */
export function issueCapability(ctx: RunContext, issuerKey: KeyObject, issuedAt: Date, ttlMs: number): string {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > CAPABILITY_MAX_TTL_MS) throw new Error("capability lifetime must be in (0, 24h]");
  const run = RunContext.parse(ctx);
  const payload = { v: 1, ...run, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString() };
  return encode(CapabilityPayload.parse(payload), issuerKey);
}

/** Tests only: sign an arbitrary payload, to prove the verifier's schema checks hold for the real key. */
export function issueUncheckedCapabilityForTests(payload: Record<string, unknown>, issuerKey: KeyObject): string {
  return encode(payload, issuerKey);
}

/** Verify a capability. Never throws. The signature is checked before the payload is trusted. */
export function verifyCapability(token: unknown, issuerPublicKey: KeyObject, now: Date, maxSkewMs = CAPABILITY_MAX_SKEW_MS): CapabilityCheck {
  if (!isEd25519(issuerPublicKey, "public")) return { ok: false, reason: "unsupported_key" };
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CAPABILITY_PREFIX || !B64URL.test(parts[1]!) || !SIG_B64URL.test(parts[2]!)) return { ok: false, reason: "malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let signed: Buffer;
  try {
    signed = bytesOf(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const sig = Buffer.from(parts[2]!, "base64url");
  let valid: boolean;
  try {
    valid = sig.length === 64 && cryptoVerify(null, signed, issuerPublicKey, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  const parsed = CapabilityPayload.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const t = now.getTime();
  if (t + maxSkewMs < Date.parse(parsed.data.issuedAt)) return { ok: false, reason: "not_yet_valid" };
  if (t > Date.parse(parsed.data.expiresAt)) return { ok: false, reason: "expired" };
  return { ok: true, capability: parsed.data };
}
