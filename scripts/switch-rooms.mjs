#!/usr/bin/env node
// Read-only: what Switch says about the gate's rooms, so .env can be filled in from evidence, not guesses.
//   npm run switch-rooms                 every room the gate is in
//   node --env-file=.env scripts/switch-rooms.mjs --app Slack
//                                        only rooms on that messaging app, with suggested .env lines
//                                        (run it this way: Windows PowerShell drops the `--` that
//                                        `npm run switch-rooms -- --app Slack` needs)
//
// Uses the gate's own key from .env, the same calls the gate makes at startup (list_rooms, get_room_detail,
// get_agent_detail) plus each room's recent history to show who has posted. It changes nothing and never
// prints the key. People appear only after they have posted in the room, so post "hello" there first.

/* global fetch, AbortSignal */
const env = process.env;
const missing = ["SWITCH_BRIDGE_URL", "SWITCH_AGENT_ID", "SWITCH_AGENT_API_KEY"].filter((k) => !env[k]);
if (missing.length > 0) {
  process.stderr.write(`switch-rooms: ${missing.join(", ")} missing from .env\n`);
  process.exit(2);
}
const app = (() => { const i = process.argv.indexOf("--app"); return i >= 0 ? (process.argv[i + 1] ?? "") : null; })();
const base = `${env.SWITCH_BRIDGE_URL.replace(/\/+$/, "")}/agents/${encodeURIComponent(env.SWITCH_AGENT_ID)}`;
const headers = { Authorization: `Bearer ${env.SWITCH_AGENT_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" };

async function op(name, body) {
  const res = await fetch(`${base}/ops/${name}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return (await res.json()).result;
}
async function history(roomId) {
  const res = await fetch(`${base}/rooms/${encodeURIComponent(roomId)}/history?limit=100`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  return (await res.json()).events ?? [];
}

const agentIds = new Set([env.SWITCH_SELF_ID, env.LOOPBACK_FIXER_ID, env.LOOPBACK_VERIFIER_ID].filter(Boolean));
const rooms = await op("list_rooms", {});
const shown = [];
for (const r of rooms) {
  const d = await op("get_room_detail", { room_id: r.room_id });
  if (app !== null && !String(d.bridge_display_name ?? "").toLowerCase().includes(app.toLowerCase())) continue;
  const people = new Map();
  // People only: not the gate's agents, and not Switch's own bridge bot and admin, which post system messages.
  for (const e of await history(r.room_id)) if (e.sender && !agentIds.has(e.sender) && !/^@switch-(agent|bridge)-|^@switch-admin:/.test(e.sender)) people.set(e.sender, e.sender_name ?? e.sender);
  shown.push({ name: d.name, id: r.room_id, app: d.bridge_display_name ?? "(none)", type: d.channel_type, agents: d.agent_names ?? [], people });
}

for (const s of shown) {
  process.stdout.write(`\n${s.name}  (${s.app}, ${s.type})\n  room id: ${s.id}\n  agents:  ${s.agents.join(", ") || "none"}\n`);
  if (s.people.size === 0) process.stdout.write("  people:  nobody has posted yet\n");
  for (const [id, name] of s.people) process.stdout.write(`  person:  ${name}  ${id}\n`);
}

const detail = await op("get_agent_detail", { agent_id: env.SWITCH_AGENT_ID });
process.stdout.write(`\nThe gate's addressing policy now (Switch row ids):\n${JSON.stringify(detail.addressing_policy, null, 2)}\n`);

if (app !== null) {
  const maint = shown.find((s) => s.name === "loopback-maintainers");
  const intake = shown.find((s) => s.name === "loopback-intake");
  process.stdout.write(`\nSuggested .env values for ${app} (check them; nothing was changed):\n`);
  process.stdout.write(`  SWITCH_ROOM_ID=${maint?.id ?? "<no loopback-maintainers room on this app>"}\n`);
  process.stdout.write(`  SWITCH_INTAKE_ROOM_ID=${intake?.id ?? "<no loopback-intake room on this app>"}\n`);
  process.stdout.write(`  LOOPBACK_MAINTAINERS=${maint ? [...maint.people.keys()].join(",") || "<post in the room first>" : "<no room>"}\n`);
  process.stdout.write("  SWITCH_POLICY_USER_IDS needs each maintainer's ExternalUser id, which only a Switch admin can list.\n");
}
