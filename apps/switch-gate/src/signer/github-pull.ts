import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { FullSha, RepoSlug } from "@loopback/contracts";
import type { LivePull } from "./policy.js";

/**
 * D29: the signer's only outbound call: GET /repos/{owner}/{repo}/pulls/{n} on the GitHub API,
 * through its own allowlisting CONNECT proxy, over TLS with certificate verification (Node's
 * default CA store unless `ca` is given, which only tests use). Unauthenticated unless a
 * read-only token is configured. Any failure throws; the policy then refuses to sign.
 */

export interface PullReaderOptions {
  readonly proxy: URL | null;
  readonly token: string | null;
  readonly apiHost?: string;
  readonly apiPort?: number;
  readonly ca?: string | undefined;
  readonly timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

function tunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 80), method: "CONNECT", path: `${host}:${port}`, timeout: timeoutMs });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy refused the tunnel (${res.statusCode})`)); return; }
      resolve(socket);
    });
    req.once("timeout", () => req.destroy(new Error("proxy timeout")));
    req.once("error", reject);
    req.end();
  });
}

export function createPullReader(o: PullReaderOptions): (repository: string, pullRequest: number) => Promise<LivePull> {
  const host = o.apiHost ?? "api.github.com";
  const port = o.apiPort ?? 443;
  const timeoutMs = o.timeoutMs ?? 10_000;
  return async (repository, pullRequest) => {
    if (!RepoSlug.safeParse(repository).success || repository.split("/").length !== 2) throw new Error("invalid repository");
    if (!Number.isInteger(pullRequest) || pullRequest <= 0) throw new Error("invalid pull request number");
    const [owner, name] = repository.split("/") as [string, string];
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest}`;
    const socket = o.proxy === null ? null : await tunnel(o.proxy, host, port, timeoutMs);
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest({
        host, port, path, method: "GET", timeout: timeoutMs, ...(o.ca === undefined ? {} : { ca: o.ca }),
        headers: { accept: "application/vnd.github+json", "user-agent": "loopback-verifier-signer", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        ...(socket === null ? {} : { createConnection: () => tlsConnect({ socket, servername: host, ...(o.ca === undefined ? {} : { ca: o.ca }) }) }),
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`GitHub answered ${res.statusCode}`)); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error("GitHub response too large")); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
      req.once("timeout", () => req.destroy(new Error("GitHub timeout")));
      req.once("error", reject);
      req.end();
    }).finally(() => socket?.destroy());
    const json = JSON.parse(body) as { state?: unknown; head?: { sha?: unknown } };
    if (json.state !== "open" && json.state !== "closed") throw new Error("unexpected pull request state");
    const sha = FullSha.safeParse(json.head?.sha);
    if (!sha.success) throw new Error("unexpected head SHA");
    return { state: json.state, headSha: sha.data };
  };
}
