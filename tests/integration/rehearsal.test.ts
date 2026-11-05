import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRehearsal, type RehearsalEvent } from "../../apps/switch-gate/src/demo/rehearsal.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";
import { buildPageData, renderPage } from "../../scripts/build-demo-page.mjs";
import { buildTemplate } from "../../scripts/build-switch-template.mjs";

// `npm run demo` is what a judge or new user runs first. If it stops showing what it claims, this fails.

async function rehearse() {
  const lines: string[] = [];
  const r = await runRehearsal({ dbPath: ":memory:", print: (l) => lines.push(l) });
  return { ...r, text: lines.join("\n") };
}

describe("the rehearsal", () => {
  it("observes every outcome it claims, ending in one merge of the newest commit", async () => {
    const r = await rehearse();
    expect(r.outcomes.filter((o) => !o.held)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.outcomes.length).toBeGreaterThanOrEqual(15);
    const c = getCase(r.db, "LB-001");
    expect(c?.state).toBe("Merged");
    expect(c?.headSha?.startsWith("c7d92e41b6a0")).toBe(true);
    r.db.close();
  });

  it("shows each refusal it exists to demonstrate", async () => {
    const { text, db } = await rehearse();
    for (const code of ["VERIFIER_SIGNATURE_INVALID", "APPROVAL_SHA_MISMATCH", "HEAD_MOVED", "AGENT_OUTPUT_INVALID"]) expect(text).toContain(code);
    db.close();
  });

  it("says what is simulated, so nobody takes it for a live run", async () => {
    const { text, db } = await rehearse();
    expect(text.split("\n")[0]).toMatch(/simulated Switch delivery, GitHub and agents/);
    db.close();
  });

  it("labels its data, so the case can't be taken for a live run in the console", async () => {
    const { db } = await rehearse();
    expect(getCase(db, "LB-001")?.repo).toMatch(/not-a-live-run/);
    db.close();
  });

  it("records the refused attempts in the audit log", async () => {
    const { db } = await rehearse();
    const reasons = (db.prepare("SELECT reason_code AS r FROM audit_events WHERE reason_code IS NOT NULL").all() as { r: string }[]).map((x) => x.r);
    for (const code of ["WRONG_ROOM", "NOT_AUTHORIZED", "APPROVAL_SHA_MISMATCH", "VERIFIER_SIGNATURE_INVALID", "HEAD_MOVED"]) expect(reasons).toContain(code);
    db.close();
  });
});

describe("the public click-through page", () => {
  async function pageData(videoUrl = "") {
    const events: RehearsalEvent[] = [];
    const { db } = await runRehearsal({ dbPath: ":memory:", print: () => undefined, record: (e) => events.push(e) });
    db.close();
    return buildPageData(events, videoUrl);
  }
  const template = () => readFileSync(join(process.cwd(), "scripts", "demo-page.template.html"), "utf8");

  it("carries every scene and outcome from the real run", async () => {
    const data = await pageData();
    expect(data.scenes).toHaveLength(15);
    expect(data.held).toBe(data.total);
    expect(data.total).toBe(16);
    expect(data.scenes.at(-1)?.state?.state).toBe("Merged");
    expect(JSON.stringify(data)).toContain("HEAD_MOVED");
  });

  it("shows the evidence falling away at the late commit, and the old commit replaced", async () => {
    const { scenes } = await pageData();
    const point = scenes.findIndex((s) => s.title.startsWith("THE POINT"));
    expect(point).toBeGreaterThan(0);
    expect(scenes[point - 1]?.state?.approvals).toBe(1);
    expect(scenes[point]?.state?.approvals).toBe(0);
    expect(scenes[point]?.state?.commit).not.toBe(scenes[point - 1]?.state?.commit);
  });

  it("says it is simulated, and contains no signing material or run dates", async () => {
    const page = renderPage(template(), await pageData());
    expect(page).toContain("Simulated rehearsal.");
    expect(page).not.toMatch(/lbcap1\.[A-Za-z0-9_-]{8,}/);
    expect(page).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(page).not.toContain("Time (UTC)");
  });

  it("can't be broken out of by text in the data: it stays inside its script block", () => {
    const page = renderPage("<script>__REHEARSAL_DATA__</script>", { scenes: [], tables: null, held: 0, total: 0, videoUrl: "</script><script>alert(1)</script>" });
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page).not.toContain("</script><script>");
  });

  it("shows people's names in the decision log, not raw participant ids", async () => {
    const { tables } = await pageData();
    const who = tables?.decisions.rows.map((r) => r[1]) ?? [];
    expect(who).toContain("Priya (maintainer)");
    expect(who.some((w) => w?.includes("switch-"))).toBe(false);
  });

  it("the video link stays hidden until there is one", async () => {
    expect((await pageData()).videoUrl).toBe("");
    expect((await pageData("https://example.com/v")).videoUrl).toBe("https://example.com/v");
  });
});

describe("the Switch template", () => {
  const prompt = (name: string) => readFileSync(join(process.cwd(), "prompts", name), "utf8").replace(/\r\n/g, "\n");
  const file = () => readFileSync(join(process.cwd(), "templates", "loopback.template.yaml"), "utf8").replace(/\r\n/g, "\n");

  it("is up to date with the agents' briefs", () => {
    expect(file()).toBe(buildTemplate(prompt("fixer.md"), prompt("verifier.md")));
    const check = spawnSync(process.execPath, [join(process.cwd(), "scripts", "build-switch-template.mjs"), "--check"], { encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
  });

  it("carries each brief exactly, line by line", () => {
    const text = file();
    for (const name of ["fixer.md", "verifier.md"]) {
      for (const line of prompt(name).split("\n").filter((l) => l !== "")) expect(text).toContain(`      ${line}\n`);
    }
  });

  it("keeps the maintainers' room private and lets only the owner's agents address the agents", () => {
    const text = file();
    expect(text).toMatch(/name: loopback-maintainers[\s\S]*?channel_type: channel_private/);
    expect(text).toMatch(/name: loopback-intake[\s\S]*?channel_type: channel_public/);
    expect(text.match(/addressing: owner-agents/g)).toHaveLength(2);
    expect(text).not.toContain("addressing: anyone");
    expect(text).not.toContain("auto_approve");
  });

  it("puts no agent but the gate in the public room", () => {
    expect(file()).toMatch(/name: loopback-intake[\s\S]*?agents: \[loopback-gate\]/);
  });
});
