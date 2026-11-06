#!/usr/bin/env node
// Point the gate at a messaging app's rooms: set its Switch addressing policy to the two rules the gate
// requires, check the result with the gate's own policy check, and update the four room and people ids in
// .env. Run it yourself: it asks for the Switch admin login and keeps it in memory only.
//
//   node --env-file=.env scripts/switch-policy.mjs --app Slack --maintainers dev.prashant1901
//       shows the current policy and the new one, changes nothing
//   ... --apply      asks "yes", then applies, checks and updates .env (the old ids are saved first)
//   node --env-file=.env scripts/switch-policy.mjs --restore <saved policy.json> --apply
//       puts a saved policy back (then restore the saved ids in .env by hand)
//
// --maintainers takes the maintainers' usernames on that app, comma-separated. Each must have posted in the
// maintainers' room once, so Switch has met them. Run `npm run build` first: the check uses the built gate.

/* global fetch, AbortSignal, URL */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? "") : null; };
const apply = process.argv.includes("--apply");
const app = arg("--app");
const restore = arg("--restore");
const usernames = (arg("--maintainers") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const die = (msg) => { process.stderr.write(`switch-policy: ${msg}\n`); process.exit(2); };

for (const k of ["SWITCH_BRIDGE_URL", "SWITCH_AGENT_ID", "SWITCH_AGENT_API_KEY", "SWITCH_POLICY_AGENT_IDS"]) if (!env[k]) die(`${k} missing from .env`);
if (restore === null && (app === null || usernames.length === 0)) die("give --app <messaging app> and --maintainers <usernames>, or --restore <file>");

const bridgeUrl = env.SWITCH_BRIDGE_URL.replace(/\/+$/, "");
const gateway = `${new URL(bridgeUrl).origin}/gateway`;
const agentBase = `${bridgeUrl}/agents/${encodeURIComponent(env.SWITCH_AGENT_ID)}`;
const agentHeaders = { Authorization: `Bearer ${env.SWITCH_AGENT_API_KEY}`, "Content-Type": "application/json" };

async function op(name, body) {
  const res = await fetch(`${agentBase}/ops/${name}`, { method: "POST", headers: agentHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) die(`${name}: HTTP ${res.status}`);
  return (await res.json()).result;
}

function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  return new Promise((resolve) => {
    let answered = false;
    rl.on("close", () => { if (!answered) resolve(""); });
    rl.question(question, (answer) => { answered = true; rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer); });
  });
}

// 1. The rooms and people, from Switch.
let maintRoom = null, intakeRoom = null, bridgeId = null;
const participantIds = [];
if (restore === null) {
  for (const r of await op("list_rooms", {})) {
    const d = await op("get_room_detail", { room_id: r.room_id });
    if (!String(d.bridge_display_name ?? "").toLowerCase().includes(app.toLowerCase())) continue;
    if (d.name === "loopback-maintainers") { maintRoom = r.room_id; bridgeId = d.bridge_id; }
    if (d.name === "loopback-intake") intakeRoom = r.room_id;
  }
  if (!maintRoom || !intakeRoom) die(`the gate is not in both loopback-maintainers and loopback-intake on ${app}`);
  const hist = await fetch(`${agentBase}/rooms/${encodeURIComponent(maintRoom)}/history?limit=100`, { headers: agentHeaders, signal: AbortSignal.timeout(10_000) });
  const events = hist.ok ? (await hist.json()).events ?? [] : [];
  for (const u of usernames) {
    const seen = events.find((e) => e.sender_name === u && /^@switch-/.test(e.sender ?? ""));
    if (!seen) die(`${u} has not posted in loopback-maintainers on ${app}; post "hello" there and run this again`);
    participantIds.push(seen.sender);
  }
}

// 2. A gateway session, for the people's ids and the policy itself.
const email = (await ask("Switch admin email [admin@switch.local]: ")) || "admin@switch.local";
const password = await ask("Switch admin password (not shown): ", true);
const login = await fetch(`${gateway}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) die(`login refused (HTTP ${login.status})`);
const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).filter((c) => c.startsWith("switch_auth=")).join("; ");
if (!cookie) die("login gave no session");
const gw = (path, init = {}) => fetch(`${gateway}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) } });

try {
  const before = (await op("get_agent_detail", { agent_id: env.SWITCH_AGENT_ID })).addressing_policy;
  let policy;
  let userIds = [];
  if (restore !== null) {
    policy = JSON.parse(readFileSync(restore, "utf8"));
  } else {
    const users = await gw(`/collaborations/${encodeURIComponent(bridgeId)}/users`);
    if (!users.ok) die(`listing ${app} users failed (HTTP ${users.status})`);
    const list = await users.json();
    for (const u of usernames) {
      const found = list.find((x) => x.external_username === u);
      if (!found) die(`${u} is not a known ${app} user on this Switch server`);
      userIds.push(found.id);
    }
    const agents = env.SWITCH_POLICY_AGENT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    const rule = (rooms, users, agentList) => ({ rooms, room_groups: "*", users, agents: agentList, owner: false, owner_agents: false, platform: false });
    policy = { rules: [rule([maintRoom], userIds, agents), rule([intakeRoom], "*", [])] };
  }
  process.stdout.write(`\nNow:\n${JSON.stringify(before, null, 2)}\n\nNew:\n${JSON.stringify(policy, null, 2)}\n`);
  if (!apply) { process.stdout.write("\nNothing changed. Add --apply to apply it.\n"); process.exit(0); }
  if ((await ask("\nType yes to apply this policy: ")).trim() !== "yes") { process.stdout.write("Not applied.\n"); process.exit(1); }

  const put = await gw(`/agents/${encodeURIComponent(env.SWITCH_AGENT_ID)}/addressing-policy`, { method: "PUT", body: JSON.stringify({ policy }) });
  if (!put.ok) die(`Switch refused the policy (HTTP ${put.status}); nothing else was changed`);
  process.stdout.write("Policy applied.\n");
  if (restore !== null) process.exit(0);

  // 3. The gate's own check, on the live policy.
  const { verifyAddressingPolicy } = await import("../apps/switch-gate/dist/switch/policy-check.js");
  const agents = new Set(env.SWITCH_POLICY_AGENT_IDS.split(",").map((s) => s.trim()).filter(Boolean));
  const check = await verifyAddressingPolicy({ bridgeUrl, agentId: env.SWITCH_AGENT_ID, apiKey: env.SWITCH_AGENT_API_KEY, fetch }, { maintainerRoomId: maintRoom, intakeRoomId: intakeRoom, userIds: new Set(userIds), agentIds: agents });
  process.stdout.write(check.ok ? "The gate's own policy check passes.\n" : `The gate's own policy check fails: ${check.reason}\n`);

  // 4. The four ids in .env. The old ones are saved first; nothing else in the file is touched or printed.
  const envPath = join(root, ".env");
  const text = readFileSync(envPath, "utf8");
  const values = { SWITCH_ROOM_ID: maintRoom, SWITCH_INTAKE_ROOM_ID: intakeRoom, SWITCH_POLICY_USER_IDS: userIds.join(","), LOOPBACK_MAINTAINERS: participantIds.join(",") };
  const saved = Object.keys(values).map((k) => `${k}=${(new RegExp(`^${k}=([^\\s#]*)`, "m").exec(text) ?? [])[1] ?? ""}`).join("\n");
  const savePath = join(root, "..", `loopback-env-ids-before-${app.toLowerCase()}.txt`);
  writeFileSync(savePath, `${saved}\n`);
  let next = text;
  for (const [k, v] of Object.entries(values)) next = next.replace(new RegExp(`^(${k}=)[^\\s#]*`, "m"), `$1${v}`);
  writeFileSync(envPath, next);
  process.stdout.write(`Updated ${Object.keys(values).join(", ")} in .env. The old values are in ${savePath}\n`);
} finally {
  await gw("/auth/logout", { method: "POST" }).catch(() => undefined);
}
