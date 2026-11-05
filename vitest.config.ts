import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractsSrc = fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url));

const consoleContractsSrc = fileURLToPath(new URL("./packages/console-contracts/src/index.ts", import.meta.url));

const shared = {
  resolve: { alias: { "@loopback/contracts": contractsSrc, "@loopback/console-contracts": consoleContractsSrc } },
};

// Windows starts PowerShell for each real ACL check, and processes start slowly there.
const testTimeout = process.platform === "win32" ? 30_000 : 5_000;

export default defineConfig({
  ...shared,
  test: {
    passWithNoTests: true,
    projects: [
      { ...shared, test: { name: "unit", testTimeout, include: ["tests/unit/**/*.test.ts"] } },
      { ...shared, test: { name: "integration", testTimeout, include: ["tests/integration/**/*.test.ts"] } },
      { ...shared, test: { name: "security", testTimeout, include: ["tests/security/**/*.test.ts"] } },
      { ...shared, test: { name: "e2e", testTimeout, include: ["tests/e2e/**/*.test.ts"] } },
      // Frontend (jsdom) — its own config: apps/console/vitest.config.ts.
      "apps/console/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["apps/switch-gate/src/**/*.ts", "apps/console-api/src/**/*.ts", "packages/contracts/src/**/*.ts", "packages/console-contracts/src/**/*.ts"],
      exclude: ["**/main.ts", "**/*-cli.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "apps/switch-gate/src/policy/**": { branches: 95 },
        "apps/switch-gate/src/cases/machine.ts": { branches: 95 },
      },
    },
  },
});
