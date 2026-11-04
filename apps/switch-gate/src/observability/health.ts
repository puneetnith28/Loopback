import { createServer, type Server } from "node:http";

/** A readiness check that does not answer in time counts as failing. */
export const READY_CHECK_TIMEOUT_MS = 3000;

export interface ReadinessCheck {
  readonly name: string;
  readonly check: () => Promise<boolean>;
}

export interface HealthOptions {
  readonly port: number;
  /** /healthz: the process is up and the database answers. */
  readonly live: () => boolean;
  /** /readyz: every dependency the gate needs is usable. */
  readonly ready: readonly ReadinessCheck[];
}

/**
 * Health endpoints, bound to 127.0.0.1 only (never exposed). Responses name
 * failing checks but never include configuration or error details.
 */
export function startHealthServer(opts: HealthOptions): Promise<Server> {
  const server = createServer((req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { ok: false });
    if (req.url === "/healthz") {
      let ok: boolean;
      try {
        ok = opts.live();
      } catch {
        ok = false;
      }
      return send(ok ? 200 : 503, { ok });
    }
    if (req.url === "/readyz") {
      void Promise.all(
        opts.ready.map(async (r) => {
          try {
            const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_CHECK_TIMEOUT_MS).unref());
            return { name: r.name, ok: await Promise.race([r.check(), timeout]) };
          } catch {
            return { name: r.name, ok: false };
          }
        }),
      ).then((results) => {
        const failing = results.filter((r) => !r.ok).map((r) => r.name);
        send(failing.length === 0 ? 200 : 503, { ok: failing.length === 0, failing });
      });
      return;
    }
    send(404, { ok: false });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve(server));
  });
}
