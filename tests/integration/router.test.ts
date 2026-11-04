/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
/* eslint-disable @typescript-eslint/unbound-method -- asserting on vi.fn() mocks, which are not bound methods */
import type { InboundMessage, ReasonCode } from "@loopback/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRecent } from "../../apps/switch-gate/src/audit/index.js";
import type { ChatPort } from "../../apps/switch-gate/src/chat/port.js";
import { Router, type PrivilegedHandlers, type RouterDeps } from "../../apps/switch-gate/src/commands/router.js";
import { migrate, openDatabase, type Db } from "../../apps/switch-gate/src/persistence/db.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";

const MAINT = "@switch-user-maint:x";
const REP = "@switch-user-rep:x";
const OUT = "@switch-user-out:x";
const FIXER = "@switch-agent-fixer:x";
const VERIFIER = "@switch-agent-verifier:x";
const G = "@loopback-gate";

let db: Db;
let posts: { roomId: string; content: string; threadId: string | null }[];
let seq = 0;
let deps: RouterDeps;
let router: Router;
let baseProblem: ReasonCode | null;

const msg = (sender: string, body: string, over: Partial<InboundMessage> = {}): InboundMessage => {
  seq += 1;
  return {
    eventId: `m${seq}`, roomId: "room", sequence: seq, messageId: `m${seq}`, sender, senderKind: "member",
    onBehalfOf: null, addressed: true, body, threadId: null, timestamp: seq, ...over,
  };
};

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  posts = [];
  baseProblem = null;
  const chat: ChatPort = { post: async (roomId, content, threadId) => { posts.push({ roomId, content, threadId }); } };
  const reply = (text: string) => async () => ({ text, caseId: null });
  const privileged: PrivilegedHandlers = {
    verify: vi.fn(reply("verify")), approve: vi.fn(reply("approve")), reject: vi.fn(reply("reject")),
    merge: vi.fn(reply("merge")), retask: vi.fn(reply("retask")),
  };
  deps = {
    db, chat, fixerId: FIXER, verifierId: VERIFIER, gateMention: G, repo: "o/r", quorum: 1, requiredChecks: ["test"],
    identity: { maintainers: new Set([MAINT]), reporters: new Set([REP]), agentSenders: new Set([FIXER, VERIFIER]), humanSenderKind: "member" },
    privileged,
    handoff: { check: async () => baseProblem, message: (c) => `@loopback-fixer fix ${c.id}` },
    agents: { onAgentMessage: vi.fn(async () => undefined) },
    now: () => new Date("2026-11-04T10:00:00Z"),
  };
  router = new Router(deps);
});
afterEach(() => db.close());

describe("report flow", () => {
  it("creates a case, tasks the fixer after persisting, and replies", async () => {
    await router.handle(msg(REP, `${G} report slugify.extend({'%': null}) throws TypeError`));
    const c = getCase(db, "LB-001")!;
    expect(c.state).toBe("FixInProgress");
    expect(posts[0]!.content).toBe("@loopback-fixer fix LB-001");
    expect(posts[1]!.content).toContain("LB-001 created");
    expect(listRecent(db, "LB-001").map((r) => r.type)).toEqual(["fixer.started", "case.state_changed", "case.created"]);
  });

  it("a failed base check blocks the new case and tasks nobody (D17)", async () => {
    baseProblem = "BASE_COMMIT_MISMATCH";
    await router.handle(msg(MAINT, `${G} report something broke badly here`));
    expect(getCase(db, "LB-001")).toMatchObject({ state: "Blocked", blockedReason: "BASE_COMMIT_MISMATCH" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content).toContain("BASE_COMMIT_MISMATCH");
  });

  it("a redelivered report is a no-op", async () => {
    const m = msg(REP, `${G} report slugify crashes on null charmap`);
    await router.handle(m);
    await router.handle(m);
    expect(db.prepare("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 1 });
    expect(posts).toHaveLength(2);
  });
});

describe("refusals are visible and audited", () => {
  it("an outsider approve is refused and audited (Day-1 exit)", async () => {
    await router.handle(msg(REP, `${G} report slugify crashes on null charmap`));
    await router.handle(msg(OUT, `${G} approve LB-001 ${"3f9c2ab4e1d0b4c9a8f7e6d5c4b3a2918f7e6d5c"}`));
    expect(posts.at(-1)!.content).toMatch(/^\[LB-001\] REFUSED \(NOT_AUTHORIZED\): approve requires the maintainer role/);
    expect(listRecent(db, "LB-001")[0]).toMatchObject({ type: "command.refused", reasonCode: "NOT_AUTHORIZED", actorId: OUT });
    expect(deps.privileged.approve).not.toHaveBeenCalled();
  });

  it("an outsider report is refused (D20)", async () => {
    await router.handle(msg(OUT, `${G} report this should not create a case`));
    expect(getCase(db, "LB-001")).toBeUndefined();
    expect(posts[0]!.content).toMatch(/NOT_AUTHORIZED/);
  });

  it("owner-attributed agent messages cannot approve or merge (D16)", async () => {
    await router.handle(msg(MAINT, `${G} merge LB-001`, { onBehalfOf: MAINT }));
    await router.handle(msg(MAINT, `${G} approve LB-001 ${"3f9c2ab4e1d0b4c9a8f7e6d5c4b3a2918f7e6d5c"}`, { senderKind: "agent" }));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(deps.privileged.approve).not.toHaveBeenCalled();
    expect(posts.every((p) => p.content.includes("NOT_AUTHORIZED"))).toBe(true);
  });

  it("an agent addressing a command to the gate is refused", async () => {
    await router.handle(msg(FIXER, `${G} merge LB-001`));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(posts[0]!.content).toMatch(/NOT_AUTHORIZED/);
  });

  it("unknown commands get usage and are audited", async () => {
    await router.handle(msg(MAINT, `${G} deploy now`));
    expect(posts[0]!.content).toMatch(/^REFUSED \(UNKNOWN_COMMAND\)/);
    expect((db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'command.refused'").get() as { n: number }).n).toBe(1);
  });

  it("refusals of demoted (non-addressed) mentions are still audited", async () => {
    await router.handle(msg(OUT, `${G} merge LB-001`, { addressed: false }));
    expect(posts[0]!.content).toMatch(/NOT_AUTHORIZED/);
  });
});

describe("routing", () => {
  it("ignores chatter that is not addressed to the gate", async () => {
    await router.handle(msg(REP, "lunch?"));
    expect(posts).toHaveLength(0);
  });

  it("delivers agent messages to the agent inbox", async () => {
    await router.handle(msg(FIXER, "done ```loopback-report ...```"));
    await router.handle(msg(VERIFIER, "verdict follows"));
    expect(deps.agents.onAgentMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.agents.onAgentMessage).mock.calls.map((c) => c[1])).toEqual(["fixer", "verifier"]);
  });

  it("dispatches privileged commands for maintainers, once per event", async () => {
    const m = msg(MAINT, `${G} merge LB-001`);
    await router.handle(m);
    await router.handle(m);
    expect(deps.privileged.merge).toHaveBeenCalledTimes(1);
  });

  it("help and whoami work for everyone; whoami echoes the opaque id escaped", async () => {
    await router.handle(msg(OUT, `${G} whoami`));
    expect(posts[0]!.content).toBe("Your participant id: @​switch-user-out:x · role: outsider");
    await router.handle(msg(OUT, `${G} help`));
    expect(posts[1]!.content).toContain("your role: outsider");
  });

  it("status and audit render from persisted state", async () => {
    await router.handle(msg(REP, `${G} report slugify crashes on null charmap`));
    await router.handle(msg(REP, `${G} status LB-001`));
    expect(posts.at(-1)!.content).toBe("[LB-001] LB-001 · FixInProgress · no PR yet · head none · CI test none · verifier none · approvals 0/1");
    await router.handle(msg(REP, `${G} audit LB-001`));
    expect(posts.at(-1)!.content).toContain("| time (UTC) | actor | event | sha | reason |");
    await router.handle(msg(REP, `${G} status LB-404`));
    expect(posts.at(-1)!.content).toMatch(/CASE_NOT_FOUND/);
  });

  it("injected markdown in report text cannot break the audit table", async () => {
    await router.handle(msg(REP, `${G} report | broken | table |\n\`\`\` and @everyone`));
    await router.handle(msg(REP, `${G} audit LB-001`));
    const table = posts.at(-1)!.content.split("\n").filter((l) => l.startsWith("|"));
    for (const line of table) expect(line.split("|").length).toBe(7);
  });
});
