import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePublicKey } from "../agents/signature.js";
import { createPullReader } from "./github-pull.js";
import { FileReplayStore } from "./replay.js";
import { createSignerServer } from "./server.js";

/**
 * D29: the verifier signer process (runs only inside the loopback-signer container, uid 10003).
 *
 *   main.js init                 create the signing key and the client token in $SIGNER_HOME/keys
 *                                (refuses to overwrite); prints only the PUBLIC key
 *   main.js export-client-token  write the client token to stdout (piped straight into the
 *                                verifier container by deploy/isolation/agents.sh; never printed)
 *   main.js rotate-token         replace the client token (the key is kept); then re-run
 *                                agents.sh signer-token and restart the signer
 *   main.js public-key           print the public key
 *   main.js serve                serve POST /v1/sign on $SIGNER_PORT (default 8080)
 *
 * Configuration (environment): SIGNER_HOME (default /home/signer), SIGNER_REPOSITORY (owner/name),
 * SIGNER_ISSUER_PUBLIC_KEY (the gate's run-issuer PUBLIC key, PEM or raw base64), HTTPS_PROXY
 * (the signer's own egress proxy), optional SIGNER_GH_TOKEN (read-only; public repositories need none).
 */

const home = process.env.SIGNER_HOME ?? "/home/signer";
const keysDir = join(home, "keys");
const stateDir = join(home, "state");
const keyFile = join(keysDir, "signing-key.pem");
const tokenFile = join(keysDir, "client-token");

function fail(message: string, code = 1): never {
  process.stderr.write(`loopback-signer: ${message}\n`);
  process.exit(code);
}

/** A secret file must be a regular file owned by this process's uid, mode 600. */
function readSecret(path: string): string {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return fail(`not initialized: ${path} is missing (run deploy/isolation/agents.sh signer-init)`, 3);
  }
  if (!st.isFile()) fail(`${path} is not a regular file`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail(`${path} is not owned by the signer`);
  if ((st.mode & 0o777) !== 0o600) fail(`${path} must have mode 600`);
  return readFileSync(path, "utf8");
}

function loadSigningKey(): KeyObject {
  const key = createPrivateKey({ key: readSecret(keyFile), format: "pem" });
  if (key.asymmetricKeyType !== "ed25519") fail("the signing key is not Ed25519");
  return key;
}

const newToken = () => randomBytes(32).toString("hex");

function init(): void {
  if (existsSync(keyFile) || existsSync(tokenFile)) fail("already initialized (an existing key or token is never overwritten)");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  try {
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  } catch {
    fail("could not write the signing key");
  }
  try {
    writeFileSync(tokenFile, newToken(), { mode: 0o600, flag: "wx" });
  } catch {
    rmSync(keyFile, { force: true }); // never leave a half-initialized signer
    fail("could not write the client token; nothing was kept");
  }
  process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
}

/** Replace the client token atomically (write a temp file, rename). The signing key is untouched. */
function rotateToken(): void {
  readSecret(tokenFile); // must exist with safe permissions
  const tmp = `${tokenFile}.new`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, newToken(), { mode: 0o600, flag: "wx" });
  renameSync(tmp, tokenFile);
  process.stderr.write("client token rotated; run agents.sh signer-token and restart the signer\n");
}

async function serve(): Promise<void> {
  const repository = process.env.SIGNER_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("SIGNER_REPOSITORY must be owner/name");
  const issuerText = process.env.SIGNER_ISSUER_PUBLIC_KEY ?? "";
  if (issuerText.trim() === "") fail("SIGNER_ISSUER_PUBLIC_KEY (the gate's run-issuer public key) is required");
  let issuerPublicKey: KeyObject;
  try {
    issuerPublicKey = parsePublicKey(issuerText);
  } catch {
    return fail("SIGNER_ISSUER_PUBLIC_KEY is not an Ed25519 public key");
  }
  const portText = process.env.SIGNER_PORT ?? "8080";
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) fail("SIGNER_PORT must be a port number");
  const port = Number(portText);
  const signingKey = loadSigningKey();
  const clientToken = readSecret(tokenFile).trim();
  const proxyText = process.env.HTTPS_PROXY ?? "";
  const proxy = proxyText === "" ? null : new URL(proxyText);
  const ghToken = (process.env.SIGNER_GH_TOKEN ?? "").trim();
  const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);
  const server = createSignerServer({
    clientToken,
    policy: {
      issuerPublicKey, signingKey, allowedRepository: repository, now: () => new Date(),
      livePull: createPullReader({ proxy, token: ghToken === "" ? null : ghToken }),
      replay: new FileReplayStore(stateDir),
    },
    log,
    maxPerMinute: 30,
  });
  // Listen only on the signer network's address (the alias "signer" resolves there), not on the
  // signer's egress network.
  let address: string;
  try {
    address = (await lookup(process.env.SIGNER_BIND_HOST ?? "signer")).address;
  } catch {
    return fail("cannot resolve the signer network address (SIGNER_BIND_HOST)");
  }
  server.listen(port, address, () => log({ event: "signer.listening", address, port, repository }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const command = process.argv[2] ?? "";
if (command === "init") init();
else if (command === "export-client-token") process.stdout.write(readSecret(tokenFile).trim());
else if (command === "public-key") process.stdout.write(createPublicKey(loadSigningKey()).export({ type: "spki", format: "pem" }).toString());
else if (command === "rotate-token") rotateToken();
else if (command === "serve") await serve();
else fail("usage: main.js init|export-client-token|rotate-token|public-key|serve", 2);
