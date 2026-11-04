import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** Remove inherited access and leave a Windows file reachable by the current user alone. */
export function lockToCurrentUser(path: string): void {
  const csv = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = /S-1-[0-9-]+/.exec(csv)?.[0];
  if (sid === undefined) throw new Error("could not read the current user's SID");
  execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore" });
}

/** A key file the gate's real permission check accepts, on any platform. */
export function writePrivateKey(path: string, content = "not a real key: GitHub is faked in this test"): void {
  writeFileSync(path, content, { mode: 0o600 });
  if (process.platform === "win32") lockToCurrentUser(path);
}
