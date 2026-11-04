import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPullReader } from "../../apps/switch-gate/src/signer/github-pull.js";

// D29: the signer reads the PR's live head through its own allowlisting CONNECT proxy, over TLS
// with certificate verification. Exercised against a real local TLS server and CONNECT proxy.

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
// Skipped on Windows or without openssl: the test certificate is generated with openssl.
const RUN = process.platform !== "win32" && hasOpenssl;

let dir = "";
let ca = "";
let api: Server;
let proxy: Server;
let apiPort = 0;
let proxyUrl: URL;
const seen: { auth: string | undefined; path: string | undefined }[] = [];
const connects: string[] = [];
const sockets = new Set<{ destroy(): void }>();
let respond: (path: string) => { status: number; body: string } = () => ({ status: 200, body: JSON.stringify({ state: "open", head: { sha: "a".repeat(40) } }) });

beforeAll(async () => {
  if (!RUN) return;
  dir = mkdtempSync(join(tmpdir(), "loopback-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", "/CN=api.github.test", "-addext", "subjectAltName=DNS:api.github.test",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  ca = readFileSync(join(dir, "cert.pem"), "utf8");
  api = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: ca }, (req, res) => {
    seen.push({ auth: req.headers.authorization, path: req.url });
    const r = respond(req.url ?? "");
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
  api.on("connection", (c) => sockets.add(c));
  await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
  apiPort = (api.address() as AddressInfo).port;
  // A CONNECT proxy that only tunnels to the test API (like the allowlisting squid).
  proxy = createHttpServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on("connect", (req, client) => {
    client.on("error", () => undefined);
    connects.push(req.url ?? "");
    if (req.url !== `api.github.test:${apiPort}`) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    sockets.add(client);
    const upstream = connect(apiPort, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection established\r\n\r\n"); upstream.pipe(client); client.pipe(upstream); });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  proxyUrl = new URL(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
});
afterAll(async () => {
  if (!RUN) return;
  for (const c of sockets) c.destroy();
  api.closeAllConnections();
  proxy.closeAllConnections();
  await new Promise<void>((ok) => api.close(() => ok()));
  await new Promise<void>((ok) => proxy.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

const reader = (over: Partial<Parameters<typeof createPullReader>[0]> = {}) =>
  createPullReader({ proxy: proxyUrl, token: null, apiHost: "api.github.test", apiPort, ca, timeoutMs: 5000, ...over });

describe.skipIf(!RUN)("signer GitHub pull reader", () => {
  it("reads state and head through the CONNECT proxy, over verified TLS, unauthenticated by default", async () => {
    seen.length = 0;
    expect(await reader()("o/r", 42)).toEqual({ state: "open", headSha: "a".repeat(40) });
    expect(seen.at(-1)).toEqual({ auth: undefined, path: "/repos/o/r/pulls/42" });
    expect(connects.at(-1)).toBe(`api.github.test:${apiPort}`);
  });

  it("sends a configured read token as a bearer header", async () => {
    await reader({ token: "ghp_readonly" })("o/r", 1);
    expect(seen.at(-1)!.auth).toBe("Bearer ghp_readonly");
  });

  it("reports a closed PR as closed", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ state: "closed", head: { sha: "b".repeat(40) } }) });
    expect(await reader()("o/r", 1)).toEqual({ state: "closed", headSha: "b".repeat(40) });
    respond = () => ({ status: 200, body: JSON.stringify({ state: "open", head: { sha: "a".repeat(40) } }) });
  });

  it.each([
    ["a 404", { status: 404, body: "{}" }],
    ["a 500", { status: 500, body: "{}" }],
    ["invalid JSON", { status: 200, body: "{" }],
    ["a short head SHA", { status: 200, body: JSON.stringify({ state: "open", head: { sha: "abc" } }) }],
    ["an unknown state", { status: 200, body: JSON.stringify({ state: "draft", head: { sha: "a".repeat(40) } }) }],
    ["an oversized body", { status: 200, body: JSON.stringify({ state: "open", head: { sha: "a".repeat(40) }, pad: "x".repeat(2_000_000) }) }],
  ])("fails (throws) on %s", async (_n, r) => {
    respond = () => r;
    await expect(reader()("o/r", 1)).rejects.toThrow();
    respond = () => ({ status: 200, body: JSON.stringify({ state: "open", head: { sha: "a".repeat(40) } }) });
  });

  it("fails when the certificate is not trusted (no silent downgrade)", async () => {
    await expect(reader({ ca: undefined })("o/r", 1)).rejects.toThrow();
  });

  it("fails when the proxy refuses the tunnel", async () => {
    await expect(reader({ apiHost: "evil.test" })("o/r", 1)).rejects.toThrow();
  });

  it("refuses path-shaped repositories and non-positive PR numbers before any request", async () => {
    const before = connects.length;
    await expect(reader()("o/r/../../x", 1)).rejects.toThrow();
    await expect(reader()("o/r", 0)).rejects.toThrow();
    await expect(reader()("o/r", 1.5)).rejects.toThrow();
    expect(connects.length).toBe(before);
  });
});
