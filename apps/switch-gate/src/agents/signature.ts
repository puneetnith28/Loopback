import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * D28: Ed25519 signatures over verifier reports (Node's built-in Ed25519; no custom crypto).
 *
 * What a valid signature proves: the report was produced by a holder of the verifier's
 * private key and was not altered afterwards. It does NOT prove that the verifier ran the
 * tests it claims, or that its runtime is isolated from the fixer; those rest on OS-level
 * isolation and on the gate's own GitHub checks.
 *
 * Canonicalization contract (version 1), shared by the gate and scripts/sign-verifier-report.mjs:
 * - The signed bytes are UTF-8 of `SIGNING_CONTEXT` + canonical(report without "signature").
 * - canonical(null | boolean) = JSON literal; canonical(string) = JSON.stringify(string).
 * - canonical(number): finite only, JSON.stringify(number) (ECMAScript shortest form);
 *   NaN, ±Infinity and -0 are rejected.
 * - canonical(array) = "[" + elements in order, comma-separated + "]".
 * - canonical(object) = "{" + entries sorted by key (UTF-16 code unit order, i.e. JS default
 *   sort), each `JSON.stringify(key):canonical(value)`, comma-separated + "}".
 * - Anything else (undefined, functions, bigint, symbols, non-plain objects) is rejected.
 * Pure functions only: no filesystem or network I/O.
 */

/** Domain separation: a signature over anything else can never verify as a report. */
export const SIGNING_CONTEXT = "loopback-verifier-report-v1\n";

const ED25519_SIGNATURE_BYTES = 64;
/** 64 bytes in standard base64 with padding: 86 characters plus "==". */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
/** SPKI DER prefix for a raw 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export class PublicKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicKeyError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new CanonicalizationError("non-finite or negative-zero number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  throw new CanonicalizationError(`unsupported value of type ${typeof value}`);
}

/** The exact bytes that are signed: the context tag plus the report without its signature. */
export function signedBytes(report: Readonly<Record<string, unknown>>): Buffer {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(report)) if (k !== "signature") rest[k] = v;
  return Buffer.from(SIGNING_CONTEXT + canonicalize(rest), "utf8");
}

function assertEd25519(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") throw new PublicKeyError("the key is not an Ed25519 key");
  return key;
}

/**
 * Parse a verifier public key: a PEM "PUBLIC KEY" (SPKI) block, or the raw 32-byte key in
 * standard base64. Anything else, including non-Ed25519 keys and private keys, is rejected.
 */
export function parsePublicKey(text: string): KeyObject {
  const t = text.trim();
  let key: KeyObject;
  try {
    if (t.startsWith("-----BEGIN PUBLIC KEY-----")) {
      key = createPublicKey({ key: t, format: "pem" });
    } else {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(t)) throw new PublicKeyError("expected a PEM public key or a raw 32-byte base64 Ed25519 key");
      const raw = Buffer.from(t, "base64");
      if (raw.length !== 32) throw new PublicKeyError("a raw Ed25519 public key must be 32 bytes");
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    }
  } catch (e) {
    if (e instanceof PublicKeyError) throw e;
    throw new PublicKeyError("the public key could not be parsed");
  }
  if (key.type !== "public") throw new PublicKeyError("expected a public key");
  return assertEd25519(key);
}

/** Sign a report (used by the verifier's signing helper and by tests). Returns base64. */
export function signReport(report: Readonly<Record<string, unknown>>, privateKey: KeyObject): string {
  if (privateKey.type !== "private") throw new PublicKeyError("expected a private key");
  assertEd25519(privateKey);
  return cryptoSign(null, signedBytes(report), privateKey).toString("base64");
}

export type SignatureFailure = "missing" | "malformed" | "invalid" | "unsupported_key" | "uncanonical";
export type SignatureCheck = { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailure };

/** Verify a report's signature against the configured public key. Never throws. */
export function verifyReportSignature(report: Readonly<Record<string, unknown>>, publicKey: KeyObject): SignatureCheck {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") return { ok: false, reason: "unsupported_key" };
  const sig = report.signature;
  if (sig === undefined) return { ok: false, reason: "missing" };
  if (typeof sig !== "string" || !SIGNATURE_PATTERN.test(sig)) return { ok: false, reason: "malformed" };
  const bytes = Buffer.from(sig, "base64");
  if (bytes.length !== ED25519_SIGNATURE_BYTES || bytes.toString("base64") !== sig) return { ok: false, reason: "malformed" };
  let data: Buffer;
  try {
    data = signedBytes(report);
  } catch {
    return { ok: false, reason: "uncanonical" };
  }
  try {
    return cryptoVerify(null, data, publicKey, bytes) ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
