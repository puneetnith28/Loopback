import { describe, expect, it } from "vitest";
import {
  EGRESS_NETWORK, NO_ROUTE, NOT_REACHABLE_BY_NAME, PROXY_URL, ROLES, assessContainer, assessDaemon, assessProxy, assessSeparation, assessVolumes,
  connectAsExpected, parseProcStatus, proxyExpectations, rootIsReadOnly,
  type CheckResult,
} from "../../scripts/verify-isolation.mjs";

// D28 / step 6.4: the container-runtime isolation checks must pass only for the hardened layout
// that deploy/isolation/agents.sh creates, and fail for every single weakening of it.

type Role = "fixer" | "verifier";
const failures = (rs: CheckResult[]) => rs.filter((r) => r.level === "fail").map((r) => r.text);

const hardenedHostConfig = (networkMode: string) => ({
  Privileged: false, CapDrop: ["ALL"], CapAdd: null as string[] | null, SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true,
  Devices: [] as unknown[], DeviceRequests: null, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
  NetworkMode: networkMode, PidsLimit: 512, Memory: 4294967296, PortBindings: {} as Record<string, unknown>, PublishAllPorts: false,
  VolumesFrom: null as string[] | null, ExtraHosts: null as string[] | null, Sysctls: undefined as Record<string, string> | undefined,
  GroupAdd: null as string[] | null, Links: null, Runtime: "runc",
});

/** A container as `docker inspect` reports it for the hardened layout. */
function hardened(role: Role) {
  const spec = ROLES[role];
  return {
    State: { Running: true },
    Config: { User: `${spec.uid}:${spec.uid}`, Env: [`LOOPBACK_AGENT_ROLE=${role}`, `HTTPS_PROXY=${PROXY_URL}`, "GH_TOKEN=x", "PATH=/usr/bin"] },
    HostConfig: hardenedHostConfig(spec.network),
    Mounts: [{ Type: "volume", Name: spec.volume, Driver: "local", Source: `/data/volumes/${spec.volume}/_data`, Destination: spec.home }],
    NetworkSettings: { Networks: { [spec.network]: {} } as Record<string, unknown> },
  };
}
const networkOf = (role: Role) => ({ Internal: true, Containers: { a: { Name: ROLES[role].container }, b: { Name: ROLES[role].proxy } } });
/** A role's proxy as `docker inspect` reports it. */
function proxyOf(role: Role) {
  return {
    State: { Running: true },
    Config: { User: "proxy", Env: [`LOOPBACK_PROXY_ROLE=${role}`, "LOOPBACK_FIXER_REGISTRY=0"] },
    HostConfig: { ...hardenedHostConfig(ROLES[role].network), PidsLimit: 256, Memory: 268435456 },
    Mounts: [{ Type: "tmpfs", Destination: "/tmp" }],
    NetworkSettings: { Networks: { [ROLES[role].network]: {}, [EGRESS_NETWORK]: {} } as Record<string, unknown> },
  };
}

describe("assessDaemon", () => {
  const SOCK = "/run/user/1000/loopback-docker/docker.sock";
  const info = { SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"], DockerRootDir: "/home/u/.local/share/loopback-docker" };
  it("passes for the per-user rootless daemon", () => {
    expect(failures(assessDaemon(info, `unix://${SOCK}`, SOCK))).toEqual([]);
    expect(failures(assessDaemon(info, `unix:///run/user/1000//loopback-docker/docker.sock`, SOCK))).toEqual([]);
  });
  it.each([
    ["the rootful socket", info, "unix:///var/run/docker.sock", /not a per-user unix socket/],
    ["DOCKER_HOST unset", info, undefined, /unset/],
    ["a TCP daemon", info, "tcp://10.0.0.5:2375", /not a per-user unix socket/],
    ["another per-user daemon", info, "unix:///run/user/1000/docker.sock", /not the Loopback daemon socket/],
    ["the rootful socket written with a double slash", info, "unix:///var/run//docker.sock", /not a per-user unix socket/],
    ["a rootful daemon", { ...info, SecurityOptions: ["name=seccomp"] }, "unix:///run/user/1000/x.sock", /not rootless/],
    ["no seccomp", { ...info, SecurityOptions: ["name=rootless"] }, "unix:///run/user/1000/x.sock", /no seccomp/],
    ["the system data root", { ...info, DockerRootDir: "/var/lib/docker" }, "unix:///run/user/1000/x.sock", /system Docker/],
  ])("fails for %s", (_name, i, host, pattern) => {
    expect(failures(assessDaemon(i, host, SOCK)).join("\n")).toMatch(pattern);
  });
});

describe("assessContainer", () => {
  it.each(["fixer", "verifier"] as const)("passes for the hardened %s", (role) => {
    expect(failures(assessContainer(role, hardened(role), networkOf(role)))).toEqual([]);
  });

  type C = ReturnType<typeof hardened>;
  const weakenings: [string, (c: C) => C, RegExp][] = [
    ["stopped", (c) => ({ ...c, State: { Running: false } }), /not running/],
    ["running as root", (c) => ({ ...c, Config: { ...c.Config, User: "" } }), /root \(unset\)/],
    ["the other role's uid", (c) => ({ ...c, Config: { ...c.Config, User: "10002:10002" } }), /user is 10002:10002/],
    ["privileged", (c) => ({ ...c, HostConfig: { ...c.HostConfig, Privileged: true } }), /is privileged/],
    ["a capability added back", (c) => ({ ...c, HostConfig: { ...c.HostConfig, CapAdd: ["NET_RAW"] } }), /capabilities not fully dropped/],
    ["capabilities kept", (c) => ({ ...c, HostConfig: { ...c.HostConfig, CapDrop: [] } }), /capabilities not fully dropped/],
    ["no-new-privileges missing", (c) => ({ ...c, HostConfig: { ...c.HostConfig, SecurityOpt: [] } }), /no-new-privileges not set/],
    ["seccomp unconfined", (c) => ({ ...c, HostConfig: { ...c.HostConfig, SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] } }), /unconfined/],
    ["AppArmor unconfined", (c) => ({ ...c, HostConfig: { ...c.HostConfig, SecurityOpt: ["no-new-privileges", "apparmor:unconfined"] } }), /unconfined/],
    ["a non-local volume driver", (c) => ({ ...c, Mounts: c.Mounts.map((m) => ({ ...m, Driver: "sshfs" })) }), /non-local driver/],
    ["a published port", (c) => ({ ...c, HostConfig: { ...c.HostConfig, PortBindings: { "22/tcp": [{ HostPort: "2222" }] } } }), /publishes ports/],
    ["volumes-from", (c) => ({ ...c, HostConfig: { ...c.HostConfig, VolumesFrom: ["loopback-verifier"] } }), /volumes-from/],
    ["extra hosts", (c) => ({ ...c, HostConfig: { ...c.HostConfig, ExtraHosts: ["host.docker.internal:host-gateway"] } }), /extra hosts/],
    ["sysctls", (c) => ({ ...c, HostConfig: { ...c.HostConfig, Sysctls: { "net.ipv4.ip_forward": "1" } } }), /sysctls/],
    ["extra groups", (c) => ({ ...c, HostConfig: { ...c.HostConfig, GroupAdd: ["10002"] } }), /extra groups/],
    ["another runtime", (c) => ({ ...c, HostConfig: { ...c.HostConfig, Runtime: "runsc-debug" } }), /runtime is runsc-debug/],
    ["the host cgroup namespace", (c) => ({ ...c, HostConfig: { ...c.HostConfig, CgroupnsMode: "host" } }), /host namespace/],
    ["a writable root", (c) => ({ ...c, HostConfig: { ...c.HostConfig, ReadonlyRootfs: false } }), /root filesystem is writable/],
    ["a host bind mount", (c) => ({ ...c, Mounts: [...c.Mounts, { Type: "bind", Name: "", Driver: "", Source: "/home/u", Destination: "/host" }] }), /bind mount: \/host/],
    ["the Docker socket", (c) => ({ ...c, Mounts: [...c.Mounts, { Type: "volume", Name: "s", Driver: "local", Source: "/run/docker.sock", Destination: "/run/docker.sock" }] }), /Docker socket is mounted/],
    ["a shared home volume", (c) => ({ ...c, Mounts: c.Mounts.map((m) => ({ ...m, Name: "shared-home" })) }), /home is not the volume/],
    ["a host device", (c) => ({ ...c, HostConfig: { ...c.HostConfig, Devices: [{ PathOnHost: "/dev/kvm" }] } }), /host devices/],
    ["the host PID namespace", (c) => ({ ...c, HostConfig: { ...c.HostConfig, PidMode: "host" } }), /host namespace/],
    ["host networking", (c) => ({ ...c, HostConfig: { ...c.HostConfig, NetworkMode: "host" } }), /host namespace/],
    ["a second network", (c) => ({ ...c, NetworkSettings: { Networks: { ...c.NetworkSettings.Networks, bridge: {} } } }), /networks are \[/],
    ["no pids limit", (c) => ({ ...c, HostConfig: { ...c.HostConfig, PidsLimit: 0 } }), /pids or memory limit missing/],
    ["no memory limit", (c) => ({ ...c, HostConfig: { ...c.HostConfig, Memory: 0 } }), /pids or memory limit missing/],
    ["GITHUB_TOKEN set", (c) => ({ ...c, Config: { ...c.Config, Env: [...c.Config.Env, "GITHUB_TOKEN=x"] } }), /GITHUB_TOKEN is set/],
    ["a bare GITHUB_TOKEN", (c) => ({ ...c, Config: { ...c.Config, Env: [...c.Config.Env, "GITHUB_TOKEN"] } }), /GITHUB_TOKEN is set/],
    ["the role marker missing", (c) => ({ ...c, Config: { ...c.Config, Env: c.Config.Env.filter((e) => !e.startsWith("LOOPBACK_AGENT_ROLE=")) } }), /LOOPBACK_AGENT_ROLE is not/],
    ["another proxy", (c) => ({ ...c, Config: { ...c.Config, Env: c.Config.Env.map((e) => e.replace(/:\d+$/, ":9999")) } }), /HTTPS_PROXY is not/],
  ];
  it.each(weakenings)("fails when %s", (_name, weaken, pattern) => {
    expect(failures(assessContainer("fixer", weaken(hardened("fixer")), networkOf("fixer"))).join("\n")).toMatch(pattern);
  });

  it("fails when its network routes out", () => {
    expect(failures(assessContainer("fixer", hardened("fixer"), { ...networkOf("fixer"), Internal: false })).join("\n")).toMatch(/is not internal/);
  });
  it("fails when another container shares its network", () => {
    const net = { Internal: true, Containers: { ...networkOf("fixer").Containers, c: { Name: "loopback-proxy-verifier" } } };
    expect(failures(assessContainer("fixer", hardened("fixer"), net)).join("\n")).toMatch(/members are \[/);
  });
  it("fails closed on missing inspect data", () => {
    expect(failures(assessContainer("verifier", undefined, undefined)).length).toBeGreaterThan(10);
  });
});

describe("assessProxy", () => {
  it.each(["fixer", "verifier"] as const)("passes for the hardened %s proxy", (role) => {
    expect(failures(assessProxy(role, proxyOf(role)))).toEqual([]);
  });
  type P = ReturnType<typeof proxyOf>;
  const weakenings: [string, (p: P) => P, RegExp][] = [
    ["running as root", (p) => ({ ...p, Config: { ...p.Config, User: "" } }), /runs as root/],
    ["running as uid 0", (p) => ({ ...p, Config: { ...p.Config, User: "0:0" } }), /runs as root/],
    ["privileged", (p) => ({ ...p, HostConfig: { ...p.HostConfig, Privileged: true } }), /is privileged/],
    ["a bind mount", (p) => ({ ...p, Mounts: [...p.Mounts, { Type: "bind", Destination: "/etc/loopback-proxy" }] }), /bind mount/],
    ["on the other role's network too", (p) => ({ ...p, NetworkSettings: { Networks: { ...p.NetworkSettings.Networks, "loopback-verifier-net": {} } } }), /networks are \[/],
    ["not on the egress network", (p) => ({ ...p, NetworkSettings: { Networks: { "loopback-fixer-net": {} } } }), /networks are \[/],
    ["serving the other role's policy", (p) => ({ ...p, Config: { ...p.Config, Env: ["LOOPBACK_PROXY_ROLE=verifier"] } }), /not configured for fixer/],
  ];
  it.each(weakenings)("fails when %s", (_name, weaken, pattern) => {
    expect(failures(assessProxy("fixer", weaken(proxyOf("fixer")))).join("\n")).toMatch(pattern);
  });
  it("fails when the verifier's proxy has registry access", () => {
    const p = proxyOf("verifier");
    expect(failures(assessProxy("verifier", { ...p, Config: { ...p.Config, Env: ["LOOPBACK_PROXY_ROLE=verifier", "LOOPBACK_FIXER_REGISTRY=1"] } })).join("\n")).toMatch(/registry access enabled/);
  });
  it("fails closed when the proxy is missing", () => {
    expect(failures(assessProxy("verifier", undefined)).length).toBeGreaterThan(5);
  });
});

describe("assessVolumes", () => {
  it("passes for plain local volumes and fails for a local volume with bind options or another driver", () => {
    expect(failures(assessVolumes([{ Name: "loopback-fixer-home", Driver: "local", Options: null }]))).toEqual([]);
    expect(failures(assessVolumes([{ Name: "v", Driver: "local", Options: { type: "none", o: "bind", device: "/home/u" } }])).join()).toMatch(/possible host bind/);
    expect(failures(assessVolumes([{ Name: "v", Driver: "nfs", Options: {} }])).join()).toMatch(/driver nfs/);
  });
});

describe("assessSeparation", () => {
  it("passes for the two hardened containers", () => {
    expect(failures(assessSeparation(hardened("fixer"), hardened("verifier")))).toEqual([]);
  });
  it("fails when they share a uid, a volume or a network", () => {
    const f0 = hardened("fixer");
    const same = { ...hardened("verifier"), Config: { ...hardened("verifier").Config, User: f0.Config.User }, Mounts: f0.Mounts, NetworkSettings: f0.NetworkSettings };
    const f = failures(assessSeparation(f0, same)).join("\n");
    expect(f).toMatch(/same uid/);
    expect(f).toMatch(/share volume\(s\): loopback-fixer-home/);
    expect(f).toMatch(/share network\(s\): loopback-fixer-net/);
  });
});

describe("in-container parsers", () => {
  it("reads CapEff and NoNewPrivs", () => {
    expect(parseProcStatus("Name:\tnode\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n")).toEqual({ capEff: 0n, noNewPrivs: true });
    expect(parseProcStatus("CapEff:\t00000000a80425fb\nNoNewPrivs:\t0\n")).toEqual({ capEff: 0xa80425fbn, noNewPrivs: false });
    expect(parseProcStatus("")).toEqual({ capEff: null, noNewPrivs: false });
  });
  it("detects a read-only root from mountinfo", () => {
    const ro = "1288 1200 0:88 / / ro,relatime master:1 - overlay overlay rw,lowerdir=x\n1289 1288 0:90 / /proc rw,nosuid - proc proc rw\n";
    expect(rootIsReadOnly(ro)).toBe(true);
    expect(rootIsReadOnly(ro.replace("/ / ro,relatime", "/ / rw,relatime"))).toBe(false);
    expect(rootIsReadOnly("")).toBe(false);
  });
});

describe("probe outcomes fail closed", () => {
  it("only 'no route' proves a direct block; a refusal, reset or timeout does not", () => {
    expect(NO_ROUTE).toEqual(["ENETUNREACH", "EHOSTUNREACH"]);
    for (const o of ["connected", "ECONNREFUSED", "ECONNRESET", "timeout", "error"]) expect(NO_ROUTE.includes(o)).toBe(false);
    for (const o of ["ENOTFOUND", "EAI_AGAIN"]) expect(NOT_REACHABLE_BY_NAME.includes(o)).toBe(true);
    expect(NOT_REACHABLE_BY_NAME.includes("ECONNREFUSED")).toBe(false);
  });
  it("a refusal must be the proxy's deliberate 403; an upstream failure or timeout is not a refusal", () => {
    expect(connectAsExpected(403, false)).toBe(true);
    for (const s of [200, 407, 502, 503, 504, "timeout", "ECONNRESET"]) expect(connectAsExpected(s, false)).toBe(false);
    expect(connectAsExpected(200, true)).toBe(true);
    expect(connectAsExpected(403, true)).toBe(false);
  });
});

describe("proxyExpectations", () => {
  it("probes a unique unlisted name, IP literals, near-miss GitHub names and the other agent", () => {
    const hosts = proxyExpectations("fixer", "abc123").filter((x) => x.allowed === false).map((x) => x.host);
    expect(hosts).toEqual(expect.arrayContaining(["lb-abc123.example.org", "140.82.112.3", "[::1]", "gist.github.com", "evil.api.github.com", "loopback-verifier"]));
  });
  it("allows GitHub and the model provider for both roles and refuses everything else, including the other agent", () => {
    for (const role of ["fixer", "verifier"] as const) {
      const e = proxyExpectations(role);
      expect(e.filter((x) => x.allowed === true).map((x) => x.host).sort()).toEqual(["api.anthropic.com", "api.github.com", "github.com"]);
      expect(e.some((x) => x.host === "169.254.169.254" && x.allowed === false)).toBe(true);
      expect(e.some((x) => x.host === ROLES[role === "fixer" ? "verifier" : "fixer"].container && x.allowed === false)).toBe(true);
    }
  });
  it("refuses the registry to the verifier and leaves the fixer's to the owner's toggle", () => {
    expect(proxyExpectations("verifier").find((x) => x.host === "registry.npmjs.org")?.allowed).toBe(false);
    expect(proxyExpectations("fixer").find((x) => x.host === "registry.npmjs.org")?.allowed).toBeNull();
  });
});
