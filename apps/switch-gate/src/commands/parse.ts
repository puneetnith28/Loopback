import { Command, type CommandKind } from "@loopback/contracts";

export type ParseResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly error: string };

/** One usage line per command; help shows only the lines the sender may use (D27). */
export const USAGE_LINES: Readonly<Record<CommandKind, string>> = {
  help: "help",
  whoami: "whoami",
  report: "report <description of the bug>",
  status: "status <LB-nnn>",
  why: "why <LB-nnn>",
  board: "board",
  team: "team",
  audit: "audit <LB-nnn>",
  accept: "accept <LB-nnn>",
  decline: "decline <LB-nnn> <reason>",
  verify: "verify <LB-nnn>",
  approve: "approve <LB-nnn> <full 40-character commit sha>",
  reject: "reject <LB-nnn> <reason>",
  merge: "merge <LB-nnn>",
  retask: "retask <LB-nnn> <note>",
};

/** Usage for exactly these commands, in a fixed order. */
export function usageFor(kinds: readonly CommandKind[]): string {
  const allowed = new Set(kinds);
  return (Object.keys(USAGE_LINES) as CommandKind[]).filter((k) => allowed.has(k)).map((k) => USAGE_LINES[k]).join("\n");
}

/** Full usage, for maintainers. */
export const USAGE = usageFor(Object.keys(USAGE_LINES) as CommandKind[]);

const VERBS: ReadonlySet<string> = new Set<CommandKind>(Object.keys(USAGE_LINES) as CommandKind[]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

/**
 * Parse an addressed message into a command. The grammar is closed: anything
 * outside it is rejected with usage. Nothing here executes anything; the body
 * is untrusted data and is only matched against fixed patterns.
 */
export function parseCommand(body: string, gateMention: string): ParseResult {
  const trimmed = body.trim();
  const mention = new RegExp(`^${escapeRegex(gateMention)}(?![A-Za-z0-9._-])[:,]?\\s*`, "i");
  const m = mention.exec(trimmed);
  if (!m) return fail("message does not start with the gate mention");
  const rest = trimmed.slice(m[0].length);

  const verbMatch = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (!verbMatch) return fail("missing command");
  const rawVerb = verbMatch[1]!;
  if (!/^[A-Za-z]{1,16}$/.test(rawVerb)) return fail("unknown command");
  const verb = rawVerb.toLowerCase();
  const args = verbMatch[2]!.trim();
  if (!VERBS.has(verb)) return fail(`unknown command "${verb.slice(0, 32)}"`);

  const tokens = args.length > 0 ? args.split(/\s+/) : [];
  const caseId = (t: string | undefined) => (t ?? "").toUpperCase();

  let candidate: unknown;
  switch (verb as CommandKind) {
    case "help":
    case "whoami":
    case "board":
    case "team":
      if (tokens.length > 0) return fail(`${verb} takes no arguments`);
      candidate = { kind: verb };
      break;
    case "report":
      candidate = { kind: "report", text: args };
      break;
    case "status":
    case "why":
    case "verify":
    case "merge":
    case "audit":
    case "accept":
      if (tokens.length !== 1) return fail(`${verb} takes exactly one case id`);
      candidate = { kind: verb, caseId: caseId(tokens[0]) };
      break;
    case "approve":
      if (tokens.length !== 2) return fail("approve takes a case id and the full commit sha");
      // Canonical SHAs only: never normalise case; FullSha rejects anything else.
      candidate = { kind: "approve", caseId: caseId(tokens[0]), sha: tokens[1]! };
      break;
    case "reject": {
      const [id, ...reason] = tokens;
      candidate = { kind: "reject", caseId: caseId(id), reason: reason.join(" ") };
      break;
    }
    case "decline": {
      const [id, ...reason] = tokens;
      candidate = { kind: "decline", caseId: caseId(id), reason: reason.join(" ") };
      break;
    }
    case "retask": {
      const [id, ...note] = tokens;
      candidate = { kind: "retask", caseId: caseId(id), note: note.join(" ") };
      break;
    }
  }

  const parsed = Command.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`invalid ${verb}: ${issue ? `${issue.path.join(".") || "input"} ${issue.message}` : "bad arguments"}`);
  }
  return { ok: true, command: parsed.data };
}
