import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";

// Windows equivalent of the POSIX "owner-only key file" rule. Mode bits mean nothing on NTFS, so
// the file's access control list is read and judged instead. Every failure is a refusal: an ACL
// that cannot be read or parsed is treated as open. SIDs are used, never account names, so the
// result does not depend on the Windows display language.

export interface WindowsAce {
  readonly sid: string;
  readonly allow: boolean;
  readonly rights: number;
  /** Applies only to children, so it says nothing about this file or directory itself. */
  readonly inheritOnly: boolean;
}
export interface WindowsAcl {
  readonly owner: string;
  readonly user: string;
  readonly aces: readonly WindowsAce[];
}

const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";

/** WriteData, AppendData, WriteExtendedAttributes, DeleteSubdirectoriesAndFiles, WriteAttributes, Delete, ChangePermissions, TakeOwnership, GenericAll, GenericWrite. */
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

const REMEDY = "see docs/windows.md (icacls)";

/**
 * Why this ACL does not meet the rule, or null when it does. A key file may be reachable only by
 * the current user, SYSTEM and Administrators (the two accounts that can read any file anyway).
 * A key's directory only has to stop anyone else replacing the key; reading it is allowed, as on
 * POSIX, where a 0755 parent is accepted.
 */
export function assessWindowsAcl(acl: WindowsAcl, kind: "file" | "directory"): string | null {
  const trusted = new Set([acl.user, SYSTEM, ADMINISTRATORS]);
  if (!trusted.has(acl.owner)) return `${kind} is owned by another account (${acl.owner}); ${REMEDY}`;
  for (const ace of acl.aces) {
    if (!ace.allow || ace.inheritOnly || trusted.has(ace.sid)) continue;
    if (kind === "file") return `file must be accessible only to you (${ace.sid} has access); ${REMEDY}`;
    if ((ace.rights & WRITE_RIGHTS) !== 0) return `directory must not be writable by anyone else (${ace.sid} can write); ${REMEDY}`;
  }
  return null;
}

// Reads the ACL of $env:LOOPBACK_ACL_PATH: the path travels in the environment, so it can never
// be interpreted as PowerShell code, whatever characters it holds. Uses .NET FileSystemSecurity
// directly rather than Get-Acl, avoiding module autoloading issues (e.g. CoreCLR PSModulePath).
const READ_ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$t=[System.Security.Principal.SecurityIdentifier]",
  "$p=$env:LOOPBACK_ACL_PATH",
  "$a=if([System.IO.Directory]::Exists($p)){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)}",
  "$o=$a.GetOwner($t)",
  "$owner=if($o){$o.Value}else{''}",
  "$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$user=if($u){$u.Value}else{''}",
  "$r=@($a.GetAccessRules($true,$true,$t)|ForEach-Object{if($_.IdentityReference){@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');rights=$_.FileSystemRights.value__;inheritOnly=(($_.PropagationFlags -band 2) -ne 0)}}})",
  "@{owner=$owner;user=$user;aces=$r}|ConvertTo-Json -Compress -Depth 4",
].join(";");

function parseAcl(text: string): WindowsAcl {
  const raw = JSON.parse(text) as { owner?: unknown; user?: unknown; aces?: unknown };
  if (typeof raw.owner !== "string" || typeof raw.user !== "string") throw new Error("unexpected ACL output");
  const list: unknown[] = Array.isArray(raw.aces) ? (raw.aces as unknown[]) : raw.aces === null || raw.aces === undefined ? [] : [raw.aces];
  const aces = list.map((item) => {
    const a = item as { sid?: unknown; allow?: unknown; rights?: unknown; inheritOnly?: unknown };
    if (typeof a.sid !== "string" || typeof a.allow !== "boolean" || typeof a.rights !== "number" || typeof a.inheritOnly !== "boolean") throw new Error("unexpected ACL output");
    return { sid: a.sid, allow: a.allow, rights: a.rights, inheritOnly: a.inheritOnly };
  });
  return { owner: raw.owner, user: raw.user, aces };
}

/** Read a path's ACL. The absolute PowerShell path avoids running whatever PATH finds first. */
export function readWindowsAcl(path: string): WindowsAcl {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemDrive = process.env.SystemDrive ?? process.env.SYSTEMDRIVE ?? systemRoot.slice(0, 2);
  const windir = process.env.windir ?? process.env.WINDIR ?? systemRoot;
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const winModules = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  const psModulePath = process.env.PSModulePath ? `${winModules};${process.env.PSModulePath}` : winModules;
  const fullPath = resolve(path).replace(/\//g, "\\");
  const out = execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", READ_ACL_SCRIPT],
    {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        SystemDrive: systemDrive,
        windir: windir,
        ...process.env,
        SystemRoot: systemRoot,
        PSModulePath: psModulePath,
        LOOPBACK_ACL_PATH: fullPath,
      },
    },
  );
  return parseAcl(out);
}

/** The cloud-synced folder holding this path, if any: a key or database there leaves the machine. */
export function cloudSyncRoot(path: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const target = resolve(path).toLowerCase();
  for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const root = env[name];
    if (!root) continue;
    const prefix = resolve(root).toLowerCase();
    if (target === prefix || target.startsWith(prefix + sep)) return root;
  }
  return null;
}

/** Host-specific permission rules for a key file; each returns the problem, or null. */
export interface HostPermissions {
  file(path: string): string | null;
  directory(path: string): string | null;
}

export function windowsPermissions(read: (path: string) => WindowsAcl = readWindowsAcl, env: Readonly<Record<string, string | undefined>> = process.env): HostPermissions {
  const judge = (path: string, kind: "file" | "directory"): string | null => {
    let acl: WindowsAcl;
    try {
      acl = read(path);
    } catch {
      return `${kind} permissions could not be read; treating it as open`;
    }
    return assessWindowsAcl(acl, kind);
  };
  return {
    file(path) {
      if (cloudSyncRoot(path, env) !== null) return "key file is in a cloud-synced folder (OneDrive), so it would leave this machine; move it (docs/windows.md)";
      return judge(path, "file");
    },
    directory: (path) => judge(path, "directory"),
  };
}
