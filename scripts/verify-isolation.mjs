#!/usr/bin/env node
// Read-only isolation evidence for D28 / step 6.4 on the container runtime
// (deploy/isolation: a session-only rootless Docker daemon, one container per agent role, one
// internal-only network per role, and one allowlisting egress proxy per role).
//
//   host      run on the host against the Loopback rootless daemon (DOCKER_HOST must point at it):
//               DOCKER_HOST=unix://$XDG_RUNTIME_DIR/loopback-docker/docker.sock node scripts/verify-isolation.mjs host
//             On Windows it runs against Docker Desktop instead, with DOCKER_HOST unset.
//   fixer     run INSIDE the role's container (deploy/isolation/agents.sh verify does both);
//   verifier  outside it the checks prove nothing and the script refuses with exit code 2.
//
// It creates, changes and sends nothing except: TCP connection attempts that must fail, proxy
// CONNECT requests (no data sent through an opened tunnel, except the verifier's single
// read-only GET of GH_REPO). It never prints file contents, tokens or keys.
//
// Every check fails closed: a probe passes only on the specific evidence of a block (no route,
// or the proxy's deliberate 403), never on a timeout or an unrelated error.
//
// Exit codes: 0 every check for this role passed; 1 at least one failed; 2 the proof cannot be
// executed here. Passing proves only what this role's checks show at this moment. Isolation is
// demonstrated only when all three roles pass, the verifier token's write probes are refused,
// and a live signed report is accepted while a forged one is rejected. This script never sets
// VERIFIER_ISOLATION_PROVEN.

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { URL, fileURLToPath } from "node:url";

export const EGRESS_NETWORK = "loopback-egress";
export const PROXY_URL = "http://proxy:3128";
export const SIGNER_NETWORK = "loopback-signer-net";
export const SIGNER_EGRESS_NETWORK = "loopback-signer-egress-net";
export const JOBS_VOLUME = "loopback-runner-jobs";
export const RESULTS_VOLUME = "loopback-runner-results";
/**
 * Agent roles. `networks` is the exact set each container is attached to (the first is its
 * primary, shared only with its own proxy); `volumes` maps every allowed named volume to
 * [destination, read-write].
 */
export const ROLES = Object.freeze({
  fixer: Object.freeze({
    uid: 10001, container: "loopback-fixer", proxy: "loopback-proxy-fixer", network: "loopback-fixer-net", volume: "loopback-fixer-home", home: "/home/fixer",
    networks: Object.freeze(["loopback-fixer-net"]),
    volumes: Object.freeze({ "loopback-fixer-home": ["/home/fixer", true] }),
  }),
  verifier: Object.freeze({
    uid: 10002, container: "loopback-verifier", proxy: "loopback-proxy-verifier", network: "loopback-verifier-net", volume: "loopback-verifier-home", home: "/home/verifier",
    networks: Object.freeze(["loopback-verifier-net", SIGNER_NETWORK]),
    volumes: Object.freeze({ "loopback-verifier-home": ["/home/verifier", true], [JOBS_VOLUME]: ["/jobs", true], [RESULTS_VOLUME]: ["/results", false] }),
  }),
});
/** D29: the signer holds the verifier signing key; the runner executes PR code. */
export const SIGNER = Object.freeze({
  uid: 10003, container: "loopback-signer", proxy: "loopback-proxy-signer", volume: "loopback-signer-home", home: "/home/signer",
  keyFile: "/home/signer/keys/signing-key.pem", tokenFile: "/home/signer/keys/client-token",
  networks: Object.freeze([SIGNER_NETWORK, SIGNER_EGRESS_NETWORK]),
});
export const RUNNER = Object.freeze({ uid: 10004, container: "loopback-runner", jobs: "/jobs", results: "/results" });
/** The internal network each role's proxy serves. */
export const PROXY_NETWORK = Object.freeze({ fixer: "loopback-fixer-net", verifier: "loopback-verifier-net", signer: SIGNER_EGRESS_NETWORK });
/** Environment variable names that must never reach the runner (it executes PR code). */
const SECRET_ENV = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|SIGNER_[A-Z_]*|SWITCH_[A-Z_]*|ANTHROPIC_[A-Z_]*|CLAUDE_[A-Z_]*|NPM_TOKEN|NODE_AUTH_TOKEN)=/;
export const ROOTFUL_SOCKETS = Object.freeze(["/var/run/docker.sock", "/run/docker.sock"]);
/** Direct destinations that must be unreachable from an agent container (no route out). */
export const DIRECT_PROBES = Object.freeze([
  { host: "1.1.1.1", port: 443, what: "the internet (1.1.1.1:443)" },
  { host: "140.82.112.3", port: 443, what: "GitHub without the proxy (140.82.112.3:443)" },
  { host: "169.254.169.254", port: 80, what: "the cloud metadata address" },
  { host: "10.0.2.2", port: 22, what: "the rootless host gateway (10.0.2.2)" },
  { host: "10.0.2.3", port: 53, what: "the rootless DNS forwarder (10.0.2.3)" },
  { host: "192.168.1.1", port: 80, what: "a typical LAN router (192.168.1.1)" },
  { host: "192.168.65.1", port: 443, what: "the Docker Desktop VM gateway (192.168.65.1)" },
  { host: "192.168.65.254", port: 80, what: "the Docker Desktop host address (192.168.65.254)" },
]);
/** Docker Desktop's names for the Windows host: unresolvable or unroutable from an agent container. */
export const DESKTOP_HOST_NAMES = Object.freeze(["host.docker.internal", "gateway.docker.internal", "kubernetes.docker.internal"]);
/** Only these outcomes prove "no route": anything else (a refusal, a reset, a timeout) is not evidence. */
export const NO_ROUTE = Object.freeze(["ENETUNREACH", "EHOSTUNREACH"]);
/** A name on another network must not even resolve (or, if it did, have no route). */
export const NOT_REACHABLE_BY_NAME = Object.freeze(["ENOTFOUND", "EAI_AGAIN", ...NO_ROUTE]);
/** The proxy's deliberate refusal. 502/503/504 or a timeout mean "failed", not "denied". */
export const PROXY_DENIED = 403;
const CONNECT_TIMEOUT_MS = 3000;
const PROXY_TIMEOUT_MS = 10000;

const pass = (text) => ({ level: "pass", text });
const fail = (text) => ({ level: "fail", text });
const info = (text) => ({ level: "info", text });
const check = (ok, good, badText) => (ok ? pass(good) : fail(badText));
const empty = (v) => v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : typeof v === "object" ? Object.keys(v).length === 0 : v === "");

// ---------------------------------------------------------------- pure assessments (unit-tested)

/** The daemon answering DOCKER_HOST must be the Loopback rootless one, never the rootful socket. */
export function assessDaemon(dockerInfo, dockerHost, expectedSocket) {
  const host = dockerHost ?? "";
  const sockPath = host.startsWith("unix://") ? host.slice("unix://".length).replace(/\/+/g, "/") : "";
  const opts = Array.isArray(dockerInfo?.SecurityOptions) ? dockerInfo.SecurityOptions : [];
  return [
    check(sockPath !== "" && !ROOTFUL_SOCKETS.includes(sockPath), "DOCKER_HOST is a per-user unix socket, not the rootful daemon", `DOCKER_HOST (${host || "unset"}) is not a per-user unix socket`),
    check(expectedSocket !== undefined && sockPath === expectedSocket, `DOCKER_HOST is the Loopback daemon (${expectedSocket})`, `DOCKER_HOST is not the Loopback daemon socket ${expectedSocket ?? "(unknown: XDG_RUNTIME_DIR unset)"}`),
    check(opts.some((o) => String(o).includes("name=rootless")), "the daemon runs rootless", "the daemon is not rootless"),
    check(opts.some((o) => String(o).includes("name=seccomp")), "the daemon applies a seccomp profile", "the daemon applies no seccomp profile"),
    check(dockerInfo?.DockerRootDir !== "/var/lib/docker", "the daemon's data root is not the system Docker's", "the daemon uses /var/lib/docker (system Docker)"),
  ];
}

/**
 * Windows: the daemon must be Docker Desktop's, running Linux containers. It is not rootless (it
 * is root inside Docker Desktop's VM), and that difference is reported, never passed off as equal.
 */
export function assessDesktopDaemon(dockerInfo, dockerHost) {
  const opts = Array.isArray(dockerInfo?.SecurityOptions) ? dockerInfo.SecurityOptions : [];
  return [
    check(dockerInfo?.OperatingSystem === "Docker Desktop", "the daemon is Docker Desktop's", `the daemon is not Docker Desktop's (${dockerInfo?.OperatingSystem ?? "unknown"})`),
    check(dockerInfo?.OSType === "linux", "the daemon runs Linux containers", `the daemon runs ${dockerInfo?.OSType ?? "unknown"} containers, not Linux`),
    check(!dockerHost, "DOCKER_HOST is unset, so the Docker Desktop context is used", `DOCKER_HOST is set (${dockerHost}); unset it`),
    check(opts.some((o) => String(o).includes("name=seccomp")), "the daemon applies a seccomp profile", "the daemon applies no seccomp profile"),
    info("residual (documented): the daemon is root inside Docker Desktop's VM, not rootless; a container escape reaches that VM and the Windows folders shared with it (docs/windows.md)"),
  ];
}

const hasNoNewPrivileges = (secOpts) => (secOpts ?? []).some((o) => o === "no-new-privileges" || o === "no-new-privileges:true");
const unconfined = (secOpts) => (secOpts ?? []).some((o) => /^(seccomp|apparmor)[=:]unconfined$/.test(o) || /^label[=:]disable$/.test(o));
const memberNames = (network) => Object.values(network?.Containers ?? {}).map((c) => c.Name).sort();

/** Hardening common to agents and proxies (from `docker inspect`). */
function hardening(p, c) {
  const hc = c?.HostConfig ?? {};
  const mounts = c?.Mounts ?? [];
  const capDrop = (hc.CapDrop ?? []).map((x) => String(x).toUpperCase());
  return [
    check(c?.State?.Running === true, `${p} container is running`, `${p} container is not running`),
    check(hc.Privileged === false, `${p} not privileged`, `${p} is privileged`),
    check(capDrop.includes("ALL") && empty(hc.CapAdd), `${p} all capabilities dropped, none added`, `${p} capabilities not fully dropped`),
    check(hasNoNewPrivileges(hc.SecurityOpt), `${p} no-new-privileges set`, `${p} no-new-privileges not set`),
    check(!unconfined(hc.SecurityOpt), `${p} seccomp/AppArmor not disabled`, `${p} runs with seccomp or AppArmor unconfined`),
    check(hc.ReadonlyRootfs === true, `${p} read-only root filesystem`, `${p} root filesystem is writable`),
    check(mounts.every((m) => m.Type === "volume" || m.Type === "tmpfs"), `${p} no host bind mounts`, `${p} has a host bind mount: ${mounts.filter((m) => m.Type !== "volume" && m.Type !== "tmpfs").map((m) => m.Destination).join(", ")}`),
    check(mounts.every((m) => m.Type !== "volume" || m.Driver === "local"), `${p} volumes use the local driver`, `${p} has a volume with a non-local driver`),
    check(!mounts.some((m) => /docker\.sock/.test(`${m.Source ?? ""} ${m.Destination ?? ""}`)), `${p} no Docker socket mounted`, `${p} a Docker socket is mounted`),
    check(empty(hc.Devices) && empty(hc.DeviceRequests), `${p} no host devices`, `${p} has host devices`),
    check(![hc.PidMode, hc.IpcMode, hc.UTSMode, hc.NetworkMode, hc.UsernsMode, hc.CgroupnsMode].includes("host"), `${p} shares no host namespace`, `${p} shares a host namespace`),
    check(empty(hc.PortBindings) && hc.PublishAllPorts !== true, `${p} publishes no ports`, `${p} publishes ports to the host`),
    check(empty(hc.VolumesFrom) && empty(hc.ExtraHosts) && empty(hc.Sysctls) && empty(hc.GroupAdd) && empty(hc.Links), `${p} no volumes-from, extra hosts, sysctls, extra groups or links`, `${p} sets volumes-from, extra hosts, sysctls, extra groups or links`),
    check(hc.Runtime === undefined || hc.Runtime === "runc", `${p} default runtime (runc)`, `${p} runtime is ${hc.Runtime}`),
    check(Number(hc.PidsLimit) > 0 && Number(hc.Memory) > 0, `${p} pids and memory limits set`, `${p} pids or memory limit missing`),
  ];
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Every named volume must be one this container may have, at its destination, with its mode. */
function volumeChecks(p, mounts, allowed) {
  const vols = mounts.filter((m) => m.Type === "volume");
  const bad = vols.filter((m) => {
    const spec = allowed[m.Name];
    return spec === undefined || spec[0] !== m.Destination || spec[1] !== (m.RW !== false);
  });
  return [check(bad.length === 0, `${p} only its own volumes, each at its place and mode`, `${p} unexpected volume(s): ${bad.map((m) => `${m.Name}:${m.Destination}${m.RW === false ? ":ro" : ""}`).join(", ")}`)];
}

/** One agent container, as returned by `docker inspect`, with its network from `docker network inspect`. */
export function assessContainer(roleName, c, network) {
  const role = ROLES[roleName];
  const hc = c?.HostConfig ?? {};
  const env = c?.Config?.Env ?? [];
  const envIs = (name, value) => env.includes(`${name}=${value}`);
  const nets = Object.keys(c?.NetworkSettings?.Networks ?? {});
  const p = `${roleName}:`;
  return [
    ...hardening(p, c),
    check(c?.Config?.User === `${role.uid}:${role.uid}`, `${p} runs as uid/gid ${role.uid}`, `${p} user is ${c?.Config?.User || "root (unset)"}, not ${role.uid}:${role.uid}`),
    check((c?.Mounts ?? []).some((m) => m.Type === "volume" && m.Name === role.volume && m.Destination === role.home), `${p} home is its own volume ${role.volume}`, `${p} home is not the volume ${role.volume}`),
    ...volumeChecks(p, c?.Mounts ?? [], role.volumes),
    check(sameSet(nets, role.networks) && hc.NetworkMode === role.network, `${p} attached exactly to [${role.networks.join(", ")}]`, `${p} networks are [${nets.join(", ")}], expected [${role.networks.join(", ")}]`),
    check(network?.Internal === true, `${p} ${role.network} is internal (no route out)`, `${p} ${role.network} is not internal`),
    check(JSON.stringify(memberNames(network)) === JSON.stringify([role.container, role.proxy].sort()), `${p} only its own proxy shares its network`, `${p} ${role.network} members are [${memberNames(network).join(", ")}]`),
    check(!env.some((e) => e === "GITHUB_TOKEN" || e.startsWith("GITHUB_TOKEN=")), `${p} GITHUB_TOKEN not set`, `${p} GITHUB_TOKEN is set (only the role's GH_TOKEN is allowed)`),
    check(envIs("LOOPBACK_AGENT_ROLE", roleName), `${p} LOOPBACK_AGENT_ROLE=${roleName}`, `${p} LOOPBACK_AGENT_ROLE is not ${roleName}`),
    check(envIs("HTTPS_PROXY", PROXY_URL), `${p} HTTPS_PROXY is its own proxy`, `${p} HTTPS_PROXY is not ${PROXY_URL}`),
  ];
}

/** A role's egress proxy: hardened, non-root, on exactly its role's network and the egress network. */
export function assessProxy(roleName, c) {
  const role = { proxy: `loopback-proxy-${roleName}`, network: PROXY_NETWORK[roleName] };
  const env = c?.Config?.Env ?? [];
  const user = c?.Config?.User ?? "";
  const nets = Object.keys(c?.NetworkSettings?.Networks ?? {}).sort();
  const p = `${role.proxy}:`;
  const results = [
    ...hardening(p, c),
    check(user !== "" && !/^(root|0)(:|$)/.test(user), `${p} runs as a non-root user (${user})`, `${p} runs as root`),
    check(JSON.stringify(nets) === JSON.stringify([EGRESS_NETWORK, role.network].sort()), `${p} on exactly ${role.network} and ${EGRESS_NETWORK}`, `${p} networks are [${nets.join(", ")}]`),
    check(env.includes(`LOOPBACK_PROXY_ROLE=${roleName}`), `${p} serves the ${roleName} policy`, `${p} is not configured for ${roleName}`),
  ];
  if (roleName !== "fixer") {
    results.push(check(!env.includes("LOOPBACK_FIXER_REGISTRY=1"), `${p} has no registry access`, `${p} has registry access enabled`));
  }
  return results;
}

/**
 * D29: the signer container: its own uid and key volume, reachable only on the network it shares
 * with the verifier, with egress only through its own GitHub-API proxy.
 */
export function assessSigner(c, signerNet, egressNet) {
  const p = "signer:";
  const env = c?.Config?.Env ?? [];
  const nets = Object.keys(c?.NetworkSettings?.Networks ?? {});
  return [
    ...hardening(p, c),
    check(c?.Config?.User === `${SIGNER.uid}:${SIGNER.uid}`, `${p} runs as uid/gid ${SIGNER.uid}`, `${p} user is ${c?.Config?.User || "root (unset)"}`),
    ...volumeChecks(p, c?.Mounts ?? [], { [SIGNER.volume]: [SIGNER.home, true] }),
    check((c?.Mounts ?? []).some((m) => m.Type === "volume" && m.Name === SIGNER.volume), `${p} key volume ${SIGNER.volume} mounted`, `${p} key volume missing`),
    check(sameSet(nets, SIGNER.networks), `${p} attached exactly to [${SIGNER.networks.join(", ")}]`, `${p} networks are [${nets.join(", ")}]`),
    check(signerNet?.Internal === true && sameSet(memberNames(signerNet), [SIGNER.container, ROLES.verifier.container]), `${p} ${SIGNER_NETWORK} is internal and shared only with the verifier`, `${p} ${SIGNER_NETWORK} internal=${signerNet?.Internal}, members [${memberNames(signerNet).join(", ")}]`),
    check(egressNet?.Internal === true && sameSet(memberNames(egressNet), [SIGNER.container, SIGNER.proxy]), `${p} ${SIGNER_EGRESS_NETWORK} is internal and shared only with its proxy`, `${p} ${SIGNER_EGRESS_NETWORK} internal=${egressNet?.Internal}, members [${memberNames(egressNet).join(", ")}]`),
    check(!env.some((e) => /^(GITHUB_TOKEN|GH_TOKEN)(=|$)/.test(e)), `${p} no GitHub write-capable token variable`, `${p} has GH_TOKEN or GITHUB_TOKEN set`),
    check(env.includes(`HTTPS_PROXY=${PROXY_URL}`), `${p} uses its own proxy`, `${p} HTTPS_PROXY is not ${PROXY_URL}`),
  ];
}

/** D29: the runner executes PR code: no network at all, no credentials, jobs read-only. */
export function assessRunner(c) {
  const p = "runner:";
  const hc = c?.HostConfig ?? {};
  const env = c?.Config?.Env ?? [];
  const nets = Object.keys(c?.NetworkSettings?.Networks ?? {});
  return [
    ...hardening(p, c),
    check(c?.Config?.User === `${RUNNER.uid}:${RUNNER.uid}`, `${p} runs as uid/gid ${RUNNER.uid}`, `${p} user is ${c?.Config?.User || "root (unset)"}`),
    check(hc.NetworkMode === "none" && nets.every((n) => n === "none"), `${p} has no network (--network none)`, `${p} network mode ${hc.NetworkMode}, networks [${nets.join(", ")}]`),
    ...volumeChecks(p, c?.Mounts ?? [], { [JOBS_VOLUME]: [RUNNER.jobs, false], [RESULTS_VOLUME]: [RUNNER.results, true] }),
    check(!env.some((e) => SECRET_ENV.test(e) || e === "GH_TOKEN" || e === "GITHUB_TOKEN"), `${p} no credentials in its environment`, `${p} has a credential variable in its environment`),
  ];
}

/** Named volumes must be plain local volumes (a local volume with bind options is a host bind mount). */
export function assessVolumes(volumes) {
  return (volumes ?? []).map((v) => check(v?.Driver === "local" && empty(v?.Options), `volume ${v?.Name} is a plain local volume`, `volume ${v?.Name} has driver ${v?.Driver} or options (possible host bind)`));
}

/** D29: the signer's key volume is mounted by the signer alone; the runner's volumes never by the fixer. */
export function assessVolumeOwnership(containers) {
  const users = (vol) => containers.filter((c) => (c?.Mounts ?? []).some((m) => m.Type === "volume" && m.Name === vol)).map((c) => String(c?.Name ?? "").replace(/^\//, ""));
  const signerUsers = users(SIGNER.volume);
  const fixerRunner = [JOBS_VOLUME, RESULTS_VOLUME].filter((v) => users(v).includes(ROLES.fixer.container));
  return [
    check(sameSet(signerUsers, [SIGNER.container]), `${SIGNER.volume} is mounted by the signer alone`, `${SIGNER.volume} is mounted by [${signerUsers.join(", ")}]`),
    check(fixerRunner.length === 0, "the fixer mounts no runner volume", `the fixer mounts ${fixerRunner.join(", ")}`),
  ];
}

/** Fixer and verifier must share no identity, volume or network. */
export function assessSeparation(fixer, verifier) {
  const vols = (c) => new Set((c?.Mounts ?? []).filter((m) => m.Type === "volume").map((m) => m.Name));
  const fv = vols(fixer);
  const shared = [...vols(verifier)].filter((v) => fv.has(v));
  const fn = Object.keys(fixer?.NetworkSettings?.Networks ?? {});
  const sharedNets = Object.keys(verifier?.NetworkSettings?.Networks ?? {}).filter((n) => fn.includes(n));
  return [
    check(fixer?.Config?.User !== verifier?.Config?.User, "fixer and verifier run as different uids", "fixer and verifier run as the same uid"),
    check(shared.length === 0, "fixer and verifier share no volume", `fixer and verifier share volume(s): ${shared.join(", ")}`),
    check(sharedNets.length === 0, "fixer and verifier share no network", `fixer and verifier share network(s): ${sharedNets.join(", ")}`),
  ];
}

/** CapEff and NoNewPrivs from /proc/self/status. */
export function parseProcStatus(text) {
  const field = (name) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(text)?.[1];
  const capEff = field("CapEff");
  return { capEff: capEff === undefined ? null : BigInt(`0x${capEff}`), noNewPrivs: field("NoNewPrivs") === "1" };
}

/** Is the mount at `point` read-only, according to /proc/self/mountinfo? (Last entry wins, as mounts stack.) */
export function mountIsReadOnly(mountinfo, point) {
  let ro = false;
  let found = false;
  for (const line of mountinfo.split("\n")) {
    const f = line.split(" ");
    if (f[4] === point) { found = true; ro = f[5]?.split(",").includes("ro") === true; }
  }
  return found && ro;
}

/** Is "/" mounted read-only, according to /proc/self/mountinfo? */
export function rootIsReadOnly(mountinfo) {
  return mountIsReadOnly(mountinfo, "/");
}

/** Expected CONNECT outcome per role: true = must be 200, false = must be the proxy's 403, null = report only. */
export function proxyExpectations(roleName, nonce = "probe") {
  return [
    { host: "api.github.com", port: 443, allowed: true },
    { host: "github.com", port: 443, allowed: true },
    { host: "api.anthropic.com", port: 443, allowed: true },
    { host: "example.com", port: 443, allowed: false },
    { host: `lb-${nonce}.example.org`, port: 443, allowed: false },
    { host: "gist.github.com", port: 443, allowed: false },
    { host: "evil.api.github.com", port: 443, allowed: false },
    { host: "169.254.169.254", port: 443, allowed: false },
    { host: "140.82.112.3", port: 443, allowed: false },
    { host: "[::1]", port: 443, allowed: false },
    { host: "10.0.2.2", port: 443, allowed: false },
    { host: "api.github.com", port: 80, allowed: false },
    { host: "registry.npmjs.org", port: 443, allowed: roleName === "verifier" ? false : null },
    { host: ROLES[roleName === "fixer" ? "verifier" : "fixer"].container, port: 443, allowed: false },
  ];
}

/** Did a CONNECT get the expected answer? A refusal must be the proxy's deliberate 403. */
export function connectAsExpected(status, allowed) {
  return allowed ? status === 200 : status === PROXY_DENIED;
}

// ---------------------------------------------------------------- probes (side effects)

function tcpAttempt(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (outcome) => { s.destroy(); resolve(outcome); };
    s.setTimeout(timeoutMs, () => done("timeout"));
    s.once("connect", () => done("connected"));
    s.once("error", (e) => done(e.code ?? "error"));
  });
}

function proxyConnect(proxy, host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: `${host}:${port}`, timeout: PROXY_TIMEOUT_MS });
    req.once("connect", (res, socket) => { socket.setTimeout(0); resolve({ status: res.statusCode, socket }); });
    req.once("timeout", () => { req.destroy(); resolve({ status: "timeout" }); });
    req.once("error", (e) => resolve({ status: e.code ?? "error" }));
    req.end();
  });
}

function proxyPlainGet(proxy) {
  return new Promise((resolve) => {
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port), path: "http://example.com/", headers: { host: "example.com" }, timeout: PROXY_TIMEOUT_MS }, (res) => { res.resume(); resolve(res.statusCode); });
    req.once("timeout", () => { req.destroy(); resolve("timeout"); });
    req.once("error", (e) => resolve(e.code ?? "error"));
    req.end();
  });
}

/**
 * Options for a GET through a tunnel. The explicit host header matters: with createConnection Node
 * has no agent to take a default port from, so it would send "Host: api.github.com:80", and GitHub
 * answers that with 400 whatever the token.
 */
export function githubGetOptions(path, token) {
  return {
    host: "api.github.com", path, method: "GET", timeout: PROXY_TIMEOUT_MS,
    headers: { host: "api.github.com", authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "loopback-verify-isolation" },
  };
}

/** One read-only GET through the proxy tunnel; returns the HTTP status only. */
async function githubGet(proxy, path, token) {
  const tunnel = await proxyConnect(proxy, "api.github.com", 443);
  if (tunnel.status !== 200) { tunnel.socket?.destroy(); return `tunnel ${tunnel.status}`; }
  return new Promise((resolve) => {
    const req = https.request({
      ...githubGetOptions(path, token),
      createConnection: () => tls.connect({ socket: tunnel.socket, servername: "api.github.com" }),
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.once("timeout", () => { req.destroy(); resolve("timeout"); });
    req.once("error", (e) => resolve(e.code ?? "error"));
    req.end();
  });
}

/** The error code from trying to read a path, or "readable". */
const readOutcome = (path) => {
  try {
    if (lstatSync(path).isDirectory()) readdirSync(path);
    else readFileSync(path);
    return "readable";
  } catch (e) {
    return e.code ?? "error";
  }
};
const rootLocked = (path) => { try { const s = lstatSync(path); return s.uid === 0 && (s.mode & 0o022) === 0; } catch { return false; } };

/** Root-owned, read-only tooling and signer runtime: no role can swap what it runs or checks. */
function toolingChecks() {
  const signer = "/opt/loopback-app/apps/switch-gate/dist";
  return ["/opt/loopback", "/opt/loopback/verify-isolation.mjs", "/opt/loopback/request-signature.mjs", "/opt/loopback/run-in-sandbox.mjs",
    "/opt/loopback/sandbox-runner.mjs", "/opt/loopback/signature.js", "/opt/loopback-app", "/opt/loopback-app/node_modules",
    ...["signer", "signer/main.js", "signer/policy.js", "signer/server.js", "signer/replay.js", "signer/github-pull.js", "agents/capability.js", "agents/signature.js"].map((f) => `${signer}/${f}`)].map((p) =>
    check(rootLocked(p), `${p} is root-owned and not writable by others`, `${p} is missing, not root-owned, or writable by others`));
}

/** An HTTP request to the signer on the internal network (never via the proxy). Status only. */
function signerHttp(method, path, headers = {}, body = "") {
  return new Promise((resolve) => {
    const req = http.request({ host: "signer", port: 8080, method, path, headers: { ...headers, "content-length": Buffer.byteLength(body) }, timeout: CONNECT_TIMEOUT_MS }, (res) => { res.resume(); resolve(res.statusCode); });
    req.once("timeout", () => { req.destroy(); resolve("timeout"); });
    req.once("error", (e) => resolve(e.code ?? "error"));
    req.end(body);
  });
}

function gitCredentialHelpers() {
  try { return execFileSync("git", ["config", "--get-all", "credential.helper"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

// ---------------------------------------------------------------- roles

class CannotRun extends Error {}

function docker(args) {
  try { return JSON.parse(execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) { throw new CannotRun(`docker ${args[0]} ${args[1] ?? ""} failed: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`); }
}

async function hostRole() {
  const dockerHost = process.env.DOCKER_HOST;
  const desktop = process.platform === "win32";
  if (!desktop && !dockerHost) throw new CannotRun("DOCKER_HOST is not set; point it at the Loopback rootless daemon (deploy/isolation/rootless-docker.sh env)");
  const runDir = process.env.LOOPBACK_DOCKER_RUN_DIR || (process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "loopback-docker") : undefined);
  const dockerInfo = docker(["info", "--format", "{{json .}}"]);
  const results = desktop ? assessDesktopDaemon(dockerInfo, dockerHost) : [...assessDaemon(dockerInfo, dockerHost, runDir && join(runDir, "docker.sock"))];
  const names = [ROLES.fixer.container, ROLES.verifier.container, SIGNER.container, RUNNER.container, ROLES.fixer.proxy, ROLES.verifier.proxy, SIGNER.proxy];
  const all = docker(["inspect", ...names]);
  const byName = (n) => all.find((c) => c?.Name === `/${n}`);
  const net = (n) => docker(["network", "inspect", n])[0];
  for (const name of ["fixer", "verifier"]) {
    results.push(...assessContainer(name, byName(ROLES[name].container), net(ROLES[name].network)));
    results.push(...assessProxy(name, byName(ROLES[name].proxy)));
  }
  results.push(...assessSigner(byName(SIGNER.container), net(SIGNER_NETWORK), net(SIGNER_EGRESS_NETWORK)));
  results.push(...assessProxy("signer", byName(SIGNER.proxy)));
  results.push(...assessRunner(byName(RUNNER.container)));
  results.push(...assessVolumes(docker(["volume", "inspect", ROLES.fixer.volume, ROLES.verifier.volume, SIGNER.volume, JOBS_VOLUME, RESULTS_VOLUME])));
  results.push(...assessVolumeOwnership(all));
  results.push(...assessSeparation(byName(ROLES.fixer.container), byName(ROLES.verifier.container)));
  const here = dirname(fileURLToPath(import.meta.url));
  const key = process.env.LOOPBACK_GATE_KEY || join(here, "..", "secrets", "gate.pem");
  if (!existsSync(key)) {
    results.push(fail(`gate key not found at ${key} (set LOOPBACK_GATE_KEY)`));
  } else if (desktop) {
    let problem;
    try {
      problem = (await import("../apps/switch-gate/dist/platform/windows-acl.js")).windowsPermissions().file(key);
    } catch {
      problem = "permissions not checked; run npm run build";
    }
    results.push(check(problem === null, "gate key is private to you (ACL)", `gate key: ${problem}`));
  } else {
    const mode = lstatSync(key).mode & 0o777;
    results.push(check(mode === 0o600 || mode === 0o400, "gate key is owner-only", `gate key mode ${mode.toString(8)} is not owner-only`));
  }
  results.push(info(`residual (documented): the desktop user owns the ${desktop ? "Docker Desktop" : "rootless"} daemon and can read every volume, including the signer's key`));
  return results;
}

async function agentRole(roleName) {
  const role = ROLES[roleName];
  const uid = role.uid;
  containerPreconditions(roleName, uid);
  // The proxy address is fixed by the role's network, not taken from the (agent-controlled) environment.
  const proxy = new URL(PROXY_URL);

  const results = [];
  const home = lstatSync(role.home, { throwIfNoEntry: false });
  results.push(check(process.env.HOME === role.home && home?.uid === uid && (home.mode & 0o077) === 0, "HOME is the role's own 0700 home", `HOME ${process.env.HOME} is not ${role.home} owned by ${uid} with mode 0700`));
  const other = ROLES[roleName === "fixer" ? "verifier" : "fixer"];
  const otherRead = readOutcome(other.home);
  results.push(check(otherRead === "EACCES", `the other role's home (${other.home}) is not readable (EACCES)`, `the other role's home (${other.home}): ${otherRead}, expected EACCES`));
  results.push(...sandboxBasics());
  results.push(...await directProbes());
  for (const host of DESKTOP_HOST_NAMES) {
    const outcome = await tcpAttempt(host, 443);
    results.push(check(NOT_REACHABLE_BY_NAME.includes(outcome), `${host} is not reachable (${outcome})`, `${host}: ${outcome}, expected unreachable`));
  }
  for (const host of [other.container, other.proxy]) {
    const outcome = await tcpAttempt(host, 3128);
    results.push(check(NOT_REACHABLE_BY_NAME.includes(outcome), `${host} is not reachable (${outcome})`, `${host}: ${outcome}, expected unreachable`));
  }
  let resolved = null;
  try { resolved = await lookup("example.com"); } catch { /* expected: no external DNS */ }
  results.push(check(resolved === null, "external DNS names do not resolve inside", "external DNS names resolve inside (a DNS side channel)"));
  for (const e of proxyExpectations(roleName, randomBytes(6).toString("hex"))) {
    const r = await proxyConnect(proxy, e.host, e.port);
    r.socket?.destroy();
    const label = `proxy CONNECT ${e.host}:${e.port} → ${r.status}`;
    if (e.allowed === null) results.push(info(`${label} (registry access is toggled by the owner)`));
    else results.push(check(connectAsExpected(r.status, e.allowed), label, `${label}, expected ${e.allowed ? 200 : PROXY_DENIED}`));
  }
  const plain = await proxyPlainGet(proxy);
  results.push(check(plain === PROXY_DENIED, `proxy refuses plain HTTP (${plain})`, `proxy answered plain HTTP with ${plain}, expected ${PROXY_DENIED}`));

  results.push(check(!process.env.GITHUB_TOKEN, "GITHUB_TOKEN not set", "GITHUB_TOKEN is set"));
  results.push(info(process.env.GH_TOKEN ? "the role's GH_TOKEN is set (value not shown)" : "no GH_TOKEN set yet (owner-supplied role env file)"));
  const helpers = gitCredentialHelpers();
  if (roleName === "verifier") {
    results.push(check(helpers === "", "verifier has no git credential helper", "verifier has a git credential helper configured"));
    // D29: the verifier holds a signer client token, never a signing key.
    const keys = findPrivateKeys(role.home);
    results.push(check(keys.length === 0, "no private key anywhere in the verifier's home", `private key file(s) in the verifier's home: ${keys.join(", ")}`));
    results.push(check(readOutcome(SIGNER.home) !== "readable" && !existsSync(SIGNER.keyFile), "the signer's key directory is not here", "the signer's key directory is visible in the verifier"));
    const tk = join(role.home, ".config", "loopback-verifier", "signer-token");
    const ts = lstatSync(tk, { throwIfNoEntry: false });
    results.push(check(ts?.isFile() === true && ts.uid === uid && (ts.mode & 0o777) === 0o600, "the signer client token is the verifier's own (mode 600)", `no signer client token owned by ${uid} with mode 600 at ${tk} (run agents.sh signer-token)`));
    const health = await signerHttp("GET", "/healthz");
    results.push(check(health === 200, "the signer answers on the signer network", `the signer is not reachable (${health})`));
    const unauth = await signerHttp("POST", "/v1/sign", { "content-type": "application/json" }, "{}");
    results.push(check(unauth === 401, "the signer refuses an unauthenticated request (401)", `the signer answered an unauthenticated request with ${unauth}`));
    const runnerReach = await tcpAttempt(RUNNER.container, 8080);
    results.push(check(NOT_REACHABLE_BY_NAME.includes(runnerReach), `the runner is not reachable over the network (${runnerReach})`, `the runner: ${runnerReach}, expected unreachable`));
    const repo = process.env.GH_REPO;
    if (repo && process.env.GH_TOKEN) {
      const status = await githubGet(proxy, `/repos/${repo}`, process.env.GH_TOKEN);
      results.push(check(status === 200, `verifier can read ${repo} through the proxy (GET 200)`, `verifier cannot read ${repo} (${status})`));
      results.push(info("write permissions are NOT tested here; run the separately authorised probes"));
    } else {
      results.push(fail("cannot show read access (needs GH_REPO and GH_TOKEN in the verifier's env file)"));
    }
  } else {
    results.push(info(helpers === "" ? "no git credential helper" : "a git credential helper is configured (names not shown)"));
    for (const host of ["signer", SIGNER.container]) {
      const outcome = await tcpAttempt(host, 8080);
      results.push(check(NOT_REACHABLE_BY_NAME.includes(outcome), `the signer (${host}) is not reachable from the fixer (${outcome})`, `the signer (${host}) from the fixer: ${outcome}, expected unreachable`));
    }
  }
  return results;
}

/** PEM private keys under a directory (bounded walk; names only, never contents). */
function findPrivateKeys(dir, depth = 0, found = []) {
  if (depth > 6 || found.length > 10) return found;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findPrivateKeys(p, depth + 1, found);
    else if (e.isFile()) {
      try {
        const st = lstatSync(p);
        if (st.size <= 64 * 1024 && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readFileSync(p, "utf8"))) found.push(p);
      } catch { /* unreadable: not ours */ }
    }
  }
  return found;
}

function containerPreconditions(roleName, uid) {
  if (!existsSync("/.dockerenv")) throw new CannotRun(`not inside a container; run this inside the ${roleName}'s container`);
  if (process.env.LOOPBACK_AGENT_ROLE !== roleName) throw new CannotRun(`LOOPBACK_AGENT_ROLE is not ${roleName}; not the ${roleName}'s container`);
  const me = typeof process.getuid === "function" ? process.getuid() : -1;
  if (me !== uid) throw new CannotRun(`uid ${me} is not the ${roleName}'s uid ${uid}`);
}

function sandboxBasics() {
  const st = parseProcStatus(readFileSync("/proc/self/status", "utf8"));
  return [
    check(st.capEff === 0n, "no effective capabilities", "effective capabilities are not empty"),
    check(st.noNewPrivs, "no_new_privs is set", "no_new_privs is not set"),
    check(rootIsReadOnly(readFileSync("/proc/self/mountinfo", "utf8")), "root filesystem is read-only", "root filesystem is writable"),
    check(!ROOTFUL_SOCKETS.some((s) => existsSync(s)) && !process.env.DOCKER_HOST, "no Docker socket or DOCKER_HOST inside", "a Docker socket or DOCKER_HOST is visible inside"),
    ...toolingChecks(),
  ];
}

async function directProbes() {
  const out = [];
  for (const probe of DIRECT_PROBES) {
    const outcome = await tcpAttempt(probe.host, probe.port);
    out.push(check(NO_ROUTE.includes(outcome), `direct connection to ${probe.what}: no route (${outcome})`, `direct connection to ${probe.what}: ${outcome}, expected no route`));
  }
  return out;
}

/** D29: inside the signer: its own key, no route out, GitHub API only through its proxy, no agent reachable. */
async function signerRole() {
  containerPreconditions("signer", SIGNER.uid);
  const results = [...sandboxBasics()];
  const k = lstatSync(SIGNER.keyFile, { throwIfNoEntry: false });
  results.push(check(k?.isFile() === true && k.uid === SIGNER.uid && (k.mode & 0o777) === 0o600, "the signing key is the signer's own (mode 600)", `no signing key owned by ${SIGNER.uid} with mode 600 at ${SIGNER.keyFile}`));
  for (const h of [ROLES.fixer.home, ROLES.verifier.home]) {
    const o = readOutcome(h);
    results.push(check(o === "EACCES" || o === "ENOENT", `${h} is not readable (${o})`, `${h}: ${o}`));
  }
  results.push(...await directProbes());
  const proxy = new URL(PROXY_URL);
  for (const [host, allowed] of [["api.github.com", true], ["github.com", false], ["example.com", false], ["api.anthropic.com", false], ["169.254.169.254", false]]) {
    const r = await proxyConnect(proxy, host, 443);
    r.socket?.destroy();
    results.push(check(connectAsExpected(r.status, allowed), `signer proxy CONNECT ${host}:443 → ${r.status}`, `signer proxy CONNECT ${host}:443 → ${r.status}, expected ${allowed ? 200 : PROXY_DENIED}`));
  }
  for (const host of [ROLES.fixer.container, ROLES.fixer.proxy, RUNNER.container]) {
    const o = await tcpAttempt(host, 3128);
    results.push(check(NOT_REACHABLE_BY_NAME.includes(o), `${host} is not reachable (${o})`, `${host}: ${o}, expected unreachable`));
  }
  results.push(check(!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN, "no GH_TOKEN/GITHUB_TOKEN", "a GitHub token variable is set"));
  return results;
}

/** D29: inside the runner: no network at all, no credentials, no key, jobs read-only. */
async function runnerRole() {
  containerPreconditions("runner", RUNNER.uid);
  const results = [...sandboxBasics()];
  const leaked = Object.keys(process.env).filter((k) => SECRET_ENV.test(`${k}=`));
  results.push(check(leaked.length === 0, "no credential variables in the environment", `credential variable(s) present: ${leaked.join(", ")}`));
  for (const h of [ROLES.fixer.home, ROLES.verifier.home, SIGNER.home]) {
    const o = readOutcome(h);
    results.push(check(o === "EACCES" || o === "ENOENT", `${h} is not readable (${o})`, `${h}: ${o}`));
  }
  results.push(check(findPrivateKeys("/work").length === 0 && !existsSync(SIGNER.keyFile), "no private key visible", "a private key is visible to the runner"));
  results.push(...await directProbes());
  for (const host of ["signer", SIGNER.container, "proxy", ROLES.verifier.container]) {
    const o = await tcpAttempt(host, 8080);
    results.push(check(NOT_REACHABLE_BY_NAME.includes(o), `${host} is not reachable (${o})`, `${host}: ${o}, expected unreachable`));
  }
  let resolved = null;
  try { resolved = await lookup("example.com"); } catch { /* expected */ }
  results.push(check(resolved === null, "no DNS resolution", "external names resolve inside the runner"));
  results.push(check(mountIsReadOnly(readFileSync("/proc/self/mountinfo", "utf8"), RUNNER.jobs), "the jobs volume is mounted read-only in the runner", "the jobs volume is not mounted read-only in the runner"));
  return results;
}

// ---------------------------------------------------------------- CLI

const TAG = { pass: "PASS ", fail: "FAIL ", info: "INFO " };

export async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(`${s}\n`)) {
  const role = argv[0];
  if (!["host", "fixer", "verifier", "signer", "runner"].includes(role ?? "")) { process.stderr.write("usage: verify-isolation.mjs host|fixer|verifier|signer|runner\n"); return 2; }
  out(`== isolation checks (${role})`);
  let results;
  try {
    results = role === "host" ? await hostRole() : role === "signer" ? await signerRole() : role === "runner" ? await runnerRole() : await agentRole(role);
  } catch (e) {
    if (!(e instanceof CannotRun)) throw e;
    out(`CANNOT RUN  ${e.message}`);
    out("== verdict: NOT PROVEN (the proof could not be executed here)");
    return 2;
  }
  for (const r of results) out(`${TAG[r.level]} ${r.text}`);
  const failures = results.filter((r) => r.level === "fail").length;
  out("== summary");
  if (failures === 0) { out(`every check for role ${role} passed (one part of the evidence; isolation is not proven by this alone)`); return 0; }
  out(`${failures} failure(s) for role ${role}`);
  out("== verdict: NOT PROVEN");
  return 1;
}

const invokedPath = process.argv[1] ?? "";
const scriptPath = fileURLToPath(import.meta.url);
if (process.platform === "win32" ? scriptPath.toLowerCase() === resolve(invokedPath).toLowerCase() : scriptPath === invokedPath) {
  process.exitCode = await main();
}
