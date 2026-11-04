#!/usr/bin/env node
// Ask the verifier signer to sign a Loopback verifier report (D29). Run inside the verifier
// container; the private signing key is NOT here — it lives only in the loopback-signer container.
//
//   node request-signature.mjs --capability <lbcap1...> < report.json
//
// Input (stdin): the report JSON object (without "signature"), or a message containing one
// ```loopback-report block. The capability is the "Signing capability:" line of the gate's
// verification request. Output (stdout): the signed report as one ```loopback-report block.
//
// Environment: LOOPBACK_SIGNER_URL (default http://signer:8080/v1/sign; plain HTTP on the
// internal signer network, never through HTTPS_PROXY), LOOPBACK_SIGNER_TOKEN_FILE (default
// ~/.config/loopback-verifier/signer-token: a regular file owned by the caller, mode 600).
// The token is sent only in the Authorization header and never printed. The signer checks
// everything again (capability, binding, live head, replay); this client decides nothing.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

function fail(message) {
  process.stderr.write(`request-signature: ${message}\n`);
  process.exit(1);
}

function capabilityArg(argv) {
  const i = argv.indexOf("--capability");
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (typeof v !== "string" || !/^lbcap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) fail("usage: request-signature.mjs --capability <lbcap1...> < report.json");
  return v;
}

function readToken() {
  const path = process.env.LOOPBACK_SIGNER_TOKEN_FILE || join(homedir(), ".config", "loopback-verifier", "signer-token");
  let st;
  try { st = lstatSync(path); } catch { return fail(`no signer token at ${path}`); }
  if (!st.isFile()) fail(`${path} is not a regular file`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail(`${path} is not owned by you`);
  if ((st.mode & 0o777) !== 0o600) fail(`${path} must have mode 600`);
  const token = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) fail(`${path} does not hold a signer token`);
  return token;
}

function signerUrl() {
  let u;
  try { u = new URL(process.env.LOOPBACK_SIGNER_URL || "http://signer:8080/v1/sign"); } catch { return fail("LOOPBACK_SIGNER_URL is not a URL"); }
  if (u.protocol !== "http:" || u.username || u.password || !u.hostname) fail("LOOPBACK_SIGNER_URL must be http://<host>[:port]/v1/sign without credentials");
  return u;
}

function readReport() {
  let input;
  try { input = readFileSync(0); } catch { return fail("could not read the report from stdin"); }
  if (input.length === 0) fail("no report on stdin");
  if (input.length > MAX_INPUT_BYTES) fail("input is too large");
  const text = input.toString("utf8");
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() === "```loopback-report");
  let json = text;
  if (open >= 0) {
    const close = lines.findIndex((l, j) => j > open && l.trim() === "```");
    if (close < 0) fail("unterminated loopback-report block");
    json = lines.slice(open + 1, close).join("\n");
  }
  let report;
  try { report = JSON.parse(json); } catch { return fail("the report is not valid JSON"); }
  if (report === null || typeof report !== "object" || Array.isArray(report)) fail("the report must be a JSON object");
  if ("signature" in report) fail("the report is already signed");
  return report;
}

async function digestOf(report) {
  // The gate's canonicalization contract (system install beside this script, else the repository build).
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "signature.js"), join(here, "..", "apps", "switch-gate", "dist", "agents", "signature.js")]) {
    try {
      lstatSync(p);
    } catch {
      continue;
    }
    const { signedBytes } = await import(pathToFileURL(p).href);
    return `sha256:${createHash("sha256").update(signedBytes(report)).digest("hex")}`;
  }
  return fail("the canonicalization module (signature.js) was not found");
}

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    // node:http directly: HTTPS_PROXY is deliberately not used for the internal signer.
    const req = request(url, {
      method: "POST", timeout: TIMEOUT_MS,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size <= 16 * 1024) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("the signer did not answer in time")));
    req.on("error", reject);
    req.end(body);
  });
}

const capability = capabilityArg(process.argv.slice(2));
const report = readReport();
const token = readToken();
const url = signerUrl();
const reportDigest = await digestOf(report);
let res;
try {
  res = await post(url, token, JSON.stringify({ capability, report, reportDigest }));
} catch (e) {
  fail(`could not reach the signer (${e instanceof Error ? e.message : "error"})`);
}
let json;
try { json = JSON.parse(res.text); } catch { json = {}; }
if (res.status !== 200) fail(`the signer refused: ${typeof json.error === "string" ? json.error.replace(/[^A-Z_]/g, "") : res.status}`);
if (typeof json.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(json.signature) || json.reportDigest !== reportDigest) fail("the signer's answer does not match this report");
process.stdout.write("```loopback-report\n" + JSON.stringify({ ...report, signature: json.signature }) + "\n```\n");
