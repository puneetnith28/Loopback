#!/usr/bin/env node
// Is this credential file private to you? Exit 0 yes, 1 no (the reason goes to stderr), 2 cannot
// tell. deploy/isolation/agents.sh uses it on Windows, where `stat` in Git Bash reports invented
// modes. It uses the gate's own ACL rules, so run `npm run build` first. Prints no file contents.

import { windowsPermissions } from "../apps/switch-gate/dist/platform/windows-acl.js";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: check-private-file.mjs <path>\n");
  process.exit(2);
}
const problem = windowsPermissions().file(path);
if (problem !== null) {
  process.stderr.write(`${path}: ${problem}\n`);
  process.exit(1);
}
