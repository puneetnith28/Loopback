import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const contracts = fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url));

export default defineProject({
  resolve: { alias: { "@loopback/contracts": contracts } },
  define: { __LOOPBACK_DESIGN__: "true" },
  test: {
    name: "console",
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
