import { safe } from "../chat/reasons.js";

// "Presence isn't availability" (Switch docs): an agent can sit in a room with nothing running, and a
// task addressed to it then waits in silence. This reports what Switch says about each agent, and
// names the ones that are not there. It is advice to people only: no decision depends on it.

/** Agent name -> status, as Switch reports it for this room. Null when Switch could not be asked. */
export type RoomStatuses = () => Promise<ReadonlyMap<string, string> | null>;

/** Statuses meaning a task addressed to the agent will not be picked up. Others are shown as reported. */
const ABSENT: ReadonlySet<string> = new Set(["disconnected", "offline", "stopped"]);

export const isAbsent = (status: string): boolean => ABSENT.has(status.toLowerCase());

/** An agent's name from its mention. */
export const agentName = (mention: string): string => mention.replace(/^@/, "");

export function renderTeam(names: readonly string[], statuses: ReadonlyMap<string, string> | null): string {
  if (statuses === null) return "Could not ask Switch about the agents in this room just now. Try again shortly.";
  const rows = names.map((name) => {
    const status = statuses.get(name);
    if (status === undefined) return `❌ ${safe(name)}: not in this room. Invite it from Switch Console.`;
    return isAbsent(status)
      ? `⚠️ ${safe(name)}: ${safe(status, 40)}. A task sent to it will wait; start its session in Switch Console.`
      : `✅ ${safe(name)}: ${safe(status, 40)}`;
  });
  return [
    "Agents in this room, as Switch reports them right now:",
    ...rows,
    "Live means connected. It can't show whether an agent's model has quota left, so a silent agent may still be stuck.",
  ].join("\n");
}

/** A one-line warning when an agent that was just tasked is not there, or null when all is well. */
export function absenceNotice(name: string, statuses: ReadonlyMap<string, string> | null): string | null {
  if (statuses === null) return null;
  const status = statuses.get(name);
  if (status === undefined) return `⚠️ ${safe(name)} is not in this room, so this task will wait. Invite it from Switch Console.`;
  return isAbsent(status) ? `⚠️ ${safe(name)} is ${safe(status, 40)} in this room, so this task will wait. Start its session in Switch Console.` : null;
}
