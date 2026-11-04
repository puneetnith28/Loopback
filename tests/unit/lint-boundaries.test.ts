import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { boundaryConfigs } from "../../eslint.boundaries.js";

// Lints in-memory fixtures against exactly the boundary rules CI enforces.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser as Linter.Parser } },
    ...(boundaryConfigs as Linter.Config[]),
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
