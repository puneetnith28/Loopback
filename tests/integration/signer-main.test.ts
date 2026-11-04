import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parsePublicKey } from "../../apps/switch-gate/src/agents/signature.js";

// D29: the signer entry point (dist/signer/main.js): key and token creation, token export and
// rotation, and fail-closed start-up. Run as a real process against a temporary SIGNER_HOME.

const ON_WINDOWS = process.platform === "win32";
// Skipped on Windows: POSIX modes and ownership of the key files; the signer runs only in its Linux container.
const MAIN = join(process.cwd(), "apps", "switch-gate", "dist", "signer", "main.js");
let home = "";

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", SIGNER_HOME: home, ...env } });

beforeAll(() => { if (!ON_WINDOWS) execFileSync("npx", ["tsc", "-b"], { stdio: "ignore" }); }, 120_000);
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = ""; });
const fresh = () => { home = mkdtempSync(join(tmpdir(), "loopback-signer-home-")); chmodSync(home, 0o700); };

describe.skipIf(ON_WINDOWS)("signer main.js", () => {
  it("init creates an owner-only key and token, prints only the public key, and never overwrites", () => {
    fresh();
    const r = run(["init"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(r.stdout).not.toMatch(/PRIVATE/);
    expect(() => parsePublicKey(r.stdout)).not.toThrow();
    for (const f of ["keys/signing-key.pem", "keys/client-token"]) expect(statSync(join(home, f)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "state")).mode & 0o777).toBe(0o700);
    const again = run(["init"]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already initialized/);
    expect(run(["public-key"]).stdout).toBe(r.stdout);
  });

  it("export-client-token prints the 64-hex token only; rotate-token replaces the token and keeps the key", () => {
    fresh();
    const pub = run(["init"]).stdout;
    const t1 = run(["export-client-token"]).stdout;
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(run(["rotate-token"]).status).toBe(0);
    const t2 = run(["export-client-token"]).stdout;
    expect(t2).toMatch(/^[0-9a-f]{64}$/);
    expect(t2).not.toBe(t1);
    expect(run(["public-key"]).stdout).toBe(pub);
    expect(statSync(join(home, "keys/client-token")).mode & 0o777).toBe(0o600);
  });

  it("refuses a key or token file with loose permissions, and an uninitialized home (exit 3)", () => {
    fresh();
    expect(run(["export-client-token"]).status).toBe(3);
    run(["init"]);
    chmodSync(join(home, "keys/client-token"), 0o644);
    const r = run(["export-client-token"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mode 600/);
    expect(r.stdout).toBe("");
  });

  it.each([
    ["no repository", { SIGNER_ISSUER_PUBLIC_KEY: "x" }, /SIGNER_REPOSITORY/],
    ["no issuer key", { SIGNER_REPOSITORY: "o/r" }, /SIGNER_ISSUER_PUBLIC_KEY/],
    ["a non-Ed25519 issuer key", { SIGNER_REPOSITORY: "o/r", SIGNER_ISSUER_PUBLIC_KEY: "not-a-key" }, /not an Ed25519 public key/],
    ["a bad port", { SIGNER_REPOSITORY: "o/r", SIGNER_ISSUER_PUBLIC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", SIGNER_PORT: "http" }, /SIGNER_PORT/],
  ])("serve refuses to start with %s", (_n, env, msg) => {
    fresh();
    run(["init"]);
    const r = run(["serve"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(msg);
  });

  it("refuses an unknown command (exit 2)", () => {
    fresh();
    expect(run(["sign-anything"]).status).toBe(2);
  });

  it("a failed init leaves no half-initialized key behind", () => {
    fresh();
    // A directory where the token file belongs makes the second write fail.
    mkdirSync(join(home, "keys", "client-token"), { recursive: true });
    const r = run(["init"]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(home, "keys", "signing-key.pem"))).toBe(false);
  });
});
