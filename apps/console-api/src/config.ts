// Configuration of the console API. It has its own settings on purpose: it must be able to run
// without any of the gate's credentials, and it refuses to start if it is handed them.

export interface ConsoleConfig {
  readonly dbPath: string;
  readonly port: number;
  readonly token: string;
  /** The exact browser origin allowed by CORS, e.g. http://localhost:5173. Null: no CORS. */
  readonly allowedOrigin: string | null;
  readonly gatePort: number;
}

export class ConsoleConfigError extends Error {}

/** The gate's and agents' credentials. Their presence means this process got the wrong environment. */
const FORBIDDEN = /^(GH_APP_PRIVATE_KEY_PATH|GH_TOKEN|GITHUB_TOKEN|SWITCH_AGENT_API_KEY|SWITCH_REGISTRATION_KEY|LOOPBACK_RUN_ISSUER_KEY_PATH|SIGNER_[A-Z_]+)$/;
const MIN_TOKEN_LENGTH = 32;

function port(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConsoleConfigError(`${name} must be a port number`);
  return n;
}

export function loadConsoleConfig(env: Readonly<Record<string, string | undefined>>): ConsoleConfig {
  const leaked = Object.keys(env).filter((k) => FORBIDDEN.test(k) && env[k]);
  if (leaked.length > 0) {
    throw new ConsoleConfigError(`refusing to start with credentials in the environment (${leaked.join(", ")}); this API must not hold them. Start it with its own env file, not the gate's .env.`);
  }
  const dbPath = env.CONSOLE_DB_PATH ?? "";
  if (dbPath === "") throw new ConsoleConfigError("CONSOLE_DB_PATH is required: the gate's database file");
  const token = env.CONSOLE_API_TOKEN ?? "";
  if (token.length < MIN_TOKEN_LENGTH) throw new ConsoleConfigError(`CONSOLE_API_TOKEN is required, at least ${MIN_TOKEN_LENGTH} characters`);
  const origin = env.CONSOLE_ALLOWED_ORIGIN ?? "";
  if (origin === "*") throw new ConsoleConfigError("CONSOLE_ALLOWED_ORIGIN must be one exact origin, not *");
  if (origin !== "") {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new ConsoleConfigError("CONSOLE_ALLOWED_ORIGIN must be an origin such as http://localhost:5173"); }
    if (parsed.origin !== origin) throw new ConsoleConfigError("CONSOLE_ALLOWED_ORIGIN must be an origin such as http://localhost:5173");
  }
  return {
    dbPath,
    token,
    port: port(env.CONSOLE_API_PORT, 8788, "CONSOLE_API_PORT"),
    gatePort: port(env.CONSOLE_GATE_HTTP_PORT, 8787, "CONSOLE_GATE_HTTP_PORT"),
    allowedOrigin: origin === "" ? null : origin,
  };
}
