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
const SELF = "@switch-agent-gate:x";
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
    eventId: `m${seq}`, roomId: "room", sequence: seq, messageId: `m${seq}`, sender, senderKind: null,
    onBehalfOf: null, senderRole: null, addressed: true, body, threadId: null, timestamp: seq, ...over,
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
    db, chat, repo: "o/r", quorum: 1, requiredChecks: ["test"],
    admission: { selfId: SELF, fixerId: FIXER, verifierId: VERIFIER, gateMention: G },
    identity: { maintainers: new Set([MAINT]), reporters: new Set([REP]), privilegedEnabled: true },
    privileged,
    handoff: { check: async () => baseProblem, message: (c) => `@loopback-fixer fix ${c.id}` },
    agents: { onAgentMessage: vi.fn(async () => undefined) },
    now: () => new Date("2026-11-04T10:00:00Z"),
  };
  router = new Router(deps);
});
afterEach(() => db.close());

const refusals = () =>
  (db.prepare("SELECT actor_id AS actor, reason_code AS reason FROM audit_events WHERE event_type = 'command.refused' ORDER BY id").all() as { actor: string; reason: string }[]);

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

  it("an agent's message is never a command, even when it names a command", async () => {
    await router.handle(msg(FIXER, `${G} merge LB-001`));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(deps.agents.onAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ sender: FIXER }), "fixer");
    expect(posts).toHaveLength(0);
  });

  it("unknown commands get usage and are audited", async () => {
    await router.handle(msg(MAINT, `${G} deploy now`));
    expect(posts[0]!.content).toMatch(/^REFUSED \(UNKNOWN_COMMAND\)/);
    expect((db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'command.refused'").get() as { n: number }).n).toBe(1);
  });

  it("an unaddressed mention is audited as NOT_ADDRESSED, never parsed and never answered", async () => {
    await router.handle(msg(MAINT, `${G} merge LB-001`, { addressed: false }));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(refusals()).toEqual([{ actor: MAINT, reason: "NOT_ADDRESSED" }]);
  });
});

describe("admission before any handler", () => {
  it.each([
    ["a delegated message", { onBehalfOf: "Someone" }, "DELEGATED_SENDER"],
    ["a platform message", { senderKind: "platform" }, "PLATFORM_SENDER"],
    ["an unrecognised sender kind", { senderKind: "agent" }, "UNRECOGNISED_SENDER_KIND"],
  ] as const)("%s from a maintainer is audited and dropped, never dispatched or answered", async (_n, over, reason) => {
    await router.handle(msg(MAINT, `${G} merge LB-001`, over));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(refusals()).toEqual([{ actor: MAINT, reason }]);
  });

  it("the gate's own messages are dropped silently, even when they name a command", async () => {
    await router.handle(msg(SELF, `${G} merge LB-001`));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(refusals()).toEqual([]);
  });

  it("an unaddressed fixer or verifier report never reaches the agent inbox", async () => {
    await router.handle(msg(FIXER, "```loopback-report\n{}\n```", { addressed: false }));
    await router.handle(msg(VERIFIER, "verdict", { addressed: false }));
    expect(deps.agents.onAgentMessage).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(refusals().map((r) => r.reason)).toEqual(["NOT_ADDRESSED", "NOT_ADDRESSED"]);
  });

  it("a refused message is processed once: redelivery does not audit it again", async () => {
    const m = msg(MAINT, `${G} merge LB-001`, { addressed: false });
    await router.handle(m);
    await router.handle(m);
    expect(refusals()).toHaveLength(1);
  });

  it("audits at most one admission refusal per sender per minute (no audit flooding)", async () => {
    for (let i = 0; i < 5; i++) await router.handle(msg(OUT, `${G} merge LB-001`, { addressed: false }));
    await router.handle(msg(MAINT, `${G} merge LB-001`, { addressed: false }));
    expect(refusals()).toEqual([{ actor: OUT, reason: "NOT_ADDRESSED" }, { actor: MAINT, reason: "NOT_ADDRESSED" }]);
    expect(posts).toHaveLength(0);
    // Throttled messages are still marked processed, so redelivery never reaches a handler.
    const later = new Router({ ...deps, now: () => new Date("2026-11-04T10:05:00Z") });
    await later.handle(msg(OUT, `${G} merge LB-001`, { addressed: false }));
    expect(refusals()).toHaveLength(3);
  });

  it("refuses to be constructed with an unusable admission policy", () => {
    expect(() => new Router({ ...deps, admission: { ...deps.admission, selfId: FIXER } })).toThrow(/admission policy/);
  });

  it("a spoofed sender_role grants nothing", async () => {
    await router.handle(msg(OUT, `${G} merge LB-001`, { senderRole: "admin" }));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(posts[0]!.content).toMatch(/NOT_AUTHORIZED/);
  });

  it("privileged commands are refused while LOOPBACK_PRIVILEGED_ENABLED is off, even for a maintainer", async () => {
    router = new Router({ ...deps, identity: { ...deps.identity, privilegedEnabled: false } });
    await router.handle(msg(MAINT, `${G} merge LB-001`));
    await router.handle(msg(MAINT, `${G} approve LB-001 ${"3f9c2ab4e1d0b4c9a8f7e6d5c4b3a2918f7e6d5c"}`));
    expect(deps.privileged.merge).not.toHaveBeenCalled();
    expect(deps.privileged.approve).not.toHaveBeenCalled();
    expect(posts.map((p) => p.content).every((c) => /PRIVILEGED_DISABLED/.test(c))).toBe(true);
    await router.handle(msg(MAINT, `${G} help`));
    expect(posts.at(-1)!.content).toMatch(/your role: maintainer/);
  });
});

describe("admission audit throttle (security evidence is never suppressed)", () => {
  let clock: number;
  const at = (iso: string) => { clock = Date.parse(iso); };
  const throttled = () => new Router({ ...deps, now: () => new Date(clock) });
  const summaries = () =>
    (db.prepare("SELECT actor_id AS actor, reason_code AS reason, payload_json AS p FROM audit_events WHERE event_type = 'command.refused' AND payload_json LIKE '%suppressed%' ORDER BY id").all() as { actor: string; reason: string; p: string }[])
      .map((r) => ({ actor: r.actor, reason: r.reason, suppressed: (JSON.parse(r.p) as { suppressed: number }).suppressed }));
  beforeEach(() => at("2026-11-04T10:00:00Z"));

  it("NOT_ADDRESSED cannot suppress a following DELEGATED_SENDER from the same sender", async () => {
    const r = throttled();
    await r.handle(msg(MAINT, `${G} merge LB-001`, { addressed: false }));
    await r.handle(msg(MAINT, `${G} merge LB-001`, { onBehalfOf: "Someone" }));
    expect(refusals()).toEqual([{ actor: MAINT, reason: "NOT_ADDRESSED" }, { actor: MAINT, reason: "DELEGATED_SENDER" }]);
  });

  it("attribution refusals are never throttled: each one is audited, and one cannot suppress another", async () => {
    const r = throttled();
    for (let i = 0; i < 3; i++) await r.handle(msg(MAINT, `${G} merge LB-001`, { onBehalfOf: "Someone" }));
    for (let i = 0; i < 2; i++) await r.handle(msg(MAINT, `${G} merge LB-001`, { senderKind: "platform" }));
    for (let i = 0; i < 2; i++) await r.handle(msg(MAINT, `${G} merge LB-001`, { senderKind: "agent" }));
    expect(refusals().map((x) => x.reason)).toEqual([
      "DELEGATED_SENDER", "DELEGATED_SENDER", "DELEGATED_SENDER", "PLATFORM_SENDER", "PLATFORM_SENDER",
      "UNRECOGNISED_SENDER_KIND", "UNRECOGNISED_SENDER_KIND",
    ]);
  });

  it("repeated rejected fixer and verifier reports are each audited", async () => {
    const r = throttled();
    for (let i = 0; i < 3; i++) await r.handle(msg(FIXER, "```loopback-report\n{}\n```", { addressed: false }));
    await r.handle(msg(VERIFIER, "verdict", { addressed: false }));
    expect(refusals()).toEqual([
      { actor: FIXER, reason: "NOT_ADDRESSED" }, { actor: FIXER, reason: "NOT_ADDRESSED" }, { actor: FIXER, reason: "NOT_ADDRESSED" },
      { actor: VERIFIER, reason: "NOT_ADDRESSED" },
    ]);
  });

  it("windows are per (code, sender): one sender's throttled code does not affect another code or sender", async () => {
    const r = throttled();
    await r.handle(msg(OUT, `${G} x`, { addressed: false }));
    await r.handle(msg(OUT, `${G} x`, { addressed: false }));          // throttled
    await r.handle(msg(OUT, `${G} x`, { senderKind: "agent" }));       // different code: audited
    await r.handle(msg(REP, `${G} x`, { addressed: false }));          // different sender: audited
    await r.handle(msg(OUT, `${G} x`, { addressed: false }));          // still OUT's NOT_ADDRESSED window
    expect(refusals()).toEqual([
      { actor: OUT, reason: "NOT_ADDRESSED" }, { actor: OUT, reason: "UNRECOGNISED_SENDER_KIND" }, { actor: REP, reason: "NOT_ADDRESSED" },
    ]);
  });

  it("ordinary repeats are throttled, counted, and summarised when the window closes; then audited again", async () => {
    const r = throttled();
    for (let i = 0; i < 4; i++) await r.handle(msg(OUT, `${G} x`, { addressed: false }));
    expect(refusals()).toHaveLength(1);
    expect(posts).toHaveLength(0);
    at("2026-11-04T10:01:01Z");
    await r.handle(msg(REP, "lunch?", { addressed: false }));          // any message closes expired windows
    expect(summaries()).toEqual([{ actor: OUT, reason: "NOT_ADDRESSED", suppressed: 3 }]);
    await r.handle(msg(OUT, `${G} x`, { addressed: false }));
    expect(refusals().filter((x) => x.actor === OUT)).toHaveLength(3);    // first row, summary, new row
  });

  it("a window that suppressed nothing closes without a summary row", async () => {
    const r = throttled();
    await r.handle(msg(OUT, `${G} x`, { addressed: false }));
    at("2026-11-04T10:02:00Z");
    await r.handle(msg(REP, "lunch?", { addressed: false }));
    expect(summaries()).toEqual([]);
  });

  it("stays bounded and fails toward auditing when the tracking table is full", async () => {
    const r = throttled();
    for (let i = 0; i < 1000; i++) await r.handle(msg(`@switch-user-${i}:x`, `${G} x`, { addressed: false }));
    expect(refusals()).toHaveLength(1000);
    const extra = "@switch-user-extra:x";
    await r.handle(msg(extra, `${G} x`, { addressed: false }));
    await r.handle(msg(extra, `${G} x`, { addressed: false }));
    expect(refusals().filter((x) => x.actor === extra)).toHaveLength(2); // untracked, so never suppressed
  });
});

describe("routing", () => {
  it("ignores chatter that is not addressed to the gate (no reply, no audit)", async () => {
    await router.handle(msg(REP, "lunch?", { addressed: false }));
    expect(posts).toHaveLength(0);
    expect(refusals()).toEqual([]);
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
