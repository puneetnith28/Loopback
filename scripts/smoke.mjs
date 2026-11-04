#!/usr/bin/env node
// Is the running gate ready? Reads /healthz and /readyz on 127.0.0.1 and names any failing check.
//   npm run smoke          exit 0 ready, 1 not ready, 2 no gate answering
// Run it after `npm run gate`, and after scripts/reset-demo.sh (step 9.9). Read-only.

import { isMainModule } from "./sh.mjs";

const TIMEOUT_MS = 10_000;

export async function smoke(port, fetchFn = globalThis.fetch) {
  const get = async (path) => {
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}${path}`, { signal: globalThis.AbortSignal.timeout(TIMEOUT_MS) });
      return { status: res.status, body: await res.json() };
    } catch {
      return null;
    }
  };
  const live = await get("/healthz");
  if (live === null) return { code: 2, lines: [`no gate answering on 127.0.0.1:${port} (is npm run gate running? is HTTP_PORT right?)`] };
  const ready = await get("/readyz");
  const failing = Array.isArray(ready?.body?.failing) ? ready.body.failing.map(String) : [];
  const lines = [`live: ${live.status === 200 ? "yes" : "NO"}`, `ready: ${ready?.status === 200 ? "yes" : "NO"}`];
  if (failing.length > 0) lines.push(`failing checks: ${failing.join(", ")}`);
  return { code: live.status === 200 && ready?.status === 200 ? 0 : 1, lines };
}

if (isMainModule(import.meta.url)) {
  const { code, lines } = await smoke(Number(process.env.HTTP_PORT || 8787));
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = code;
}
