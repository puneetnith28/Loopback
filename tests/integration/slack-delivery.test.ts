import { describe, expect, it } from "vitest";
import { decodeChatEscapes, parseCommand } from "../../apps/switch-gate/src/commands/parse.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";
import { A, G, IROOM, createHarness } from "../helpers/harness.js";

// Messages exactly as Switch's Slack bridge hands them to an agent (switch-core 0.31.0,
// bridges/collaboration/slack/adapter.py). The bridge turns Slack's mention codes back into names:
// `<!subteam^S…>` (an agent picked from the @ menu) into `@loopback-gate`, and `<@U…>` (a person) into
// `@username`. It does not decode Slack's `&lt;`, `&gt;` and `&amp;`. People's ids are built as
// `@switch-<bridge type>-<bridge id>-<username>:<server>` (collaboration_core._create_human_actor_locked).
// This runs the real router, workflow and merge executor; it is not a live Slack run.

const SLACK_MAINT = "@switch-slack-b7c2-puneet:switch.local";
const SLACK_REPORTER = "@switch-slack-b7c2-prashant:switch.local";
const SLACK_STRANGER = "@switch-slack-b7c2-mallory:switch.local";

const slackHarness = () => createHarness({ maintainers: [SLACK_MAINT], reporters: [SLACK_REPORTER] });

describe("decoding Slack's escapes", () => {
  it("decodes exactly &lt; &gt; &amp;, once", () => {
    expect(decodeChatEscapes("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(decodeChatEscapes("&amp;lt;")).toBe("&lt;");
    expect(decodeChatEscapes("&quot;quoted&quot; &#39;x&#39;")).toBe("&quot;quoted&quot; &#39;x&#39;");
    expect(decodeChatEscapes("plain text, as Mattermost sends it")).toBe("plain text, as Mattermost sends it");
  });
});

describe("a command pasted as code", () => {
  it("runs when the whole message is one code span", () => {
    expect(parseCommand("`@loopback-gate status LB-001`", G)).toMatchObject({ ok: true, command: { kind: "status", caseId: "LB-001" } });
    expect(parseCommand(`\`\`\`@loopback-gate approve LB-001 ${A}\`\`\``, G)).toMatchObject({ ok: true, command: { kind: "approve", sha: A } });
  });

  it("does not run when the code span sits inside prose", () => {
    expect(parseCommand("run `@loopback-gate merge LB-001` later", G)).toMatchObject({ ok: false });
    expect(parseCommand("`@loopback-gate` merge `LB-001`", G)).toMatchObject({ ok: false });
  });
});

describe("the whole flow, from Slack", () => {
  it("files the report with its text decoded, and merges the approved commit", async () => {
    const h = slackHarness();
    await h.say(SLACK_REPORTER, `${G} report formatToken fails when a &lt; b &amp;&amp; c`, { roomId: IROOM });
    expect(h.state()).toBe("Reported");
    expect(getCase(h.db, "LB-001")?.reportText).toBe("formatToken fails when a < b && c");

    await h.say(SLACK_MAINT, `${G} accept LB-001`);
    expect(h.state()).toBe("FixInProgress");
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    await h.verifierReply("pass");
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");

    // Pasted from the gate's own message, as code.
    await h.say(SLACK_MAINT, `\`${G} approve LB-001 ${A}\``);
    expect(h.state()).toBe("ReadyToMerge");
    await h.say(SLACK_MAINT, `${G} merge LB-001`, { threadId: "1730900000.000100" });
    expect(h.state()).toBe("Merged");
    expect(h.merger).toHaveBeenCalledWith(42, A);
  });

  it("gives a Slack user who is not a maintainer no authority", async () => {
    const h = slackHarness();
    await h.say(SLACK_REPORTER, `${G} report slugify.extend({'%': null}) throws a TypeError`, { roomId: IROOM });
    await h.say(SLACK_STRANGER, `${G} accept LB-001`);
    expect(h.state()).toBe("Reported");
  });

  it("does not act on a mention the bridge could not turn back into the gate's name", async () => {
    const h = slackHarness();
    await h.say(SLACK_REPORTER, `${G} report slugify.extend({'%': null}) throws a TypeError`, { roomId: IROOM });
    // An agent group the bridge had not adopted yet reaches the gate as Slack's raw code.
    await h.say(SLACK_MAINT, "<!subteam^S0123ABC> accept LB-001");
    expect(h.state()).toBe("Reported");
  });

  it("leaves an agent's report exactly as sent, so its signature still matches", async () => {
    const h = slackHarness();
    await h.say(SLACK_REPORTER, `${G} report slugify.extend({'%': null}) throws a TypeError`, { roomId: IROOM });
    await h.say(SLACK_MAINT, `${G} accept LB-001`);
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    // Agents post through Switch's agent API, not Slack, so this text is not escaped: it must not be decoded.
    await h.verifierReply("pass", { summary: "Checked a &amp; b, and &lt;tags&gt;." });
    await h.poller.tick();
    expect(h.state()).toBe("AwaitingApproval");
  });
});
