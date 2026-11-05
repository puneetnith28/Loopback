#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { isMainModule } from "./sh.mjs";

const WORKSPACES = [
  "package.json",
  "packages/contracts/package.json",
  "packages/console-contracts/package.json",
  "apps/switch-gate/package.json",
  "apps/console/package.json",
  "apps/console-api/package.json",
];

export function checkReleaseReadiness(expectedVersion) {
  const versions = new Map();
  const rootDir = process.cwd();

  for (const relPath of WORKSPACES) {
    const fullPath = join(rootDir, relPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Workspace manifest not found: ${relPath}`);
    }
    const pkg = JSON.parse(readFileSync(fullPath, "utf8"));
    versions.set(relPath, pkg.version);
  }

  const [firstPath, firstVersion] = [...versions.entries()][0];
  for (const [path, ver] of versions.entries()) {
    if (ver !== firstVersion) {
      throw new Error(
        `Version mismatch: ${firstPath} has ${firstVersion}, but ${path} has ${ver}`,
      );
    }
  }

  const normalizedExpected = expectedVersion
    ? expectedVersion.replace(/^v/, "")
    : null;

  if (normalizedExpected && firstVersion !== normalizedExpected) {
    throw new Error(
      `Package version (${firstVersion}) does not match expected release version (${normalizedExpected})`,
    );
  }

  // Verify git state
  try {
    const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
    if (status.length > 0 && process.env.STRICT_GIT_CLEAN === "1") {
      throw new Error(`Git working tree is not clean:\n${status}`);
    }
  } catch (err) {
    if (process.env.STRICT_GIT_CLEAN === "1") throw err;
  }

  return {
    version: firstVersion,
    tag: `v${firstVersion}`,
    checkedFiles: [...versions.keys()],
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const arg = process.argv[2];
    const result = checkReleaseReadiness(arg);
    process.stdout.write(
      `[release-check] All ${result.checkedFiles.length} workspace manifests are consistent at version ${result.version} (${result.tag}).\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[release-check] ERROR: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exitCode = 1;
  }
}
