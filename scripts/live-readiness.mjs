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
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBash, isMainModule } from "./sh.mjs";

/**
 * Prerequisites by group, derived from the gate's configuration loaders (apps/switch-gate/src/config.ts)
 * and kept in step by tests/unit/live-readiness.test.ts: every variable without a default that the
 * Switch, identity and GitHub loaders reject when absent; the ones the identity loader requires in
 * isolated mode (agent ids, VERIFIER_PUBLIC_KEY, LOOPBACK_RUN_ISSUER_KEY_PATH), because the live run
 * targets signed verification; and DEMO_RESET_SHA, which the demo run itself needs (D17).
 * Defaulted variables (e.g. SWITCH_GATE_MENTION, GATE_STATUS_CONTEXT) are not listed.
 */
export const REQUIRED = Object.freeze({
  "GitHub (gate App)": ["GH_REPO", "GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH", "BASE_BRANCH", "REQUIRED_CHECKS", "CHECK_SOURCES", "REQUIRED_CHECK_INTEGRATIONS", "DEMO_RESET_SHA"],
  "Switch (gate agent, rooms, policy)": ["SWITCH_BRIDGE_URL", "SWITCH_AGENT_ID", "SWITCH_AGENT_API_KEY", "SWITCH_ROOM_ID", "SWITCH_INTAKE_ROOM_ID", "SWITCH_SELF_ID", "SWITCH_POLICY_USER_IDS", "SWITCH_POLICY_AGENT_IDS"],
  "Identities (maintainer, reporters, fixer, verifier)": ["LOOPBACK_MAINTAINERS", "LOOPBACK_REPORTERS", "LOOPBACK_FIXER_ID", "LOOPBACK_VERIFIER_ID", "LOOPBACK_FIXER_AGENT_ID", "LOOPBACK_VERIFIER_AGENT_ID"],
  "Signing (D28/D29)": ["VERIFIER_PUBLIC_KEY", "LOOPBACK_RUN_ISSUER_KEY_PATH"],
});
export const FLAGS = Object.freeze(["MERGE_ENABLED", "LOOPBACK_PRIVILEGED_ENABLED", "VERIFIER_ISOLATION_PROVEN"]);
export const CONTAINERS = Object.freeze(["loopback-fixer", "loopback-verifier", "loopback-signer", "loopback-runner", "loopback-proxy-fixer", "loopback-proxy-verifier", "loopback-proxy-signer"]);

const item = (group, ok, text, owner) => ({ group, ok, text, owner });

/** A file's privacy: a POSIX mode, or on Windows the problem found in its ACL (null = none). */
const privacy = (state) => (typeof state === "number"
  ? { ok: state === 0o600 || state === 0o400, text: `mode ${state.toString(8)}` }
  : { ok: state.aclProblem === null, text: state.aclProblem ?? "private to you (ACL)" });

/**
/**
 * Semantic validation with the GATE'S OWN rules (apps/switch-gate config.ts), never a copy:
 * the Switch, identity, GitHub and runtime loaders, the cross-group identity checks, and the
 * run-issuer key loader, exactly as start-up runs them. `rules` holds those functions (the CLI
 * imports them from the build; tests pass the TypeScript source). Issue messages come from the
 * gate's schemas and never contain values.
 *
 * scope "current": what the gate would reject at start-up with this configuration.
 * scope "isolated": what would still block isolated verification (D28/D29), evaluated with
 * VERIFIER_ISOLATION_PROVEN=true in an in-memory copy only; the real flag is never changed.
 *
 * A relative GH_APP_PRIVATE_KEY_PATH is resolved against `root` (the gate runs from the
 * repository root); LOOPBACK_RUN_ISSUER_KEY_PATH is passed as given (the gate requires it absolute).
 */
export function evaluateGateConfig(env, rules, { root }) {
  const issues = [];
  const run = (scope, group, fn) => {
    try {
      fn();
      return true;
    } catch (e) {
      if (typeof rules.ConfigError === "function" && e instanceof rules.ConfigError) {
        for (const i of e.issues) issues.push({ scope, group, variable: i.variable, message: i.message });
      } else {
        issues.push({ scope, group, variable: `(${group})`, message: "could not be evaluated" });
      }
      return false;
    }
  };
  const keyPath = env.GH_APP_PRIVATE_KEY_PATH;
  const ghEnv = keyPath && !isAbsolute(keyPath) ? { ...env, GH_APP_PRIVATE_KEY_PATH: resolve(root, keyPath) } : env;
  let sw = null;
  let id = null;
  // Same order as the gate's start-up (run.ts, app.ts): loaders, identity consistency, run-issuer key.
  const ran = {
    switch: run("current", "Switch", () => { sw = rules.loadSwitchConfig(env); }),
    identity: run("current", "identity", () => { id = rules.loadIdentityConfig(env); }),
    github: run("current", "GitHub", () => rules.loadGitHubConfig(ghEnv)),
    runtime: run("current", "runtime", () => rules.loadRuntimeConfig(env)),
    consistency: false,
    issuerKey: false,
    isolatedIdentity: false,
    isolatedConsistency: false,
  };
  if (sw && id) ran.consistency = run("current", "identity", () => rules.assertIdentityConsistency(sw, id));
  if (id) ran.issuerKey = id.runIssuerKeyPath === null ? true : run("current", "identity", () => rules.loadRunIssuerKey(id.runIssuerKeyPath));

  // Isolated target: an in-memory copy with VERIFIER_ISOLATION_PROVEN=true; the real flag is untouched.
  const key = (i) => `${i.group}\u0000${i.variable}\u0000${i.message}`;
  const before = new Set(issues.map(key));
  let isoId = null;
  ran.isolatedIdentity = run("isolated", "identity", () => { isoId = rules.loadIdentityConfig({ ...env, VERIFIER_ISOLATION_PROVEN: "true" }); });
  if (sw && isoId) ran.isolatedConsistency = run("isolated", "identity", () => rules.assertIdentityConsistency(sw, isoId));
  // Keep only what isolated mode adds; anything already wrong now is reported once, as "current".
  const seen = new Set();
  const out = issues.filter((i) => (i.scope === "current" || !before.has(key(i))) && !seen.has(`${i.scope}\u0000${key(i)}`) && seen.add(`${i.scope}\u0000${key(i)}`));
  return { issues: out, ran };
}

/**
 * Pure assessment. facts: { env: Record<name, value>, keyModes: Record<name, number|{aclProblem}|null>,
 * daemon: boolean, containers: string[], credFiles: Record<file, {mode:number|{aclProblem}, names:string[]}|null>,
 * tagRuleset: boolean|null, tools?: Record<name, boolean> }.
 */
export function assessReadiness(f) {
  const out = [];
  for (const [group, names] of Object.entries(REQUIRED)) {
    const missing = names.filter((n) => !(f.env[n] ?? "").trim());
    out.push(item(group, missing.length === 0, missing.length === 0 ? "all set" : `missing: ${missing.join(", ")}`, "owner"));
  }
  const absent = new Set(Object.values(REQUIRED).flat().filter((n) => !(f.env[n] ?? "").trim()));
  const gc = f.gateConfig;
  const G = "Gate configuration (the gate's own rules)";
  const ISO = "Isolated verification target (flags stay off)";
  if (gc === undefined || !gc.available) {
    out.push(item(G, false, `cannot check: ${gc?.reason === "stale" ? "the gate build is older than its sources" : "the gate build was not found or is incomplete"} (run npm run build)`, "local"));
    out.push(item(ISO, false, "not checked (the gate's rules are unavailable)", "local"));
  } else {
    const ran = gc.ran ?? {};
    const current = gc.issues.filter((i) => i.scope === "current" && !absent.has(i.variable));
    // A rule group that stopped (at a missing or rejected value) did not run its later rules:
    // acceptance is claimed only when every rule actually ran without an issue.
    const allRan = ["switch", "identity", "github", "runtime", "consistency", "issuerKey"].every((k) => ran[k] === true);
    for (const i of current) out.push(item(G, false, `${i.variable}: ${i.message}`, "owner"));
    const stoppedOnAbsent = [...new Set(gc.issues.filter((i) => i.scope === "current" && absent.has(i.variable)).map((i) => i.group))];
    for (const g of stoppedOnAbsent) out.push(item(G, false, `${g} rules only partly checked: the gate stops at the missing values above; its remaining rules run once they are set`, "owner"));
    if (allRan && current.length === 0 && stoppedOnAbsent.length === 0) {
      out.push(item(G, true, "the gate's configuration rules accept the configuration (not run here: the live Switch addressing-policy check, parsing the App key, opening the database)", "owner"));
    } else if (current.length === 0 && stoppedOnAbsent.length === 0) {
      out.push(item(G, false, "not every configuration rule could run", "owner"));
    }
    const isolated = gc.issues.filter((i) => i.scope === "isolated");
    for (const i of isolated) out.push(item(ISO, false, `${i.variable}: ${i.message}`, "owner"));
    const isoRan = allRan && ran.isolatedIdentity === true && ran.isolatedConsistency === true;
    if (isolated.length === 0) {
      out.push(isoRan
        ? item(ISO, true, "no additional blocker for isolated verification", "owner")
        : item(ISO, false, "not checked yet: it depends on configuration rules that did not all run (see above)", "owner"));
    }
  }
  for (const [name, state] of Object.entries(f.keyModes)) {
    if (!(f.env[name] ?? "").trim()) continue;
    if (state === null) { out.push(item("Key files", false, `${name}: file not found`, "owner")); continue; }
    const p = privacy(state);
    out.push(item("Key files", p.ok, `${name}: ${p.text}`, "owner"));
  }
  for (const [tool, present] of Object.entries(f.tools ?? {})) {
    out.push(item("Tools", present, present ? `${tool} found` : `${tool} not found (docs/windows.md)`, "local"));
  }
  for (const flag of FLAGS) {
    const v = (f.env[flag] ?? "").trim();
    out.push(item("Safety flags", v === "" || v === "false", `${flag}=${v || "(unset)"} ${v === "" || v === "false" ? "(off, as required)" : "(ON: turn it off; only the owner may enable it after the live proofs)"}`, "owner"));
  }
  const daemonName = f.desktop ? "Docker Desktop" : "rootless daemon";
  out.push(item("Isolation runtime", f.daemon, f.daemon ? `${daemonName} running` : `${daemonName} not running (${f.desktop ? "start Docker Desktop" : "deploy/isolation/rootless-docker.sh start"})`, "local"));
  const down = CONTAINERS.filter((c) => !f.containers.includes(c));
  out.push(item("Isolation runtime", down.length === 0, down.length === 0 ? "all containers running" : `not running: ${down.join(", ")} (agents.sh up; signer needs signer-init + signer.env)`, "local"));
  for (const [file, need] of [["fixer.env", ["GH_TOKEN", "GH_REPO"]], ["verifier.env", ["GH_TOKEN", "GH_REPO"]], ["signer.env", ["SIGNER_REPOSITORY", "SIGNER_ISSUER_PUBLIC_KEY"]]]) {
    const c = f.credFiles[file];
    const missing = c ? need.filter((n) => !c.names.includes(n)) : need;
    const p = c ? privacy(c.mode) : { ok: false, text: "" };
    const strict = c && typeof c.mode === "number" ? c.mode === 0o600 : p.ok;
    out.push(item("Agent credentials", Boolean(c) && strict && missing.length === 0, c ? `${file}: ${p.text}${missing.length ? `, missing ${missing.join(", ")}` : ""}` : `${file}: absent (owner issues the token; see scripts/probe-agent-token.sh)`, "owner"));
  }
  if ((f.env.VERIFIER_PUBLIC_KEY ?? "").trim()) {
    out.push(item("Signing (D28/D29)", f.signerKeyMatch === true, f.signerKeyMatch === null ? "VERIFIER_PUBLIC_KEY: could not compare with the signer (initialize it and start the runtime)" : f.signerKeyMatch ? "VERIFIER_PUBLIC_KEY is the signer's public key" : "VERIFIER_PUBLIC_KEY is NOT the signer's public key (an old verifier-held key would bypass the signer)", "owner"));
  }
  out.push(item("GitHub rulesets", f.tagRuleset === true, f.tagRuleset === null ? "tag ruleset: could not check (gh)" : f.tagRuleset ? "demo-reset tag ruleset present" : "demo-reset tag ruleset missing (deploy/github/protect-demo-reset-tag.sh --apply)", "owner"));
  return out;
}

/**
/**
 * Parse .env text. An inline comment on an empty setting ("NAME=   # note") is not a value: it
 * must read as empty, as node --env-file reads it, or a missing setting would be reported as set.
 * Values are kept only for presence checks and the safety flags; nothing else is printed.
 */
export function parseEnvText(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^#.*$/, "").replace(/\s+#.*$/, "");
  }
  return env;
}

/**
 * Parse an env file the way `docker run --env-file` hands it to the gate (docs/operations.md):
 * blank and `#` lines are skipped; everything after the first `=` is the value, verbatim (an
 * inline `# comment` or quotes are part of the value the gate sees).
 */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function envNames(path) {
  return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
}

/** POSIX mode bits, or on Windows the gate's own ACL rules (which need `npm run build`). */
async function fileStateReader() {
  if (process.platform !== "win32") {
    return (path) => { try { return lstatSync(path).mode & 0o777; } catch { return null; } };
  }
  let host;
  try {
    host = (await import("../apps/switch-gate/dist/platform/windows-acl.js")).windowsPermissions();
  } catch {
    return (path) => (existsSync(path) ? { aclProblem: "permissions not checked; run npm run build" } : null);
  }
  return (path) => (existsSync(path) ? { aclProblem: host.file(path) } : null);
}

function credFile(dir, name, stateOf) {
  const p = join(dir, name);
  const mode = stateOf(p);
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

/** Is this `docker info` the Docker Desktop daemon running Linux containers? */
export function isDesktopDaemon(infoLine) {
  return infoLine.trim() === "Docker Desktop/linux";
}

const commandExists = (command, args = ["--version"]) => {
  try { execFileSync(command, args, { stdio: "ignore", windowsHide: true }); return true; } catch { return false; }
};

async function gather(repoRoot) {
  const env = envNames(join(repoRoot, ".env"));
  const desktop = process.platform === "win32";
  const stateOf = await fileStateReader();
  const keyModes = {};
  for (const k of ["GH_APP_PRIVATE_KEY_PATH", "LOOPBACK_RUN_ISSUER_KEY_PATH"]) keyModes[k] = env[k] ? stateOf(resolve(repoRoot, env[k])) : null;
  const runtime = join(repoRoot, "deploy", "isolation", "rootless-docker.sh");
  let daemon;
  let dockerEnv = process.env;
  if (desktop) {
    try {
      daemon = isDesktopDaemon(execFileSync("docker", ["info", "--format", "{{.OperatingSystem}}/{{.OSType}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch { daemon = false; }
  } else {
    try { execFileSync(runtime, ["status"], { stdio: "ignore" }); daemon = true; } catch { daemon = false; }
    if (daemon) {
      try {
        dockerEnv = { ...process.env, DOCKER_HOST: execFileSync(runtime, ["env"], { encoding: "utf8" }).trim().replace(/^DOCKER_HOST=/, "") };
      } catch { daemon = false; }
    }
  }
  let containers = [];
  if (daemon) {
    try {
      containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8", env: dockerEnv }).split(/\r?\n/).filter(Boolean);
    } catch { containers = []; }
  }
  const tools = desktop ? { "Git Bash": findBash() !== null, gh: commandExists("gh"), jq: commandExists("jq") } : {};
  const credDir = process.env.LOOPBACK_AGENT_CRED_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "loopback-agents");
  const credFiles = Object.fromEntries(["fixer.env", "verifier.env", "signer.env"].map((n) => [n, credFile(credDir, n, stateOf)]));
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
      const pub = execFileSync("docker", ["run", "--rm", "--network", "none", "--user", "10003:10003", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-e", "SIGNER_HOME=/home/signer", "-v", "loopback-signer-home:/home/signer", "loopback-agent:local", "node", "/opt/loopback-app/apps/switch-gate/dist/signer/main.js", "public-key"],
      { encoding: "utf8", env: dockerEnv, stdio: ["ignore", "pipe", "ignore"] });
      const a = spkiOf(pub);
      const b = spkiOf(env.VERIFIER_PUBLIC_KEY);
      signerKeyMatch = a !== null && b !== null && a === b;
    } catch { signerKeyMatch = null; }
  }
  return { env, keyModes, daemon, desktop, containers, tools, credFiles, tagRuleset, signerKeyMatch };
}

export const RULE_EXPORTS = Object.freeze(["ConfigError", "loadSwitchConfig", "loadIdentityConfig", "loadGitHubConfig", "loadRuntimeConfig", "assertIdentityConsistency", "loadRunIssuerKey"]);

/** A built rules module is used only if it has every rule and is newer than every rule source. */
export function rulesUsable(mod, distMtimeMs, sourceMtimesMs) {
  if (mod === null || typeof mod !== "object" || !RULE_EXPORTS.every((n) => typeof mod[n] === "function")) return { ok: false, reason: "incomplete" };
  if (sourceMtimesMs.some((t) => t > distMtimeMs)) return { ok: false, reason: "stale" };
  return { ok: true };
}

/** The gate's configuration rules from its build: { rules } or { reason } when unusable. */
async function gateRules(repoRoot) {
  const built = join(repoRoot, "apps", "switch-gate", "dist", "config.js");
  if (!existsSync(built)) return { reason: "missing" };
  let mod;
  try { mod = await import(pathToFileURL(built).href); } catch { return { reason: "incomplete" }; }
  // Build time per project = newest of its emitted file and its .tsbuildinfo: `tsc -b` does not
  // re-emit an unchanged output, but always records the build in .tsbuildinfo.
  const mtime = (...parts) => { const p = join(repoRoot, ...parts); return existsSync(p) ? statSync(p).mtimeMs : 0; };
  const projects = [
    { built: Math.max(mtime("apps", "switch-gate", "dist", "config.js"), mtime("apps", "switch-gate", "dist", ".tsbuildinfo")),
      sources: [mtime("apps", "switch-gate", "src", "config.ts"), mtime("apps", "switch-gate", "src", "agents", "signature.ts")] },
    { built: Math.max(mtime("packages", "contracts", "dist", "index.js"), mtime("packages", "contracts", "dist", ".tsbuildinfo")),
      sources: [mtime("packages", "contracts", "src", "index.ts")] },
  ];
  for (const pr of projects) {
    const verdict = rulesUsable(mod, pr.built, pr.sources);
    if (!verdict.ok) return { reason: verdict.reason };
  }
  return { rules: mod };
}

if (isMainModule(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const facts = await gather(root);
  const loaded = await gateRules(root);
  facts.gateConfig = loaded.rules === undefined ? { available: false, reason: loaded.reason, issues: [] } : { available: true, ...evaluateGateConfig(facts.env, loaded.rules, { root }) };
  const items = assessReadiness(facts);
  let group = "";
  for (const i of items) {
    if (i.group !== group) { group = i.group; process.stdout.write(`== ${group}\n`); }
    process.stdout.write(`${i.ok ? "READY  " : "MISSING"}  ${i.text}${i.ok ? "" : `  [${i.owner}]`}\n`);
  }
  const missing = items.filter((i) => !i.ok).length;
  process.stdout.write(`== ${missing === 0 ? "ready for the live end-to-end run" : `${missing} item(s) missing; the live end-to-end run is NOT ready`}\n`);
  process.exitCode = missing === 0 ? 0 : 1;
}
