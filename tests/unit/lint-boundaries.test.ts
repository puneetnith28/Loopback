import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { boundaryConfigs } from "../../eslint.config.boundaries.js";

// Lints in-memory fixtures against exactly the boundary rules CI enforces.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
    ...boundaryConfigs,
  ],
});

async function errors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.message);
}

const SRC = "apps/switch-gate/src";

describe("module boundaries", () => {
  it("policy may import only contracts and sibling policy modules", async () => {
    expect(await errors(`import { z } from "@loopback/contracts";\nimport { x } from "./authorize.js";`, `${SRC}/policy/evaluate.ts`)).toEqual([]);
    expect(await errors(`import Database from "better-sqlite3";`, `${SRC}/policy/evaluate.ts`)).toHaveLength(1);
    expect(await errors(`import { getPull } from "../github/client.js";`, `${SRC}/policy/evaluate.ts`)).toHaveLength(1);
    expect(await errors(`import { readFileSync } from "node:fs";`, `${SRC}/policy/evaluate.ts`)).toHaveLength(1);
  });

  it("signer may import only contracts, zod, node built-ins, the agents crypto modules and its siblings (D29)", async () => {
    const ok = [
      `import { VerifierReport } from "@loopback/contracts";`, `import { z } from "zod";`, `import { createServer } from "node:http";`,
      `import { signReport } from "../agents/signature.js";`, `import { verifyCapability } from "../agents/capability.js";`, `import { x } from "./policy.js";`,
    ];
    for (const code of ok) expect(await errors(code, `${SRC}/signer/server.ts`), code).toEqual([]);
    const bad = [
      `import { openDatabase } from "../persistence/db.js";`, `import { GitHubTransport } from "../github/transport.js";`,
      `import { loadGitHubConfig } from "../config.js";`, `import { extractReport } from "../agents/report.js";`,
      `import Database from "better-sqlite3";`, `import { append } from "../audit/index.js";`, `import { x } from "./sub/deep.js";`,
    ];
    for (const code of bad) expect((await errors(code, `${SRC}/signer/server.ts`)).length, code).toBeGreaterThan(0);
  });

  it("the console API may not reach the gate, GitHub, Switch, the signer, the filesystem or a child process", async () => {
    const file = "apps/console-api/src/store.ts";
    const ok = [
      `import { CaseId } from "@loopback/contracts";`, `import { CaseDetail } from "@loopback/console-contracts";`, `import { z } from "zod";`,
      `import Database from "better-sqlite3";`, `import { createServer } from "node:http";`, `import { randomUUID } from "node:crypto";`, `import { sanitize } from "./sanitize.js";`,
    ];
    for (const code of ok) expect(await errors(code, file), code).toEqual([]);
    const bad = [
      `import { x } from "../../switch-gate/src/config.js";`, `import { mergePullRequest } from "../../switch-gate/src/github/merge.js";`,
      `import { signReport } from "../../switch-gate/src/agents/signature.js";`, `import { x } from "@loopback/switch-gate";`,
      `import { readFileSync } from "node:fs";`, `import { execFile } from "node:child_process";`, `import { x } from "octokit";`, `import { x } from "./sub/deep.js";`,
    ];
    for (const code of bad) expect((await errors(code, file)).length, code).toBeGreaterThan(0);
  });

  it("only cases/service.ts may import the merge operation", async () => {
    const code = `import { mergePullRequest } from "../github/merge.js";`;
    expect(await errors(code, `${SRC}/cases/service.ts`)).toEqual([]);
    expect(await errors(code, `${SRC}/approvals/approve.ts`)).toHaveLength(1);
    expect(await errors(code, `${SRC}/commands/router.ts`)).toHaveLength(1);
  });

  it("audit internals are reachable only through audit/index", async () => {
    expect(await errors(`import { append } from "../audit/index.js";`, `${SRC}/cases/service.ts`)).toEqual([]);
    expect(await errors(`import { rawInsert } from "../audit/store.js";`, `${SRC}/cases/service.ts`)).toHaveLength(1);
    expect(await errors(`import { rawInsert } from "../audit/store.js";`, `${SRC}/approvals/approve.ts`)).toHaveLength(1);
    expect(await errors(`import { rawInsert } from "./store.js";`, `${SRC}/audit/index.ts`)).toEqual([]);
  });

  it("restrictions are not lost to config overriding: every file gets all its rules", async () => {
    // audit and github modules may not import merge either (only the case service may)
    expect(await errors(`import { m } from "../github/merge.js";`, `${SRC}/audit/index.ts`)).toHaveLength(1);
    // a policy file is still blocked from audit internals and merge
    // (may report more than one matching pattern; what matters is that it is blocked)
    expect(await errors(`import { m } from "../github/merge.js";`, `${SRC}/policy/evaluate.ts`)).not.toEqual([]);
    expect(await errors(`import { r } from "../audit/store.js";`, `${SRC}/policy/evaluate.ts`)).not.toEqual([]);
  });

  it("only github/* and main.ts may import the raw transport", async () => {
    const code = `import { GitHubTransport } from "../github/transport.js";`;
    expect(await errors(`import { GitHubTransport } from "./transport.js";`, `${SRC}/github/merge.ts`)).toEqual([]);
    expect(await errors(`import { GitHubTransport } from "./github/transport.js";`, `${SRC}/main.ts`)).toEqual([]);
    expect(await errors(`import { GitHubTransport } from "./github/transport.js";\nimport { createMerger } from "./github/merge.js";`, `${SRC}/app.ts`)).toEqual([]);
    expect(await errors(`import { createMerger } from "../github/merge.js";`, `${SRC}/workflow/poller.ts`)).toHaveLength(1);
    expect(await errors(code, `${SRC}/cases/service.ts`)).toHaveLength(1);
    expect(await errors(code, `${SRC}/approvals/approve.ts`)).toHaveLength(1);
    expect(await errors(code, `${SRC}/policy/evaluate.ts`)).not.toEqual([]);
  });

  it("each source file matches exactly one boundary config", async () => {
    const paths = [
      `${SRC}/policy/evaluate.ts`, `${SRC}/cases/service.ts`, `${SRC}/cases/machine.ts`,
      `${SRC}/github/client.ts`, `${SRC}/audit/index.ts`, `${SRC}/commands/router.ts`,
    ];
    for (const p of paths) {
      const cfg = (await eslint.calculateConfigForFile(p)) as Linter.Config;
      const rule = cfg.rules?.["no-restricted-imports"] as [string, { patterns: unknown[] }] | undefined;
      expect(rule, p).toBeDefined();
      expect(rule![1].patterns.length, p).toBeGreaterThan(0);
    }
  });
});
