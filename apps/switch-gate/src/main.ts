import { ConfigError, loadGitHubConfig, loadIdentityConfig, loadRuntimeConfig, loadSwitchConfig } from "./config.js";
import { createLogger } from "./observability/logger.js";

// Entry point (`npm run gate`). Startup order: validate config -> open and migrate the
// database -> reconcile interrupted merges -> start polling -> connect to Switch.
//
// The Switch transport depends on the protocol of the installed Switch version (plan
// Phase 3, decisions D22/D23) and has not been implemented or verified yet, so the gate
// refuses to start instead of running without a chat connection.

const log = createLogger(process.env.LOG_LEVEL ?? "info");

function main(): number {
  try {
    loadRuntimeConfig(process.env);
    loadSwitchConfig(process.env);
    loadIdentityConfig(process.env);
    loadGitHubConfig(process.env);
  } catch (e) {
    log.fatal({ op: "config" }, e instanceof ConfigError ? e.message : "configuration could not be loaded");
    return 1;
  }
  log.fatal(
    { op: "startup", result: "refused" },
    "Switch transport is not available for this installation yet (see docs/operations.md). The gate will not start without a verified chat connection.",
  );
  return 2;
}

process.exitCode = main();
