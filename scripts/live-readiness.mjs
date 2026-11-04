#!/usr/bin/env node
// Live end-to-end readiness (read-only): which prerequisites for the live GitHub + Switch run
// exist, which are missing, and who must act. It reads variable NAMES from .env (never values,
// except the three safety flags, which must stay off), file modes, the rootless runtime's
// container list and, with `gh`, whether the demo-reset tag ruleset exists. It changes nothing
// and never turns a flag on.
//
//   node scripts/live-readiness.mjs        exit 0 when everything is ready, 1 otherwise

import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createPublicKey } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED = Object.freeze({
  "GitHub (gate App)": ["GH_REPO", "GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH", "REQUIRED_CHECKS", "CHECK_SOURCES", "REQUIRED_CHECK_INTEGRATIONS", "DEMO_RESET_SHA"],
  "Switch (gate agent, rooms, policy)": ["SWITCH_BRIDGE_URL", "SWITCH_AGENT_ID", "SWITCH_AGENT_API_KEY", "SWITCH_ROOM_ID", "SWITCH_INTAKE_ROOM_ID", "SWITCH_SELF_ID", "SWITCH_GATE_MENTION", "SWITCH_POLICY_USER_IDS", "SWITCH_POLICY_AGENT_IDS"],
  "Identities (maintainer, fixer, verifier)": ["LOOPBACK_MAINTAINERS", "LOOPBACK_FIXER_ID", "LOOPBACK_VERIFIER_ID", "LOOPBACK_FIXER_AGENT_ID", "LOOPBACK_VERIFIER_AGENT_ID"],
  "Signing (D28/D29)": ["VERIFIER_PUBLIC_KEY", "LOOPBACK_RUN_ISSUER_KEY_PATH"],
});
export const FLAGS = Object.freeze(["MERGE_ENABLED", "LOOPBACK_PRIVILEGED_ENABLED", "VERIFIER_ISOLATION_PROVEN"]);
export const CONTAINERS = Object.freeze(["loopback-fixer", "loopback-verifier", "loopback-signer", "loopback-runner", "loopback-proxy-fixer", "loopback-proxy-verifier", "loopback-proxy-signer"]);

const item = (group, ok, text, owner) => ({ group, ok, text, owner });

/**
 * Pure assessment. facts: { env: Record<name, value>, keyModes: Record<name, number|null>,
 * daemon: boolean, containers: string[], credFiles: Record<file, {mode:number, names:string[]}|null>,
 * tagRuleset: boolean|null }.
 */
export function assessReadiness(f) {
  const out = [];
  for (const [group, names] of Object.entries(REQUIRED)) {
    const missing = names.filter((n) => !(f.env[n] ?? "").trim());
    out.push(item(group, missing.length === 0, missing.length === 0 ? "all set" : `missing: ${missing.join(", ")}`, "owner"));
  }
  for (const [name, mode] of Object.entries(f.keyModes)) {
    if (!(f.env[name] ?? "").trim()) continue;
    out.push(item("Key files", mode === 0o600 || mode === 0o400, mode === null ? `${name}: file not found` : `${name}: mode ${mode.toString(8)}`, "owner"));
  }
  for (const flag of FLAGS) {
    const v = (f.env[flag] ?? "").trim();
    out.push(item("Safety flags", v === "" || v === "false", `${flag}=${v || "(unset)"} ${v === "" || v === "false" ? "(off, as required)" : "(ON: turn it off; only the owner may enable it after the live proofs)"}`, "owner"));
  }
  out.push(item("Isolation runtime", f.daemon, f.daemon ? "rootless daemon running" : "rootless daemon not running (deploy/isolation/rootless-docker.sh start)", "local"));
  const down = CONTAINERS.filter((c) => !f.containers.includes(c));
  out.push(item("Isolation runtime", down.length === 0, down.length === 0 ? "all containers running" : `not running: ${down.join(", ")} (agents.sh up; signer needs signer-init + signer.env)`, "local"));
  for (const [file, need] of [["fixer.env", ["GH_TOKEN", "GH_REPO"]], ["verifier.env", ["GH_TOKEN", "GH_REPO"]], ["signer.env", ["SIGNER_REPOSITORY", "SIGNER_ISSUER_PUBLIC_KEY"]]]) {
    const c = f.credFiles[file];
    const missing = c ? need.filter((n) => !c.names.includes(n)) : need;
    const ok = c !== null && c !== undefined && c.mode === 0o600 && missing.length === 0;
    out.push(item("Agent credentials", ok, c ? `${file}: mode ${c.mode.toString(8)}${missing.length ? `, missing ${missing.join(", ")}` : ""}` : `${file}: absent (owner issues the token; see scripts/probe-agent-token.sh)`, "owner"));
  }
  if ((f.env.VERIFIER_PUBLIC_KEY ?? "").trim()) {
    out.push(item("Signing (D28/D29)", f.signerKeyMatch === true, f.signerKeyMatch === null ? "VERIFIER_PUBLIC_KEY: could not compare with the signer (initialize it and start the runtime)" : f.signerKeyMatch ? "VERIFIER_PUBLIC_KEY is the signer's public key" : "VERIFIER_PUBLIC_KEY is NOT the signer's public key (an old verifier-held key would bypass the signer)", "owner"));
  }
  out.push(item("GitHub rulesets", f.tagRuleset === true, f.tagRuleset === null ? "tag ruleset: could not check (gh)" : f.tagRuleset ? "demo-reset tag ruleset present" : "demo-reset tag ruleset missing (deploy/github/protect-demo-reset-tag.sh --apply)", "owner"));
  return out;
}

function envNames(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    // Values are kept only for presence checks and the safety flags; nothing else is printed.
    env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return env;
}

function modeOf(path) {
  try { return lstatSync(path).mode & 0o777; } catch { return null; }
}

function credFile(dir, name) {
  const p = join(dir, name);
  const mode = modeOf(p);
  if (mode === null) return null;
  let names = [];
  try { names = readFileSync(p, "utf8").split(/\r?\n/).map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=\s*\S/.exec(l)?.[1]).filter(Boolean); } catch { /* unreadable */ }
  return { mode, names };
}

/** SPKI DER of an Ed25519 public key given as PEM or raw 32-byte base64, or null. */
export function spkiOf(text) {
  try {
    const t = String(text).trim();
    const key = t.startsWith("-----BEGIN") ? createPublicKey(t) : createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(t, "base64")]), format: "der", type: "spki" });
    return key.export({ type: "spki", format: "der" }).toString("base64");
  } catch {
    return null;
  }
}

function gather(repoRoot) {
  const env = envNames(join(repoRoot, ".env"));
  const resolve = (p) => (p.startsWith("/") ? p : join(repoRoot, p));
  const keyModes = {};
  for (const k of ["GH_APP_PRIVATE_KEY_PATH", "LOOPBACK_RUN_ISSUER_KEY_PATH"]) keyModes[k] = env[k] ? modeOf(resolve(env[k])) : null;
  const runtime = join(repoRoot, "deploy", "isolation", "rootless-docker.sh");
  let daemon;
  try { execFileSync(runtime, ["status"], { stdio: "ignore" }); daemon = true; } catch { daemon = false; }
  let containers = [];
  if (daemon) {
    try {
      const host = execFileSync(runtime, ["env"], { encoding: "utf8" }).trim().replace(/^DOCKER_HOST=/, "");
      containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8", env: { ...process.env, DOCKER_HOST: host } }).split("\n").filter(Boolean);
    } catch { containers = []; }
  }
  const credDir = process.env.LOOPBACK_AGENT_CRED_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "loopback-agents");
  const credFiles = Object.fromEntries(["fixer.env", "verifier.env", "signer.env"].map((n) => [n, credFile(credDir, n)]));
  let tagRuleset = null;
  if (env.GH_REPO) {
    try {
      const out = execFileSync("gh", ["api", `repos/${env.GH_REPO}/rulesets`, "--jq", '[.[] | select(.target == "tag")] | length'], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      tagRuleset = Number(out.trim()) > 0;
    } catch { tagRuleset = null; }
  }
  let signerKeyMatch = null;
  if (daemon && env.VERIFIER_PUBLIC_KEY) {
    try {
      const host = execFileSync(runtime, ["env"], { encoding: "utf8" }).trim().replace(/^DOCKER_HOST=/, "");
      const pub = execFileSync("docker", ["run", "--rm", "--network", "none", "--user", "10003:10003", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-e", "SIGNER_HOME=/home/signer", "-v", "loopback-signer-home:/home/signer", "loopback-agent:local", "node", "/opt/loopback-app/apps/switch-gate/dist/signer/main.js", "public-key"],
      { encoding: "utf8", env: { ...process.env, DOCKER_HOST: host }, stdio: ["ignore", "pipe", "ignore"] });
      const a = spkiOf(pub);
      const b = spkiOf(env.VERIFIER_PUBLIC_KEY);
      signerKeyMatch = a !== null && b !== null && a === b;
    } catch { signerKeyMatch = null; }
  }
  return { env, keyModes, daemon, containers, credFiles, tagRuleset, signerKeyMatch };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const items = assessReadiness(gather(root));
  let group = "";
  for (const i of items) {
    if (i.group !== group) { group = i.group; process.stdout.write(`== ${group}\n`); }
    process.stdout.write(`${i.ok ? "READY  " : "MISSING"}  ${i.text}${i.ok ? "" : `  [${i.owner}]`}\n`);
  }
  const missing = items.filter((i) => !i.ok).length;
  process.stdout.write(`== ${missing === 0 ? "ready for the live end-to-end run" : `${missing} item(s) missing; the live end-to-end run is NOT ready`}\n`);
  process.exitCode = missing === 0 ? 0 : 1;
}
