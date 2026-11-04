/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "@loopback/contracts";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGate, type Gate } from "../../apps/switch-gate/src/app.js";
import { loadGitHubConfig, loadIdentityConfig, loadRuntimeConfig, loadSwitchConfig } from "../../apps/switch-gate/src/config.js";
import type { GitHubClient, PullDetails } from "../../apps/switch-gate/src/github/client.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";
import { FakeGitHub } from "../helpers/harness.js";

// The real composition root (createGate) built from the real config loaders, with GitHub
// faked. Proves the wiring the unit tests cannot: safety flags off by default, the gate's
// own rooms, and that shutdown waits for background work (step 9.7).

const MAINT = "@switch-user-a1:loopback";
const OUTSIDER = "@switch-user-zz:loopback";
const MROOM = "room-1";
const IROOM = "room-2";
const G = "@loopback-gate";

let dir = "";
let errors: string[] = [];
const log = {
  info: () => undefined, warn: () => undefined, debug: () => undefined, trace: () => undefined, fatal: () => undefined,
  error: (_o: unknown, m: string) => { errors.push(m); },
} as unknown as Logger;

function build(extra: Record<string, string> = {}): { gate: Gate; gh: FakeGitHub; posts: { room: string; content: string }[] } {
  const env: Record<string, string> = {
    SWITCH_BRIDGE_URL: "http://127.0.0.1:37203", SWITCH_AGENT_ID: "agent-1", SWITCH_AGENT_API_KEY: "test-key",
    SWITCH_ROOM_ID: MROOM, SWITCH_INTAKE_ROOM_ID: IROOM, SWITCH_SELF_ID: "@switch-agent-gate:loopback",
    SWITCH_POLICY_USER_IDS: "2a8934be-9a66-4944-a410-456e9e23b98c", SWITCH_POLICY_AGENT_IDS: "11111111-2222-4333-8444-555555555555",
    LOOPBACK_MAINTAINERS: MAINT, LOOPBACK_REPORTERS: MAINT, LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback",
    LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
    GH_REPO: "o/r", GH_APP_ID: "123", GH_APP_INSTALLATION_ID: "456", GH_APP_PRIVATE_KEY_PATH: join(dir, "gate.pem"),
    BASE_BRANCH: "main", REQUIRED_CHECKS: "test", CHECK_SOURCES: "test:github-actions", REQUIRED_CHECK_INTEGRATIONS: "test:15368",
    DB_PATH: join(dir, "loopback.db"), POLL_INTERVAL_MS: "1000",
    ...extra,
  };
  const cfg = {
    runtime: loadRuntimeConfig(env), switch: loadSwitchConfig(env), identity: loadIdentityConfig(env),
    github: loadGitHubConfig(env, { checkKeyFile: false }),
  };
  const gh = new FakeGitHub();
  const posts: { room: string; content: string }[] = [];
  const chat = { post: async (room: string, content: string) => { posts.push({ room, content }); } };
  const gate = createGate(cfg, chat, log, { github: gh as unknown as GitHubClient });
  return { gate, gh, posts };
}

let seq = 0;
const msg = (sender: string, body: string, roomId = MROOM): InboundMessage => {
  seq += 1;
  return { eventId: `c${seq}`, roomId, sequence: seq, messageId: `c${seq}`, sender, senderKind: null, onBehalfOf: null, senderRole: null, addressed: true, body, threadId: null, timestamp: seq };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loopback-compose-"));
  writeFileSync(join(dir, "gate.pem"), "not used: GitHub is faked in this test", { mode: 0o600 });
  errors = [];
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("composition root (createGate)", () => {
  it("defaults keep privileged commands and merging off, and refuses them visibly", async () => {
    const { gate, posts } = build();
    await gate.router.handle(msg(MAINT, `${G} merge LB-001`));
    expect(posts.at(-1)?.content).toMatch(/PRIVILEGED_DISABLED/);
    await gate.router.handle(msg(MAINT, `${G} approve LB-001 ${"a".repeat(40)}`));
    expect(posts.at(-1)?.content).toMatch(/PRIVILEGED_DISABLED/);
    await gate.drain();
    gate.stop();
  });

  it("serves both configured rooms and nothing else", async () => {
    const { gate, posts } = build();
    await gate.router.handle(msg(OUTSIDER, `${G} report slugify drops the percent sign`, IROOM));
    expect(posts.find((p) => p.room === IROOM)?.content).toMatch(/received as LB-001/);
    expect(posts.find((p) => p.room === MROOM)?.content).toMatch(/awaiting triage/);
    const before = posts.length;
    await gate.router.handle(msg(MAINT, `${G} help`, "some-other-room"));
    expect(posts.length).toBe(before);
    await gate.drain();
    gate.stop();
  });

  it("drain() waits for a running background poll before the database is closed", async () => {
    vi.useFakeTimers();
    const { gate, gh } = build();
    await gate.router.handle(msg(MAINT, `${G} report slugify drops the percent sign`));
    expect(getCase(gate.db, "LB-001")?.state).toBe("FixInProgress");
    await gate.start();

    let release: (v: PullDetails | undefined) => void = () => undefined;
    let polled = 0;
    gh.findOpenPullByBranch = () => { polled += 1; return new Promise((r) => { release = r; }); };
    await vi.advanceTimersByTimeAsync(1000); // the poll task starts and blocks on GitHub
    expect(polled).toBe(1);

    let drained = false;
    const draining = gate.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(drained).toBe(false); // still waiting for the poll
    expect(polled).toBe(1); // and no new task was scheduled
    release(undefined);
    await draining;
    gate.stop();
    expect(gate.db.open).toBe(false);
    expect(errors).toEqual([]); // the poll finished against an open database
  });

  it("schedules no background work when draining began during startup", async () => {
    vi.useFakeTimers();
    const { gate, gh } = build();
    await gate.router.handle(msg(MAINT, `${G} report slugify drops the percent sign`));
    let release: (v: PullDetails | undefined) => void = () => undefined;
    let polled = 0;
    gh.findOpenPullByBranch = () => { polled += 1; return new Promise((r) => { release = r; }); };
    const starting = gate.start(); // blocks in startup reconciliation
    await vi.advanceTimersByTimeAsync(0);
    expect(polled).toBe(1);
    await gate.drain(); // shutdown begins while start() is still running
    release(undefined);
    await starting;
    expect(vi.getTimerCount()).toBe(0); // no interval was created to keep the process alive
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polled).toBe(1); // no periodic poll was ever scheduled
    gate.stop();
  });
});
