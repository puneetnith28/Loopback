#!/usr/bin/env node
// The full Linux test suite on any machine with Docker, including the POSIX-only suites that skip
// themselves on Windows (signer, sandbox runner, OS signals, file modes, isolation checker).
//   npm run test:linux
//
// It tests your current tracked files, including uncommitted edits, in a throwaway container: a
// copy goes in through `git archive`, so nothing on your machine is mounted or changed, and the
// suite runs as an unprivileged user because root would bypass the permission tests. Untracked
// files are not included.

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The same base image as deploy/isolation/agent/Dockerfile.
const IMAGE = "node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// Docker must be answering first: otherwise the archive is piped into a docker process that has already
// exited, and the run dies on EPIPE with nothing to say what is wrong.
try {
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
} catch {
  process.stderr.write("test-linux: Docker is not running. Start Docker Desktop (or the Docker service), then run this again.\n");
  process.exit(2);
}

// `git stash create` records the working tree as a commit without touching it; empty means clean.
const tree = git("stash", "create") || "HEAD";

// The archive arrives on stdin, so it is saved before anything else can read from there.
const inner = `set -euo pipefail
cat >/tmp/source.tar
apt-get update -qq >/dev/null </dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git jq openssl ca-certificates >/dev/null </dev/null
install -d -o node -g node /work
chmod 644 /tmp/source.tar
runuser -u node -- bash -c '
  set -euo pipefail
  tar -x -C /work -f /tmp/source.tar
  cd /work
  git init -q . && git config user.email test@example.invalid && git config user.name test && git add -A >/dev/null && git commit -qm snapshot
  npm ci --no-audit --no-fund >/dev/null
  npm run typecheck
  npm run lint
  npx vitest run
'`;

const archive = spawn("git", ["archive", "--format=tar", tree], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
const docker = spawn("docker", ["run", "--rm", "-i", "--init", "-e", "NO_COLOR=1", "--network", "bridge", IMAGE, "bash", "-c", inner], { stdio: ["pipe", "inherit", "inherit"] });
archive.stdout.pipe(docker.stdin);
// If docker stops reading early, it exits with its own code; the closed pipe is not a second error.
docker.stdin.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
docker.on("close", (code) => { process.exitCode = code ?? 1; });
docker.on("error", (e) => {
  process.stderr.write(`test-linux: could not start docker: ${e.message}\n`);
  process.exitCode = 2;
});
