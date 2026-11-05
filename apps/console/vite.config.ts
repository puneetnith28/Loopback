import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const contracts = fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url));

/**
 * `__LOOPBACK_DESIGN__` is a BUILD-TIME constant (ECC vite-patterns: env is inlined at build).
 * Production builds (`vite build`, mode "production") set it to false, so the /design reference and every
 * demo fixture are tree-shaken out; dev and `--mode design` include them. Never a runtime toggle: a crafted
 * link must not be able to show demo "evidence" in a production console.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: { "@loopback/contracts": contracts } },
  define: { __LOOPBACK_DESIGN__: JSON.stringify(mode !== "production") },
  // Dev-server file access: this app, the shared contracts package and the hoisted dependencies only (not the
  // whole monorepo, which holds .env and secrets/).
  server: { fs: { allow: [".", "../../packages/contracts", "../../node_modules"] } },
  build: { sourcemap: false, target: "es2022" },
}));
