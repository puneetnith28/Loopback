/* eslint-disable @typescript-eslint/require-await -- test fake fetch handlers and route stubs implement async signatures */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { GitHubClient } from "../../apps/switch-gate/src/github/client.js";
import { mergePullRequest } from "../../apps/switch-gate/src/github/merge.js";
import {
  GitHubError, GitHubTransport, HeadChanged, NotMergeable, RateLimited, Uncertain, signAppJwt, type FetchFn,
} from "../../apps/switch-gate/src/github/transport.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const A = "a".repeat(40);
const B = "b".repeat(40);

type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let routes: Map<string, Handler[]>;
let calls: string[];
const fakeFetch: FetchFn = async (url, init) => {
  const u = new URL(url);
  const key = `${init.method} ${u.pathname}`;
  calls.push(`${key}${u.search}`);
  const list = routes.get(key);
  if (!list || list.length === 0) throw new Error(`unexpected ${key}`);
  const h = list.length > 1 ? list.shift()! : list[0]!;
  return h(init, u);
};
const route = (key: string, ...handlers: Handler[]) => routes.set(key, handlers);

function transport(now = () => Date.parse("2026-11-04T10:00:00Z")) {
  return new GitHubTransport({ appId: "123", installationId: "456", privateKeyPem: PEM }, { fetch: fakeFetch, now, sleep: async () => undefined });
}
const pull = (over: Record<string, unknown> = {}) => ({
  number: 42, state: "open", draft: false, merged: false, mergeable: true, merge_commit_sha: null,
  head: { sha: A, ref: "loopback/LB-001", repo: { full_name: "o/r" } }, base: { ref: "main", sha: B }, ...over,
});

beforeEach(() => {
  routes = new Map();
  calls = [];
  route("POST /app/installations/456/access_tokens", () => json(201, { token: "ghs_test", expires_at: "2026-11-04T11:00:00Z" }));
});

describe("App authentication", () => {
  it("signs a verifiable RS256 JWT with skewed iat and 10-minute expiry", () => {
    const jwt = signAppJwt("123", PEM, Date.parse("2026-11-04T10:00:00Z"));
    const [h, p, s] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(payload.iss).toBe("123");
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.iat).toBe(Date.parse("2026-11-04T10:00:00Z") / 1000 - 60);
  });

  it("caches the installation token and refreshes once on 401", async () => {
    route("GET /repos/o/r/pulls/42", () => json(401, {}), () => json(200, pull()));
    const c = new GitHubClient(transport(), "o/r", "loopback/gate", { sleep: async () => undefined });
    await c.getPull(42);
    expect(calls.filter((x) => x.startsWith("POST /app/")).length).toBe(2);
  });
});

describe("reads", () => {
  it("surface rate limits instead of waiting", async () => {
    route("GET /repos/o/r/pulls/42", () => json(403, {}, { "x-ratelimit-remaining": "0", "retry-after": "30" }));
    const c = new GitHubClient(transport(), "o/r", "loopback/gate");
    await expect(c.getPull(42)).rejects.toSatisfy((e) => e instanceof RateLimited && e.retryAfterSeconds === 30);
    route("GET /repos/o/r/pulls/42", () => json(429, {}));
    await expect(c.getPull(42)).rejects.toBeInstanceOf(RateLimited);
  });

  it("retry 5xx at most three times, then report Uncertain", async () => {
    route("GET /repos/o/r/pulls/42", () => json(502, {}));
    const c = new GitHubClient(transport(), "o/r", "loopback/gate");
    await expect(c.getPull(42)).rejects.toBeInstanceOf(Uncertain);
    expect(calls.filter((x) => x.startsWith("GET")).length).toBe(3);
  });

  it("non-retryable errors are not retried", async () => {
    route("GET /repos/o/r/pulls/42", () => json(404, {}));
    await expect(new GitHubClient(transport(), "o/r", "loopback/gate").getPull(42)).rejects.toBeInstanceOf(GitHubError);
    expect(calls.filter((x) => x.startsWith("GET")).length).toBe(1);
  });

  it("re-reads once when mergeability is still being computed", async () => {
    route("GET /repos/o/r/pulls/42", () => json(200, pull({ mergeable: null })), () => json(200, pull({ mergeable: true })));
    const p = await new GitHubClient(transport(), "o/r", "loopback/gate", { sleep: async () => undefined }).getPull(42);
    expect(p).toMatchObject({ mergeable: true, headSha: A, headRepo: "o/r", baseRef: "main" });
  });

  it("finds the open PR for a branch and refuses ambiguity", async () => {
    route("GET /repos/o/r/pulls", (_i, u) => {
      expect(u.searchParams.get("head")).toBe("o:loopback/LB-001");
      expect(u.searchParams.get("state")).toBe("open");
      return json(200, [pull()]);
    });
    const c = new GitHubClient(transport(), "o/r", "loopback/gate");
    expect((await c.findOpenPullByBranch("loopback/LB-001"))?.number).toBe(42);
    route("GET /repos/o/r/pulls", () => json(200, [pull(), pull({ number: 43 })]));
    await expect(c.findOpenPullByBranch("loopback/LB-001")).rejects.toBeInstanceOf(GitHubError);
  });

  it("paginates check runs", async () => {
    const run = (id: number) => ({ id, name: "test", status: "completed", conclusion: "success", head_sha: A, html_url: "u", app: { slug: "github-actions" } });
    route(`GET /repos/o/r/commits/${A}/check-runs`,
      () => json(200, { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => run(i + 1)) }),
      () => json(200, { total_count: 101, check_runs: [run(101)] }));
    const runs = await new GitHubClient(transport(), "o/r", "loopback/gate").listCheckRuns(A);
    expect(runs).toHaveLength(101);
    expect(runs[0]).toMatchObject({ appSlug: "github-actions", headSha: A });
  });

  it("lists changed files with renamed-from paths and refuses a possibly truncated list", async () => {
    route("GET /repos/o/r/pulls/42/files", () => json(200, [{ filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml" }, { filename: "a.js" }]));
    const c = new GitHubClient(transport(), "o/r", "loopback/gate");
    expect(await c.listPullFiles(42)).toEqual(["docs/ci.yml", ".github/workflows/ci.yml", "a.js"]);
    const page = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` }));
    route("GET /repos/o/r/pulls/42/files", () => json(200, page));
    expect(await c.listPullFiles(42)).toBeUndefined();
  });

  it("maps ruleset rules for the base branch", async () => {
    route("GET /repos/o/r/rules/branches/demo%2F20261105-0123456789abcdef", () => json(200, [
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "test", integration_id: 15368 }, { context: "loopback/gate", integration_id: 999 }] } },
      { type: "pull_request", parameters: {} }, { type: "non_fast_forward" }, { type: "deletion" },
    ]));
    const rules = await new GitHubClient(transport(), "o/r", "loopback/gate").getBranchRules("demo/20261105-0123456789abcdef");
    expect(rules).toEqual({ requiredStatusContexts: ["test", "loopback/gate"], requiresUpToDate: true, requiresPullRequest: true, blocksForcePush: true, restrictsDeletion: true });
    route("GET /repos/o/r/rules/branches/main", () => json(200, []));
    expect(await new GitHubClient(transport(), "o/r", "loopback/gate").getBranchRules("main"))
      .toEqual({ requiredStatusContexts: [], requiresUpToDate: false, requiresPullRequest: false, blocksForcePush: false, restrictsDeletion: false });
  });
});

describe("snapshot", () => {
  const wire = (afterHead: string) => {
    route("GET /repos/o/r/pulls/42", () => json(200, pull()), () => json(200, pull({ head: { sha: afterHead, ref: "loopback/LB-001", repo: { full_name: "o/r" } } })));
    route(`GET /repos/o/r/commits/${A}/check-runs`, () => json(200, { total_count: 0, check_runs: [] }));
    route("GET /repos/o/r/pulls/42/files", () => json(200, [{ filename: "a.js" }]));
    route("GET /repos/o/r/rules/branches/main", () => json(200, []));
  };
  it("binds the changed files to the head read before them", async () => {
    wire(B);
    const { snapshot } = await new GitHubClient(transport(), "o/r", "loopback/gate", { sleep: async () => undefined }).snapshot(42);
    expect(snapshot.pr?.headSha).toBe(B);
    expect(snapshot.changedFilesHeadSha).toBe(A); // policy will block: files not read at the live head
  });
  it("returns undefined fields on read failures, but propagates rate limits", async () => {
    route("GET /repos/o/r/pulls/42", () => json(404, {}));
    const c = new GitHubClient(transport(), "o/r", "loopback/gate");
    expect((await c.snapshot(42)).snapshot.pr).toBeUndefined();
    route("GET /repos/o/r/pulls/42", () => json(429, {}));
    await expect(c.snapshot(42)).rejects.toBeInstanceOf(RateLimited);
  });
});

describe("gate status", () => {
  it("posts the configured context and fails loudly otherwise", async () => {
    route(`POST /repos/o/r/statuses/${A}`, (init) => {
      expect(JSON.parse(init.body as string)).toMatchObject({ state: "success", context: "loopback/gate" });
      return json(201, {});
    });
    const c = new GitHubClient(transport(), "o/r", "loopback/gate");
    await c.setGateStatus(A, "success", "Approved by Loopback");
    route(`POST /repos/o/r/statuses/${A}`, () => json(422, {}));
    await expect(c.setGateStatus(A, "failure", "x")).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("merge", () => {
  const mergeKey = "PUT /repos/o/r/pulls/42/merge";
  it("sends the sha precondition with squash and reports the result", async () => {
    route(mergeKey, (init) => {
      expect(JSON.parse(init.body as string)).toEqual({ sha: A, merge_method: "squash" });
      return json(200, { merged: true, sha: B });
    });
    expect(await mergePullRequest(transport(), "o/r", 42, A)).toEqual({ merged: true, sha: B });
  });
  it("classifies 409, 405, 5xx and network failures, never retrying", async () => {
    for (const [status, cls] of [[409, HeadChanged], [405, NotMergeable], [502, Uncertain], [422, GitHubError]] as const) {
      calls = [];
      route(mergeKey, () => json(status, {}));
      await expect(mergePullRequest(transport(), "o/r", 42, A)).rejects.toBeInstanceOf(cls);
      expect(calls.filter((c) => c.startsWith("PUT")).length).toBe(1);
    }
    calls = [];
    route(mergeKey, () => { throw new TypeError("socket hang up"); });
    await expect(mergePullRequest(transport(), "o/r", 42, A)).rejects.toBeInstanceOf(Uncertain);
    expect(calls.filter((c) => c.startsWith("PUT")).length).toBe(1);
  });
  it("refuses a non-full SHA without calling GitHub", async () => {
    await expect(mergePullRequest(transport(), "o/r", 42, "3f9c2ab")).rejects.toBeInstanceOf(GitHubError);
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });
});

describe("response validation (TypeScript review fixes)", () => {
  it("rejects malformed JSON and unexpected pull shapes; snapshot then fails closed", async () => {
    const c = new GitHubClient(transport(), "o/r", "loopback/gate", { sleep: async () => undefined });
    route("GET /repos/o/r/pulls/42", () => new Response("<html>proxy error</html>", { status: 200 }));
    await expect(c.getPull(42)).rejects.toBeInstanceOf(GitHubError);
    route("GET /repos/o/r/pulls/42", () => json(200, pull({ head: { sha: "short", ref: "x", repo: null } })));
    await expect(c.getPull(42)).rejects.toBeInstanceOf(GitHubError);
    expect((await c.snapshot(42)).snapshot.pr).toBeUndefined();
  });
  it("a malformed token expiry fails instead of minting a token on every call", async () => {
    route("POST /app/installations/456/access_tokens", () => json(201, { token: "ghs_x", expires_at: "soon" }));
    route("GET /repos/o/r/pulls/42", () => json(200, pull()));
    await expect(new GitHubClient(transport(), "o/r", "loopback/gate").getPull(42)).rejects.toBeInstanceOf(GitHubError);
  });
});
