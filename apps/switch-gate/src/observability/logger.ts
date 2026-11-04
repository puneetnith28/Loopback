import { pino, type DestinationStream, type Logger } from "pino";

/** Paths pino removes before writing (implementation §10.12). Values are never logged. */
export const REDACT_PATHS = [
  "authorization", "*.authorization", "headers.authorization", "*.headers.authorization",
  "token", "*.token", "apiKey", "*.apiKey", "api_key", "*.api_key",
  "privateKey", "*.privateKey", "privateKeyPem", "*.privateKeyPem", "password", "*.password",
  "secret", "*.secret", "reportText", "*.reportText", "body", "*.body",
];

/**
 * Structured JSON logger. Standard fields used across the gate:
 * caseId, eventId, op, stateFrom, stateTo, repo, pr, sha, result, reasonCode, durationMs, retry.
 * Report text and message bodies are untrusted and are never logged in full.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "loopback-gate" },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}
