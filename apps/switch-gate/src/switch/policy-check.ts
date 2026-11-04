import { z } from "zod";

/**
 * Startup self-check of the gate's Switch addressing policy (switch-core 0.31.0).
 *
 * Message admission trusts `addressed === true` only because Switch sets it after
 * its own policy admits the sender. That is a guarantee only while the policy is the
 * restrictive one Loopback expects, so the gate refuses to start unless the live
 * policy matches it exactly. Read with the gate's own key through
 * `POST /agents/{id}/ops/get_agent_detail` (returns `addressing_policy`; verified
 * live 2026-11-03). Rule semantics (server source switch_core/addressing.py):
 * fields within a rule are ANDed, rules are ORed, `"*"` admits anything, a list
 * admits only its members, and no rules at all means open to anyone.
 */

export interface PolicyExpectation {
  readonly roomId: string;
  /** ExternalUser ids of the people who may address the gate. */
  readonly userIds: ReadonlySet<string>;
  /** Switch agent ids of the fixer and verifier. */
  readonly agentIds: ReadonlySet<string>;
}

/** `unreadable`: the policy could not be read (network, HTTP, body), as opposed to read and wrong. */
export type PolicyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly unreadable: boolean };

const Rule = z.strictObject({
  rooms: z.union([z.literal("*"), z.array(z.string())]),
  room_groups: z.union([z.literal("*"), z.array(z.string())]),
  users: z.union([z.literal("*"), z.array(z.string())]),
  agents: z.union([z.literal("*"), z.array(z.string())]),
  owner: z.boolean(),
  owner_agents: z.boolean(),
  platform: z.boolean(),
});
const Detail = z.object({
  result: z.object({
    id: z.string(),
    addressing_policy: z.unknown(),
  }),
});

const fail = (reason: string): PolicyCheck => ({ ok: false, reason, unreadable: false });
const unreadable = (reason: string): PolicyCheck => ({ ok: false, reason, unreadable: true });

function sameSet(actual: readonly string[], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && new Set(actual).size === actual.length && actual.every((x) => expected.has(x));
}

/** Compare a policy (as Switch returns it) with the expectation. Pure. */
export function checkPolicy(policy: unknown, expected: PolicyExpectation): PolicyCheck {
  if (policy === null || policy === undefined) return fail("the policy is open to anyone (no policy set)");
  const parsed = z.strictObject({ rules: z.array(Rule) }).safeParse(policy);
  if (!parsed.success) return fail("the policy has an unexpected shape");
  const rules = parsed.data.rules;
  if (rules.length === 0) return fail("the policy has no rules, which Switch treats as open to anyone");
  if (rules.length !== 1) return fail(`the policy has ${rules.length} rules; exactly one is expected`);
  const r = rules[0]!;
  if (r.rooms === "*" || !sameSet(r.rooms, new Set([expected.roomId]))) return fail("rooms must be exactly the gate's room");
  if (r.room_groups !== "*") return fail('room_groups must be "*" (rooms already restrict it)');
  if (r.users === "*" || !sameSet(r.users, expected.userIds)) return fail("users must be exactly SWITCH_POLICY_USER_IDS");
  if (r.agents === "*" || !sameSet(r.agents, expected.agentIds)) return fail("agents must be exactly SWITCH_POLICY_AGENT_IDS");
  if (r.owner) return fail("owner must be false");
  if (r.owner_agents) return fail("owner_agents must be false (it admits every agent of the gate's owner)");
  if (r.platform) return fail("platform must be false");
  return { ok: true };
}

export interface PolicyReadOptions {
  readonly bridgeUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/** Read the gate's own policy and check it. Any failure to read it is a failed check. */
export async function verifyAddressingPolicy(o: PolicyReadOptions, expected: PolicyExpectation): Promise<PolicyCheck> {
  const url = `${o.bridgeUrl.replace(/\/+$/, "")}/agents/${encodeURIComponent(o.agentId)}/ops/get_agent_detail`;
  let res: Response;
  try {
    res = await o.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: o.agentId }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e) {
    return unreadable(`could not read the policy (${e instanceof Error ? e.name : "unknown"})`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return unreadable(`could not read the policy (HTTP ${res.status})`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return unreadable("the policy response is not JSON");
  }
  const detail = Detail.safeParse(json);
  if (!detail.success) return fail("the policy response has an unexpected shape");
  if (detail.data.result.id !== o.agentId) return fail("the policy response describes a different agent");
  return checkPolicy(detail.data.result.addressing_policy, expected);
}
