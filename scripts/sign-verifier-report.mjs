#!/usr/bin/env node
// Sign a Loopback verifier report (D28). Run ONLY as the verifier's own OS identity.
//
//   node scripts/sign-verifier-report.mjs < report.json
//
// Input (stdin): the report JSON object, or a message containing one ```loopback-report block.
// Output (stdout): the signed report as one ```loopback-report block, nothing else.
// Key: an Ed25519 private key (PKCS#8 PEM) at $VERIFIER_SIGNING_KEY_FILE, default
// ~/.config/loopback-verifier/signing-key.pem. The file must be a regular file owned by the
// current user with no group/world access, and its directory must not be writable by others.
//
// The helper never prints, logs or transmits the key, and never sends the report anywhere.
// It uses the gate's own canonicalization contract: signature.js beside this script (the
// system-wide install), else apps/switch-gate/dist/agents/signature.js (run `npm run build`). A signature proves key possession and report integrity, not that
// any test was executed.

import { createPrivateKey } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(message) {
  process.stderr.write(`sign-verifier-report: ${message}\n`);
  process.exit(1);
}

/**
 * The signature module is taken from beside this script when installed system-wide
 * (e.g. /usr/local/lib/loopback-signer/{sign-verifier-report.mjs,signature.js}, root-owned and
 * read-only, so it is reachable from an agent sandbox), otherwise from the repository build.
 * A module others can modify is refused: it decides what gets signed.
 */
async function loadSigner() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "signature.js"), join(here, "..", "apps", "switch-gate", "dist", "agents", "signature.js")];
  for (const path of candidates) {
    let st;
    let dir;
    try {
      st = lstatSync(path);
      dir = lstatSync(dirname(path));
    } catch {
      continue;
    }
    if (!st.isFile()) fail(`the signature module at ${path} is not a regular file`);
    // World-writable, or owned by someone other than root or the caller: anyone could change it.
    if ((st.mode & 0o002) !== 0 || (dir.mode & 0o002) !== 0) fail(`the signature module at ${path} (or its directory) is writable by others`);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && st.uid !== 0 && st.uid !== uid) fail(`the signature module at ${path} is owned by another user`);
    try {
      return await import(pathToFileURL(path).href);
    } catch {
      return fail(`the signature module at ${path} could not be loaded`);
    }
  }
  return fail("the signature module was not found beside this script or in the repository build; run `npm run build`");
}

function readStdin() {
  let input;
  try {
    input = readFileSync(0);
  } catch {
    return fail("could not read the report from stdin");
  }
  if (input.length === 0) fail("no report on stdin");
  if (input.length > MAX_INPUT_BYTES) fail("input is too large");
  return input.toString("utf8");
}

function parseReport(text) {
  const fenced = /```loopback-report\s*\n([\s\S]*?)\n```/.exec(text);
  let report;
  try {
    report = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return fail("the input is not a JSON report");
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) fail("the report must be a JSON object");
  if (report.type !== "verifier") fail('the report must have "type": "verifier"');
  if (typeof report.runId !== "string" || !UUID.test(report.runId)) fail('"runId" must be the run id from the gate\'s request');
  if (typeof report.headSha !== "string" || !FULL_SHA.test(report.headSha)) fail('"headSha" must be the full 40-character SHA you inspected');
  if (typeof report.repository !== "string" || typeof report.pullRequest !== "number") fail('"repository" and "pullRequest" are required');
  if (report.verdict !== "pass" && report.verdict !== "fail") fail('"verdict" must be "pass" or "fail"');
  if ("signature" in report) fail("the report is already signed; sign the unsigned report");
  return report;
}

function loadKey() {
  const path = process.env.VERIFIER_SIGNING_KEY_FILE || join(homedir(), ".config", "loopback-verifier", "signing-key.pem");
  let st;
  let dir;
  try {
    st = lstatSync(path);
    dir = lstatSync(dirname(path));
  } catch {
    return fail("the signing key file was not found (set VERIFIER_SIGNING_KEY_FILE)");
  }
  if (!st.isFile()) fail("the signing key path is not a regular file (symlinks are refused)");
  if ((st.mode & 0o077) !== 0) fail("the signing key file must not be group- or world-accessible (chmod 600)");
  if ((dir.mode & 0o022) !== 0) fail("the signing key directory must not be group- or world-writable (chmod 700)");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail("the signing key file must be owned by the user running this helper");
  let key;
  try {
    key = createPrivateKey({ key: readFileSync(path), format: "pem" });
  } catch {
    return fail("the signing key could not be read as a PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("the signing key is not an Ed25519 key");
  return key;
}

const { signReport } = await loadSigner();
const report = parseReport(readStdin());
const key = loadKey();
let signature;
try {
  signature = signReport(report, key);
} catch {
  fail("the report could not be signed (unsupported values in the report)");
}
process.stdout.write("```loopback-report\n" + JSON.stringify({ ...report, signature }) + "\n```\n");
