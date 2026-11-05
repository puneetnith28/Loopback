#!/usr/bin/env node
// Builds docs/demo/loopback-demo.html, a click-through of `npm run demo` that needs no install. Every
// message and result on it comes from an actual run of the rehearsal, not from text typed by hand.
// It fails if the rehearsal fails. Run `npm run build` first.
//
//   npm run demo:page
//   DEMO_VIDEO_URL=https://...   adds the video link
//   --out <file>                 writes somewhere else

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./sh.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = { priya: "Priya (maintainer)", sam: "Sam (contributor)", mallory: "Mallory (not a maintainer)", fixer: "loopback-fixer", verifier: "loopback-verifier" };

/** Readable names for the rehearsal's participant ids in a table cell. */
const friendly = (cell) => cell.replaceAll(String.fromCharCode(0x200b), "").replace(/^@?switch-(?:mattermost|agent)-(\w+):demo$/, (m, who) => NAMES[who] ?? m);

/** A Markdown table's rows, leaving out the named columns. Cells may hold escaped pipes. */
function tableRows(markdown, drop = []) {
  const lines = markdown.split("\n").filter((l) => l.startsWith("|"));
  const cells = (l) => l.replace(/^\| ?| ?\|$/g, "").split(/ ?(?<!\\)\| ?/);
  const header = cells(lines[0] ?? "");
  const keep = header.map((name, i) => (drop.includes(name) ? -1 : i)).filter((i) => i >= 0);
  const pick = (row) => keep.map((i) => friendly(row[i] ?? ""));
  return { header: pick(header), rows: lines.slice(2).map((l) => pick(cells(l))) };
}

/** Group the rehearsal's events into the page's scenes. Pure, so a test can check it. */
export function buildPageData(events, videoUrl = "") {
  const scenes = [];
  let tables = null;
  for (const e of events) {
    if (e.kind === "scene") {
      scenes.push({ title: e.title.replace(/^\d+\.\s*/, ""), items: [], checks: [], state: null });
      continue;
    }
    const current = scenes.at(-1);
    if (e.kind === "tables") tables = { board: tableRows(e.board), decisions: tableRows(e.decisions, ["Time (UTC)"]) };
    if (current === undefined) continue;
    if (e.kind === "chat" || e.kind === "github") current.items.push(e);
    if (e.kind === "check") current.checks.push({ claim: e.claim, held: e.held });
    if (e.kind === "state") current.state = { state: e.state, commit: e.commit, ci: e.ci, verifier: e.verifier, approvals: e.approvals };
  }
  const checks = scenes.flatMap((s) => s.checks);
  return { scenes, tables, held: checks.filter((c) => c.held).length, total: checks.length, videoUrl };
}

/** Put the data into the page, safely inside a script tag. */
export function renderPage(template, data) {
  return template.replace("__REHEARSAL_DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
}

async function main(argv) {
  const { runRehearsal } = await import("../apps/switch-gate/dist/demo/rehearsal.js");
  const events = [];
  const { passed, db } = await runRehearsal({ dbPath: ":memory:", print: () => undefined, record: (e) => events.push(e) });
  db.close();
  if (!passed) {
    process.stderr.write("the rehearsal did not pass, so no page was written\n");
    return 1;
  }
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : join(root, "docs", "demo", "loopback-demo.html");
  mkdirSync(dirname(out), { recursive: true });
  const template = readFileSync(join(root, "scripts", "demo-page.template.html"), "utf8");
  writeFileSync(out, renderPage(template, buildPageData(events, process.env.DEMO_VIDEO_URL ?? "")));
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
