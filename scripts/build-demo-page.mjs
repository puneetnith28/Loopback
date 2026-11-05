#!/usr/bin/env node
// Builds docs/demo/loopback-demo.html: a page where someone who never installs anything can do what a local user
// does and see what they would see. Every chat message, result and console response on it comes from an actual run
// of the rehearsal, read through the real console API, and the console on it is the real one. It fails if the
// rehearsal fails. Run `npm run build` first.
//
//   npm run demo:page
//   DEMO_VIDEO_URL=https://...   adds the video link
//   --out <file>                 writes somewhere else
//
// Real screenshots of Switch Console placed in docs/demo/shots/ replace the page's illustrations:
// switch-home.png, switch-templates.png, switch-documents.png

/* global fetch */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_EXCERPTS, SCENE_GUIDE, SETUP_STEPS } from "./demo-page/content.mjs";
import { isMainModule } from "./sh.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = { priya: "Priya (maintainer)", sam: "Sam (contributor)", mallory: "Mallory (not a maintainer)", fixer: "loopback-fixer", verifier: "loopback-verifier" };
const CONSOLE_TOKEN = "loopback-console-mock-token-not-a-secret";
const CLOCK_START = 1_000_000_000_000;
const CASE = "/api/v1/cases/LB-001";
/** Everything the console reads. Recorded with the largest page, because the frame filters it as the API would. */
const API_PATHS = [
  "/api/v1/health", "/api/v1/meta", "/api/v1/summary", "/api/v1/gate", "/api/v1/cases?limit=200", "/api/v1/audit?limit=200", "/api/v1/activity?limit=200",
  CASE, `${CASE}/commits`, `${CASE}/verification-runs`, `${CASE}/checks`, `${CASE}/approvals`, `${CASE}/merge-operations`, `${CASE}/audit?limit=200`,
];
const SHOTS = ["home", "templates", "documents"];
/**
 * The rehearsal's own settings, from rehearsal.ts. The read API has no settings endpoint yet, so without this the
 * console falls back to its defaults, which say merging is off and verification is isolated. Neither is true here.
 */
const configBody = (schemaVersion) => JSON.stringify({
  success: true,
  data: {
    repo: "simulated/rehearsal-not-a-live-run", baseBranch: "main", requiredChecks: ["test"], verificationMode: "advisory",
    safety: { mergeEnabled: true, privilegedEnabled: true, verifierIsolationProven: false },
    quorum: 1, gateMention: "@loopback-gate", schemaVersion, pollIntervalMs: 30_000, verifyTimeoutMs: 1_800_000, fixTimeoutMs: 2_700_000,
  },
});

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

/**
 * Turn the run into what a person does on the page: send one message, or watch one thing happen, then read what
 * came back. Pure, so a test can check it.
 */
export function buildSteps(events) {
  const steps = [];
  let scene = -1;
  let current = null;
  let snapshot = 0;
  for (const e of events) {
    if (e.kind === "scene") {
      scene += 1;
      current = null;
    } else if (e.kind === "checkpoint") {
      snapshot = e.snapshot;
      if (current !== null) current.snapshot = snapshot;
    } else if (e.kind === "chat" && e.role !== "gate") {
      current = { scene, kind: e.role, who: e.who, room: e.room, text: e.text, senderId: e.senderId ?? "", replies: [], checks: [], state: null, snapshot };
      steps.push(current);
    } else if (e.kind === "github") {
      current = { scene, kind: "github", who: "GitHub", room: null, text: e.text, senderId: "", replies: [], checks: [], state: null, snapshot };
      steps.push(current);
    } else if (e.kind === "tables") {
      current = { scene, kind: "documents", who: "Switch room documents", room: null, text: "The gate's case board and decision log", senderId: "", replies: [], checks: [], state: null, snapshot };
      steps.push(current);
    } else if (current !== null) {
      if (e.kind === "chat") current.replies.push({ room: e.room, text: e.text, refused: e.refused });
      if (e.kind === "check") current.checks.push({ claim: e.claim, held: e.held });
      if (e.kind === "state") current.state = { state: e.state, commit: e.commit, ci: e.ci, verifier: e.verifier, approvals: e.approvals };
    }
  }
  return steps;
}

/** Group the rehearsal's events into the page's scenes. Pure, so a test can check it. */
export function buildPageData(events, videoUrl = "") {
  const scenes = [];
  let tables = null;
  for (const e of events) {
    if (e.kind === "scene") {
      scenes.push({ title: e.title.replace(/^\d+\.\s*/, ""), items: [], checks: [], state: null, lines: [] });
      continue;
    }
    const current = scenes.at(-1);
    if (e.kind === "tables") tables = { board: tableRows(e.board), decisions: tableRows(e.decisions, ["Time (UTC)"]) };
    if (current === undefined) continue;
    if (e.kind === "print") current.lines.push(e.line);
    if (e.kind === "chat" || e.kind === "github") current.items.push(e);
    if (e.kind === "check") current.checks.push({ claim: e.claim, held: e.held });
    if (e.kind === "state") current.state = { state: e.state, commit: e.commit, ci: e.ci, verifier: e.verifier, approvals: e.approvals };
  }
  const checks = scenes.flatMap((s) => s.checks);
  return { scenes, steps: buildSteps(events), tables, held: checks.filter((c) => c.held).length, total: checks.length, videoUrl };
}

/** Put the data into the page, safely inside script tags. */
export function renderPage(template, data, consoleDocument = "") {
  const safe = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  return template
    .replace("__REHEARSAL_DATA__", () => safe(data))
    .replace("__CONSOLE_DOCUMENT__", () => safe(consoleDocument));
}

/** Cut a piece of real source code for the page, failing if the source no longer has it. */
export function cutExcerpt(source, excerpt) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => excerpt.from.test(l));
  const end = lines.findIndex((l, i) => i >= start && excerpt.to.test(l));
  if (start < 0 || end < 0) throw new Error(`the excerpt "${excerpt.title}" is no longer in ${excerpt.file}`);
  const cut = lines.slice(start, end + 1 + (excerpt.after ?? 0));
  const indent = Math.min(...cut.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  return { title: excerpt.title, note: excerpt.note, file: excerpt.file, line: start + 1, code: cut.map((l) => l.slice(indent)).join("\n") };
}

/** The labels Switch Console asks for when using the template, read from the template itself. */
export function templateFields(yaml) {
  const params = /^params:\n([\s\S]*?)^agents:/m.exec(yaml.replace(/\r\n/g, "\n"))?.[1] ?? "";
  return [...params.matchAll(/^ {4}label: (.+)$/gm)].map((m) => m[1]);
}

/** The recorded part of a page must hold no run date and no signing material. Throws if it does. */
export function assertClean(label, text) {
  if (/lbcap1\.[A-Za-z0-9_-]{8,}/.test(text)) throw new Error(`${label} contains a signing capability`);
  if (/\b(?:19|20)\d\d-\d\d-\d\d\b/.test(text)) throw new Error(`${label} contains a date`);
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** Times become seconds before the moment of recording, so the page carries no date from the run. */
export function withRelativeTimes(text, recordedAt) {
  return text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, (iso) => `@T:${Math.max(0, Math.round((recordedAt - Date.parse(iso)) / 1000))}@`);
}

/** Run the rehearsal, reading the real console API whenever the database has settled. */
async function record() {
  const { runRehearsal } = await import("../apps/switch-gate/dist/demo/rehearsal.js");
  const { startConsoleServer } = await import("../apps/console-api/dist/server.js");
  const { loadConsoleConfig } = await import("../apps/console-api/dist/config.js");

  const dir = mkdtempSync(join(tmpdir(), "loopback-page-"));
  const dbPath = join(dir, "rehearsal.db");
  let clock = CLOCK_START;
  const now = () => new Date((clock += 1000));
  // The rehearsal has no running gate process. This answers the console's health question as a running gate would.
  const gate = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/readyz" ? { failing: [] } : { status: "ok" }));
  });
  const gatePort = await freePort();
  await new Promise((resolve) => gate.listen(gatePort, "127.0.0.1", resolve));
  const port = await freePort();
  const cfg = loadConsoleConfig({
    CONSOLE_DB_PATH: dbPath, CONSOLE_API_TOKEN: CONSOLE_TOKEN, CONSOLE_API_PORT: String(port), CONSOLE_ALLOWED_ORIGIN: "http://localhost:5173", CONSOLE_GATE_HTTP_PORT: String(gatePort),
  });
  const server = await startConsoleServer(cfg, { now: () => new Date(clock) });

  const bodies = [];
  const bodyIndex = new Map();
  const steps = [];
  const stepIndex = new Map();
  const internBody = (body) => {
    let b = bodyIndex.get(body);
    if (b === undefined) {
      b = bodies.push(body) - 1;
      bodyIndex.set(body, b);
    }
    return b;
  };
  const capture = async () => {
    const answers = {};
    for (const path of API_PATHS) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${CONSOLE_TOKEN}` } });
      const raw = await res.text();
      if (res.status !== 200 && res.status !== 404) throw new Error(`the console API answered ${res.status} for ${path}: ${raw}`);
      const body = withRelativeTimes(res.status === 404 ? raw.replace(/"requestId":"[^"]*"/, '"requestId":"00000000-0000-4000-8000-000000000000"') : raw, clock);
      answers[path.split("?")[0]] = { b: internBody(body), s: res.status };
    }
    const meta = JSON.parse(bodies[answers["/api/v1/meta"].b]);
    answers["/api/v1/config/summary"] = { b: internBody(configBody(meta.schemaVersion)), s: 200 };
    const key = JSON.stringify(answers);
    let at = stepIndex.get(key);
    if (at === undefined) {
      at = steps.push(answers) - 1;
      stepIndex.set(key, at);
    }
    return at;
  };

  const events = [];
  try {
    const { passed, db } = await runRehearsal({
      dbPath, now,
      // The printed decision log has a time column. Its date comes from this run's stepping clock.
      print: (line) => events.push({ kind: "print", line: line.replace(/\b\d{4}-\d\d-\d\d[T ]?/g, "") }),
      record: (e) => events.push(e),
      checkpoint: async () => {
        clock += 60_000;
        events.push({ kind: "checkpoint", snapshot: await capture() });
      },
    });
    db.close();
    return { passed, events, recording: { bodies, steps } };
  } finally {
    server.close();
    server.closeAllConnections();
    gate.close();
    gate.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
}

function realScreens() {
  const shots = {};
  for (const name of SHOTS) {
    const file = join(root, "docs", "demo", "shots", `switch-${name}.png`);
    if (existsSync(file)) shots[name] = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  }
  return shots;
}

async function main(argv) {
  const { passed, events, recording } = await record();
  if (!passed) {
    process.stderr.write("the rehearsal did not pass, so no page was written\n");
    return 1;
  }
  const data = buildPageData(events, process.env.DEMO_VIDEO_URL ?? "");
  if (data.scenes.length !== SCENE_GUIDE.length) {
    process.stderr.write(`the rehearsal has ${data.scenes.length} scenes and the guide has ${SCENE_GUIDE.length}, so no page was written\n`);
    return 1;
  }
  const page = {
    ...data,
    guide: SCENE_GUIDE,
    setup: SETUP_STEPS,
    code: CODE_EXCERPTS.map((e) => cutExcerpt(readFileSync(join(root, e.file), "utf8"), e)),
    fields: templateFields(readFileSync(join(root, "templates", "loopback.template.yaml"), "utf8")),
    shots: realScreens(),
    transcriptHead: events.filter((e) => e.kind === "print").slice(0, 1).map((e) => e.line),
  };
  assertClean("the page's data", JSON.stringify({ ...page, shots: undefined }));
  assertClean("the console recording", JSON.stringify(recording));
  const { buildConsoleDocument } = await import("./demo-page/console-build.mjs");
  const consoleDocument = await buildConsoleDocument(recording);
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : join(root, "docs", "demo", "loopback-demo.html");
  mkdirSync(dirname(out), { recursive: true });
  const template = readFileSync(join(root, "scripts", "demo-page.template.html"), "utf8");
  writeFileSync(out, renderPage(template, page, consoleDocument));
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
