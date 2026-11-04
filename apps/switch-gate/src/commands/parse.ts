import { Command, type CommandKind } from "@loopback/contracts";

export type ParseResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly error: string };

export const USAGE = [
  "help | whoami",
  "report <description of the bug>",
  "status <LB-nnn> | audit <LB-nnn>",
  "verify <LB-nnn>",
  "approve <LB-nnn> <full 40-character commit sha>",
  "reject <LB-nnn> <reason>",
  "merge <LB-nnn>",
  "retask <LB-nnn> <note>",
].join("\n");

const VERBS: ReadonlySet<string> = new Set<CommandKind>([
  "help", "whoami", "report", "status", "verify", "approve", "reject", "merge", "audit", "retask",
]);

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
      if (tokens.length > 0) return fail(`${verb} takes no arguments`);
      candidate = { kind: verb };
      break;
    case "report":
      candidate = { kind: "report", text: args };
      break;
    case "status":
    case "verify":
    case "merge":
    case "audit":
      if (tokens.length !== 1) return fail(`${verb} takes exactly one case id`);
      candidate = { kind: verb, caseId: caseId(tokens[0]) };
      break;
    case "approve":
      if (tokens.length !== 2) return fail("approve takes a case id and the full commit sha");
      candidate = { kind: "approve", caseId: caseId(tokens[0]), sha: tokens[1]!.toLowerCase() };
      break;
    case "reject": {
      const [id, ...reason] = tokens;
      candidate = { kind: "reject", caseId: caseId(id), reason: reason.join(" ") };
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
