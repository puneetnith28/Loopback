import { GATE_SETTINGS_KEY, GateSettings } from "@loopback/contracts";
import type { Db } from "./db.js";
import { kvSet } from "./repos.js";

/**
 * Record the gate's non-secret settings, so the read-only console shows how this gate really runs instead of
 * guessing. Called each time the gate starts. Validated first, so nothing outside the allowlist is stored.
 */
export function recordGateSettings(db: Db, settings: GateSettings): void {
  kvSet(db, GATE_SETTINGS_KEY, JSON.stringify(GateSettings.parse(settings)));
}
