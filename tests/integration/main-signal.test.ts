import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writePrivateKey } from "../helpers/private-key.js";

const ON_WINDOWS = process.platform === "win32";

// Step 9.7 with real OS signals: the built entry point (dist/main.js, exactly what
// `npm run gate` runs) against a local fake of Switch's HTTP API. GitHub is never contacted
// (empty database). The Switch WebSocket is refused by the fake, so the gate keeps retrying
// in the background, which is fine: the test is about signals, not the transport.
//
// Windows has no kill(2): `child.kill()` terminates the process outright. The real delivery there
// is a console control event, so the child gets its own hidden console and a helper sends the
// event into it (what pressing Ctrl+C or Ctrl+Break does).

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const USER = "2a8934be-9a66-4944-a410-456e9e23b98c";
const AGENT_POLICY = "11111111-2222-4333-8444-555555555555";
const MROOM = "8aeb4229-d129-47c8-93d6-ec4f37d623e3";
const IROOM = "99999999-2222-4333-8444-555555555555";

/** A port the OS reports free right now (avoids collisions between parallel test files). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  await new Promise<void>((r) => srv.close(() => r()));
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  return addr.port;
}

let dir = "";
let fakeSwitch: Server;
let switchPort = 0;

beforeAll(async () => {
  execFileSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-b"], { stdio: "ignore" });
  dir = mkdtempSync(join(tmpdir(), "loopback-main-"));
  writePrivateKey(join(dir, "gate.pem"));
  fakeSwitch = createServer((req, res) => {
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url?.endsWith("/ops/get_agent_detail")) return send({ result: { id: AGENT, addressing_policy: { rules: [
      { rooms: [MROOM], room_groups: "*", users: [USER], agents: [AGENT_POLICY], owner: false, owner_agents: false, platform: false },
      { rooms: [IROOM], room_groups: "*", users: "*", agents: [], owner: false, owner_agents: false, platform: false },
    ] } } });
    if (req.url?.endsWith("/ops")) return send({ operations: { post_message: {}, read_context: {} } });
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fakeSwitch.listen(0, "127.0.0.1", r));
  const addr = fakeSwitch.address();
  switchPort = typeof addr === "object" && addr !== null ? addr.port : 0;
}, 60_000);
afterAll(() => {
  fakeSwitch.close();
  rmSync(dir, { recursive: true, force: true });
});

function launch(name: string, port: number): { child: ChildProcess; port: number; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [join(process.cwd(), "apps", "switch-gate", "dist", "main.js")], {
    stdio: "ignore",
    windowsHide: true, // on Windows: its own hidden console, which the control event targets
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "",
      LOG_LEVEL: "fatal",
      ...(ON_WINDOWS ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
      SWITCH_BRIDGE_URL: `http://127.0.0.1:${switchPort}`,
      SWITCH_AGENT_ID: AGENT,
      SWITCH_AGENT_API_KEY: "test-key",
      SWITCH_ROOM_ID: MROOM,
      SWITCH_INTAKE_ROOM_ID: IROOM,
      SWITCH_SELF_ID: "@switch-agent-gate:loopback",
      SWITCH_POLICY_USER_IDS: USER,
      SWITCH_POLICY_AGENT_IDS: AGENT_POLICY,
      LOOPBACK_MAINTAINERS: "@switch-user-a1:loopback",
      LOOPBACK_REPORTERS: "@switch-user-a1:loopback",
      LOOPBACK_FIXER_ID: "@switch-agent-fixer:loopback",
      LOOPBACK_VERIFIER_ID: "@switch-agent-verifier:loopback",
      GH_REPO: "o/r",
      GH_APP_ID: "123",
      GH_APP_INSTALLATION_ID: "456",
      GH_APP_PRIVATE_KEY_PATH: join(dir, "gate.pem"),
      BASE_BRANCH: "main",
      REQUIRED_CHECKS: "test",
      CHECK_SOURCES: "test:github-actions",
      REQUIRED_CHECK_INTEGRATIONS: "test:15368",
      DB_PATH: join(dir, `${name}.db`),
      HTTP_PORT: String(port),
      POLL_INTERVAL_MS: "60000",
    },
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, port, exited };
}

async function waitHealthy(port: number, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200) return;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error("the gate did not become healthy");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Send a console control event into the console of `pid`, as a key press there would. */
function consoleEvent(pid: number, event: "CTRL_C" | "CTRL_BREAK"): void {
  const script = `
$sig = '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'
$k = Add-Type -MemberDefinition $sig -Name K -Namespace Loopback -PassThru
[void]$k::FreeConsole()
if (-not $k::AttachConsole(${String(pid)})) { exit 3 }
[void]$k::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
if (-not $k::GenerateConsoleCtrlEvent(${event === "CTRL_C" ? "0" : "1"}, 0)) { exit 4 }
Start-Sleep -Milliseconds 300
[void]$k::FreeConsole()
exit 0`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // A Ctrl+Break can also end this helper, because it shares the console: that exit is expected,
  // and the assertion is on what the gate does.
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true, timeout: 20_000 });
  } catch { /* judged by the gate's exit code */ }
}

describe.skipIf(ON_WINDOWS)("main.js under real OS signals (step 9.7)", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("exits 0 on %s after full startup, also when the signal is repeated", async (signal) => {
    const g = launch(signal, await freePort());
    await waitHealthy(g.port);
    g.child.kill(signal);
    g.child.kill(signal);
    expect(await g.exited).toBe(0);
  }, 30_000);
});

describe.runIf(ON_WINDOWS)("main.js under real Windows console events", () => {
  it.each(["CTRL_C", "CTRL_BREAK"] as const)("exits 0 on %s after full startup", async (event) => {
    const g = launch(event, await freePort());
    await waitHealthy(g.port);
    consoleEvent(g.child.pid ?? 0, event);
    const code = await Promise.race([g.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 20_000))]);
    if (code === "still running") g.child.kill();
    expect(code).toBe(0);
  }, 60_000);
});
