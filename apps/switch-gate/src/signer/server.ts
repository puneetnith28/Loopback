import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { evaluateSignRequest, type SignerPolicyDeps } from "./policy.js";

/**
 * D29: the signer's HTTP boundary (inside its container, reachable only on the network it
 * shares with the verifier). POST /v1/sign with `Authorization: Bearer <client token>` and a
 * JSON body; GET /healthz. The token is checked before the body is read; bodies are capped;
 * authenticated requests are rate-limited; logs carry codes and digests, never the token,
 * the report text or the signature.
 */

export const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export interface SignerServerOptions {
  /** The shared client token (at least 32 characters). */
  readonly clientToken: string;
  readonly policy: SignerPolicyDeps;
  readonly log: (line: Record<string, unknown>) => void;
  /** Authenticated requests per rolling minute. */
  readonly maxPerMinute: number;
}

export type SignerServer = Server;

const digestOf = (s: string) => createHash("sha256").update(s, "utf8").digest();

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { over = true; return; }
      if (!over) chunks.push(c);
    });
    req.on("end", () => resolve(over ? "too_large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createSignerServer(o: SignerServerOptions): SignerServer {
  if (o.clientToken.length < 32) throw new Error("the signer client token must be at least 32 characters");
  if (!Number.isInteger(o.maxPerMinute) || o.maxPerMinute <= 0) throw new Error("maxPerMinute must be a positive integer");
  const expected = digestOf(`Bearer ${o.clientToken}`);
  const recent: number[] = [];

  const authenticated = (req: IncomingMessage) => {
    const given = req.headers.authorization;
    return typeof given === "string" && timingSafeEqual(digestOf(given), expected);
  };
  const rateLimited = () => {
    const now = Date.now();
    while (recent.length > 0 && now - recent[0]! > 60_000) recent.shift();
    if (recent.length >= o.maxPerMinute) return true;
    recent.push(now);
    return false;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz" && req.method === "GET") return send(res, 200, { ok: true });
    if (path !== "/v1/sign") return send(res, 404, { error: "NOT_FOUND" });
    if (req.method !== "POST") return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    if (!authenticated(req)) {
      o.log({ event: "sign.refused", code: "UNAUTHENTICATED" });
      return send(res, 401, { error: "UNAUTHENTICATED" });
    }
    if (rateLimited()) {
      o.log({ event: "sign.refused", code: "RATE_LIMITED" });
      return send(res, 429, { error: "RATE_LIMITED" });
    }
    if (!/^application\/json(\s*;|$)/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
    const raw = await readBody(req);
    if (raw === "too_large") return send(res, 413, { error: "TOO_LARGE" });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { error: "MALFORMED" });
    }
    const decision = await evaluateSignRequest(body, o.policy);
    if (!decision.ok) {
      o.log({ event: "sign.refused", code: decision.code });
      return send(res, decision.status, { error: decision.code });
    }
    o.log({ event: "sign.issued", runId: decision.runId, reportDigest: decision.reportDigest });
    return send(res, 200, { signature: decision.signature, reportDigest: decision.reportDigest });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      o.log({ event: "sign.error", code: "INTERNAL" });
      if (!res.headersSent) send(res, 500, { error: "INTERNAL" });
      else res.destroy();
    });
  });
  server.requestTimeout = TIMEOUT_MS;
  server.headersTimeout = TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  return server;
}
