/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCase } from "../../apps/switch-gate/src/cases/service.js";
import type { GitHubClient, PullDetails } from "../../apps/switch-gate/src/github/client.js";
import { migrate, openDatabase } from "../../apps/switch-gate/src/persistence/db.js";
import { runGate, type RunDeps } from "../../apps/switch-gate/src/run.js";
import type { SocketLike } from "../../apps/switch-gate/src/switch/connection.js";
import { FakeGitHub } from "../helpers/harness.js";

/** POSIX-only: the code under test depends on Linux behaviour (see the reason at each skip). */
const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: runGate enforces POSIX permissions on the GitHub App key, which cannot be expressed on Windows (the gate is deployed on Linux only).

// Step 9.7: the gate's real lifecycle (runGate, as main.ts runs it) with the process signal
// source replaced by an EventEmitter. Switch's HTTP API and sockets and GitHub are fakes.

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const USER = "2a8934be-9a66-4944-a410-456e9e23b98c";
const AGENT_POLICY = "11111111-2222-4333-8444-555555555555";
const MROOM = "8aeb4229-d129-47c8-93d6-ec4f37d623e3";
const IROOM = "99999999-2222-4333-8444-555555555555";

const switchPolicy = {
  result: { id: AGENT, addressing_policy: { rules: [
    { rooms: [MROOM], room_groups: "*", users: [USER], agents: [AGENT_POLICY], owner: false, owner_agents: false, platform: false },
    { rooms: [IROOM], room_groups: "*", users: "*", agents: [], owner: false, owner_agents: false, platform: false },
  ] } },
};
const switchOps = { operations: { post_message: {}, read_context: {} } };

/** A port the OS reports free right now (avoids collisions between parallel test files). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  await new Promise<void>((r) => srv.close(() => r()));
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  return addr.port;
}

let dir = "";
let port = 0;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fakeSwitchFetch = (async (url: string) => {
  if (url.endsWith("/ops/get_agent_detail")) return json(switchPolicy);
  if (url.endsWith("/ops")) return json(switchOps);
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SWITCH_BRIDGE_URL: "http://127.0.0.1:1", SWITCH_AGENT_ID: AGENT, SWITCH_AGENT_API_KEY: "test-key",
    SWITCH_ROOM_ID: MROOM, SWITCH_INTAKE_ROOM_ID: IROOM, SWITCH_SELF_ID: "@switch-agent-gate:loopback",
    SWITCH_POLICY_USER_IDS: USER, SWITCH_POLICY_AGENT_IDS: AGENT_POLICY,
    LOOPBACK_MAINTAINERS: "@switch-user-a1:loopback", LOOPBACK_REPORTERS: "@switch-user-a1:loopback",
    LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback", LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
    GH_REPO: "o/r", GH_APP_ID: "123", GH_APP_INSTALLATION_ID: "456", GH_APP_PRIVATE_KEY_PATH: join(dir, "gate.pem"),
    BASE_BRANCH: "main", REQUIRED_CHECKS: "test", CHECK_SOURCES: "test:github-actions", REQUIRED_CHECK_INTEGRATIONS: "test:15368",
    DB_PATH: join(dir, "loopback.db"), HTTP_PORT: String(port), POLL_INTERVAL_MS: "60000",
    ...extra,
  };
}

interface Run { result: Promise<number>; signals: EventEmitter; sockets: { closed: boolean }[]; logs: string[]; timedOut: () => boolean }

function start(over: Partial<RunDeps> = {}, gh = new FakeGitHub(), extraEnv: Record<string, string> = {}): Run {
  const signals = new EventEmitter();
  const sockets: { closed: boolean }[] = [];
  const logs: string[] = [];
  const record = (_o: unknown, m: string) => { logs.push(m); };
  const log = { info: record, warn: record, error: record, fatal: record, debug: () => undefined, trace: () => undefined } as unknown as Logger;
  let timedOut = false;
  const result = runGate({
    env: env(extraEnv), fetch: fakeSwitchFetch, log, signals,
    github: gh as unknown as GitHubClient,
    openSocket: () => {
      const s = { closed: false };
      sockets.push(s);
      const sock: SocketLike = {
        onmessage: null, onclose: null, onerror: null,
        send: () => undefined,
        close: () => { s.closed = true; sock.onclose?.({ code: 1000, reason: "" }); },
      };
      return sock;
    },
    onShutdownTimeout: () => { timedOut = true; },
    ...over,
  });
  return { result, signals, sockets, logs, timedOut: () => timedOut };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const healthy = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200;
  } catch {
    return false;
  }
};
function seedOpenCase(): void {
  const db = openDatabase(join(dir, "loopback.db"));
  migrate(db);
  createCase(db, { reporterId: "@r:x", roomId: MROOM, threadId: null, repo: "o/r", reportText: "a seeded bug report", sourceEventId: "seed" }, new Date());
  db.prepare("UPDATE cases SET state = 'FixInProgress', branch = 'loopback/LB-001' WHERE id = 'LB-001'").run();
  db.close();
}
/** GitHub blocks inside startup reconciliation until released. */
function blockingGitHub(): { gh: FakeGitHub; reached: () => boolean; release: () => void } {
  const gh = new FakeGitHub();
  let reached = false;
  let release: (v: PullDetails | undefined) => void = () => undefined;
  gh.findOpenPullByBranch = () => { reached = true; return new Promise((r) => { release = r; }); };
  return { gh, reached: () => reached, release: () => release(undefined) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "loopback-run-"));
  writeFileSync(join(dir, "gate.pem"), "not used: GitHub is faked in this test", { mode: 0o600 });
  port = await freePort();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(ON_WINDOWS)("runGate signal handling (step 9.7)", () => {
  it("handles SIGTERM during startup reconciliation: finishes the running work, never connects, exits 0", async () => {
    seedOpenCase();
    // Hold the health port: if shutdown let startup continue, binding it would fail (exit 1).
    const portHolder: Server = createServer();
    await new Promise<void>((r) => portHolder.listen(port, "127.0.0.1", r));
    const b = blockingGitHub();
    const run = start({}, b.gh);
    await until(b.reached); // startup reconciliation is polling LB-001 and blocked on GitHub
    expect(run.signals.listenerCount("SIGTERM")).toBe(1); // installed before reconciliation
    run.signals.emit("SIGTERM");
    run.signals.emit("SIGTERM"); // idempotent
    run.signals.emit("SIGINT");
    b.release();
    expect(await run.result).toBe(0); // never tried to bind the held health port
    portHolder.close();
    expect(run.sockets).toHaveLength(0); // never connected to Switch
    expect(run.logs.filter((l) => l === "shutting down")).toHaveLength(1);
    expect(run.logs.filter((l) => l === "already shutting down")).toHaveLength(2);
    expect(run.signals.listenerCount("SIGTERM") + run.signals.listenerCount("SIGINT")).toBe(0);
    // The database was closed cleanly after the reconciliation finished.
    const db = openDatabase(join(dir, "loopback.db"));
    expect(db.prepare("SELECT state FROM cases WHERE id = 'LB-001'").get()).toEqual({ state: "FixInProgress" });
    db.close();
  });

  it("handles SIGINT after full startup: stops both rooms, closes health and the database, exits 0", async () => {
    const run = start();
    await until(healthy);
    expect(run.sockets).toHaveLength(2); // one connection per room
    run.signals.emit("SIGINT");
    expect(await run.result).toBe(0);
    expect(run.sockets.every((s) => s.closed)).toBe(true);
    expect(await healthy()).toBe(false);
    expect(run.signals.listenerCount("SIGTERM") + run.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("cleans up a partial startup (health port taken) and exits 1, removing its handlers", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    try {
      const run = start();
      expect(await run.result).toBe(1);
      expect(run.sockets).toHaveLength(2);
      expect(run.sockets.every((s) => s.closed)).toBe(true); // the rooms started were stopped
      expect(run.signals.listenerCount("SIGTERM") + run.signals.listenerCount("SIGINT")).toBe(0);
      expect(run.logs).toContain("startup failed");
    } finally {
      blocker.close();
    }
  });

  it("reports a shutdown that hangs past its timeout instead of hanging silently", async () => {
    seedOpenCase();
    const b = blockingGitHub();
    const run = start({ shutdownTimeoutMs: 50 }, b.gh);
    await until(b.reached);
    run.signals.emit("SIGTERM");
    await until(run.timedOut, 2000); // reconciliation is still blocked: the backstop fires
    expect(run.logs).toContain("shutdown did not finish in time");
    b.release();
    expect(await run.result).toBe(0);
  });

  it("a configuration error exits 1 and leaves no handlers behind", async () => {
    const run = start({}, new FakeGitHub(), { SWITCH_INTAKE_ROOM_ID: "" });
    expect(await run.result).toBe(1);
    expect(run.signals.listenerCount("SIGTERM") + run.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("a takeover is terminal: exit code 3, no reconnect, no retry (steps 3.4/3.5 under D23)", async () => {
    const opened: string[] = [];
    let first: SocketLike | null = null;
    const run = start({
      openSocket: (url) => {
        opened.push(url);
        const sock: SocketLike = { onmessage: null, onclose: null, onerror: null, send: () => undefined, close: () => undefined };
        if (first === null) first = sock;
        const id = new URL(url).searchParams.get("connection_id");
        const room = new URL(url).searchParams.get("rooms");
        setTimeout(() => {
          sock.onmessage?.({ data: JSON.stringify({ event: "connection_state", data: {
            connection_id: id, agent_id: AGENT, generation: 8589934592, rooms: [room], cursor: 0, position: { s: 1 }, protocol: 9, heartbeat_interval_seconds: 2,
          } }) });
        }, 5);
        return sock;
      },
    });
    await until(healthy);
    const count = opened.length;
    (first as SocketLike | null)?.onmessage?.({ data: JSON.stringify({ event: "evicted", data: { code: "taken_over", reason: "another client", room_id: null } }) });
    expect(await run.result).toBe(3);
    expect(opened.length).toBe(count); // nothing reopened
    expect(run.logs.some((l) => /stopped for good/.test(l))).toBe(true);
  });
});
