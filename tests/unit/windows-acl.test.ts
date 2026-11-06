import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPrivateKeyFile, ConfigError, loadRuntimeConfig } from "../../apps/switch-gate/src/config.js";
import { assessWindowsAcl, cloudSyncRoot, readWindowsAcl, windowsPermissions, type WindowsAcl } from "../../apps/switch-gate/src/platform/windows-acl.js";
import { system32, writePrivateKey } from "../helpers/private-key.js";

// The Windows form of "only the owner can reach the key". The rules are pure and tested on every
// platform; the last block runs against real NTFS ACLs on Windows.

const ME = "S-1-5-21-1-2-3-1001";
const OTHER = "S-1-5-21-1-2-3-1002";
const EVERYONE = "S-1-1-0";
const USERS = "S-1-5-32-545";
const SYSTEM = "S-1-5-18";
const ADMINS = "S-1-5-32-544";
const READ = 0x120089;
const FULL = 0x1f01ff;
const WRITE_DATA = 0x2;

const ace = (sid: string, rights = READ, allow = true, inheritOnly = false) => ({ sid, rights, allow, inheritOnly });
const acl = (aces: WindowsAcl["aces"], owner = ME): WindowsAcl => ({ owner, user: ME, aces });

describe("assessWindowsAcl", () => {
  it("accepts a file reachable only by you, SYSTEM and Administrators", () => {
    expect(assessWindowsAcl(acl([ace(ME, FULL), ace(SYSTEM, FULL), ace(ADMINS, FULL)]), "file")).toBeNull();
  });

  it.each([[EVERYONE], [USERS], [OTHER]])("refuses a file %s can read", (sid) => {
    expect(assessWindowsAcl(acl([ace(ME, FULL), ace(sid)]), "file")).toMatch(new RegExp(`only to you \\(${sid} has access`));
  });

  it("refuses a file owned by someone else, even with a clean list", () => {
    expect(assessWindowsAcl(acl([ace(ME, FULL)], OTHER), "file")).toMatch(/owned by another account/);
  });

  it("a deny entry does not excuse an allow entry, and inherit-only entries say nothing about the file", () => {
    expect(assessWindowsAcl(acl([ace(OTHER, READ, false), ace(OTHER)]), "file")).toMatch(/has access/);
    expect(assessWindowsAcl(acl([ace(OTHER, READ, false)]), "file")).toBeNull();
    expect(assessWindowsAcl(acl([ace(OTHER, FULL, true, true)]), "file")).toBeNull();
  });

  it("lets others read a key's directory but not change it", () => {
    expect(assessWindowsAcl(acl([ace(ME, FULL), ace(USERS, READ)]), "directory")).toBeNull();
    for (const rights of [FULL, WRITE_DATA, 0x4, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000]) {
      expect(assessWindowsAcl(acl([ace(USERS, rights)]), "directory"), rights.toString(16)).toMatch(/must not be writable/);
    }
  });
});

describe("cloudSyncRoot", () => {
  const root = join(tmpdir(), "OneDrive - Contoso");
  it("finds a path inside a synced folder, whatever its case", () => {
    expect(cloudSyncRoot(join(root, "secrets", "gate.pem"), { OneDriveCommercial: root })).toBe(root);
    expect(cloudSyncRoot(join(root, "x").toUpperCase(), { OneDrive: root.toUpperCase() })).toBe(root.toUpperCase());
  });
  it("is not fooled by a folder that merely starts with the same name", () => {
    expect(cloudSyncRoot(`${root}-backup/gate.pem`, { OneDrive: root })).toBeNull();
    expect(cloudSyncRoot(join(tmpdir(), "gate.pem"), {})).toBeNull();
  });
});

describe("windowsPermissions", () => {
  it("treats an unreadable ACL as open", () => {
    const host = windowsPermissions(() => { throw new Error("powershell failed"); }, {});
    expect(host.file("k")).toMatch(/could not be read/);
    expect(host.directory("d")).toMatch(/could not be read/);
  });

  it("refuses a key in a synced folder without even reading its ACL", () => {
    const root = join(tmpdir(), "OneDrive");
    const host = windowsPermissions(() => { throw new Error("must not be called"); }, { OneDrive: root });
    expect(host.file(join(root, "gate.pem"))).toMatch(/cloud-synced/);
  });
});

describe("assertPrivateKeyFile with host permissions", () => {
  const file = () => ({ mode: 0o100666, isFile: () => true });
  const refused = (fn: () => void) => {
    try { fn(); } catch (e) { return e instanceof ConfigError ? e.message : "other"; }
    return "accepted";
  };

  it("uses the host's verdict, not mode bits", () => {
    expect(refused(() => assertPrivateKeyFile("k", file, "V", "G", { file: () => null, directory: () => null }))).toBe("accepted");
    expect(refused(() => assertPrivateKeyFile("k", file, "V", "G", { file: () => "file is open", directory: () => null }))).toMatch(/V.*file is open/s);
    expect(refused(() => assertPrivateKeyFile("k", file, "V", "G", { file: () => null, directory: () => "directory is open" }))).toMatch(/V.*directory is open/s);
  });

  it("still requires a regular file and a readable directory", () => {
    const host = { file: () => null, directory: () => null };
    expect(refused(() => assertPrivateKeyFile("k", () => ({ mode: 0, isFile: () => false }), "V", "G", host))).toMatch(/not a regular file/);
    const noDir = (p: string) => { if (p === ".") throw new Error("gone"); return file(); };
    expect(refused(() => assertPrivateKeyFile("k", noDir, "V", "G", host))).toMatch(/directory not found/);
  });
});

describe("DB_PATH", () => {
  const root = join(tmpdir(), "OneDrive");
  it("refuses a database in a synced folder", () => {
    expect(() => loadRuntimeConfig({ OneDrive: root, DB_PATH: join(root, "loopback.db") })).toThrow(/cloud-synced/);
  });
  it("accepts one elsewhere, and :memory:", () => {
    expect(loadRuntimeConfig({ OneDrive: root, DB_PATH: join(tmpdir(), "loopback.db") }).dbPath).toContain("loopback.db");
    expect(loadRuntimeConfig({ OneDrive: process.cwd(), DB_PATH: ":memory:" }).dbPath).toBe(":memory:");
  });
});

describe.runIf(process.platform === "win32")("real NTFS ACLs", () => {
  let dir = "";
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), "loopback-acl-"));
    const key = join(dir, "gate key.pem"); // a space, to prove the path is passed safely
    writePrivateKey(key);
    return key;
  };
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads the current user as the owner of a new file", () => {
    const acl = readWindowsAcl(fresh());
    expect(acl.user).toMatch(/^S-1-5-/);
    expect(acl.aces.some((a) => a.sid === acl.user && a.allow)).toBe(true);
  });

  it("a key locked with icacls passes the real check", () => {
    expect(() => assertPrivateKeyFile(fresh())).not.toThrow();
  });

  it("granting Everyone read access makes the real check refuse the key", () => {
    const key = fresh();
    execFileSync(system32("icacls.exe"), [key, "/grant", "*S-1-1-0:R"], { stdio: "ignore" });
    expect(() => assertPrivateKeyFile(key)).toThrow(/S-1-1-0 has access/);
  });

  it("a file still inheriting from a folder another account can read is refused", () => {
    dir = mkdtempSync(join(tmpdir(), "loopback-acl-"));
    execFileSync(system32("icacls.exe"), [dir, "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdio: "ignore" });
    const key = join(dir, "gate.pem");
    writeFileSync(key, "not a real key");
    expect(() => assertPrivateKeyFile(key)).toThrow(/S-1-1-0 has access/);
  });

  it("granting Everyone write access to the directory makes the real check refuse the key", () => {
    const key = fresh();
    execFileSync(system32("icacls.exe"), [dir, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
    expect(() => assertPrivateKeyFile(key)).toThrow(/S-1-1-0 can write/);
  });

  it("a path that does not exist is refused, never treated as private", () => {
    expect(() => assertPrivateKeyFile(join(tmpdir(), "loopback-no-such-key.pem"))).toThrow(/file not found/);
    expect(windowsPermissions().file(join(tmpdir(), "loopback-no-such-key.pem"))).toMatch(/could not be read/);
  });
});
