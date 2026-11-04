#!/usr/bin/env node
// Run one of the repository's Bash scripts on any platform.
//   node scripts/sh.mjs deploy/isolation/agents.sh up
//
// On Windows `bash` on PATH usually resolves to C:\Windows\System32\bash.exe, the WSL launcher,
// which runs the script in a different environment or fails outright. This finds Git Bash instead.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** Git Bash candidates, in order; `gitExecPath` is the output of `git --exec-path`, if known. */
export function bashCandidates(env, gitExecPath) {
  const out = [];
  if (env.LOOPBACK_BASH) out.push(env.LOOPBACK_BASH);
  if (gitExecPath) {
    const root = /^(.*?)[\\/](?:mingw64|mingw32|clangarm64|usr)[\\/]/i.exec(gitExecPath)?.[1];
    if (root) out.push(win32.join(root, "bin", "bash.exe"));
  }
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (base) out.push(win32.join(base, "Git", "bin", "bash.exe"));
  }
  if (env.LOCALAPPDATA) out.push(win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  return out.filter((p) => !/[\\/]system32[\\/]bash\.exe$/i.test(p));
}

export function findBash(platform = process.platform, env = process.env, exists = existsSync, execPath = gitExecPath) {
  if (platform !== "win32") return "bash";
  return bashCandidates(env, execPath()).find((p) => exists(p)) ?? null;
}

function gitExecPath() {
  try { return execFileSync("git", ["--exec-path"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

/** `import.meta.url` of a script compared with argv[1], tolerating Windows drive-letter case. */
export function isMainModule(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (!argv1) return false;
  const here = fileURLToPath(metaUrl);
  return platform === "win32" ? here.toLowerCase() === resolve(argv1).toLowerCase() : here === argv1;
}

if (isMainModule(import.meta.url)) {
  const [script, ...args] = process.argv.slice(2);
  if (!script) {
    process.stderr.write("usage: node scripts/sh.mjs <script.sh> [args...]\n");
    process.exit(2);
  }
  const bash = findBash();
  if (bash === null) {
    process.stderr.write("sh: Git Bash not found. Install Git for Windows, or set LOOPBACK_BASH to its bash.exe.\n");
    process.exit(2);
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = resolve(root, script).split("\\").join("/");
  // Git Bash rewrites arguments that look like POSIX paths (docker's /home/signer becomes
  // C:/Program Files/Git/home/signer) unless told not to.
  const r = spawnSync(bash, [path, ...args], { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
  if (r.error) {
    process.stderr.write(`sh: could not start ${bash}: ${r.error.message}\n`);
    process.exit(2);
  }
  process.exit(r.status ?? 1);
}
