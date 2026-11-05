# Loopback Console — Design Contract

The checkable contract every screen and component is built against (ECC `frontend-design-direction`,
`design-system`). Tokens live in `src/design-system/tokens.css`; this file records the decisions and why.

## 1. Product surface

| | |
|---|---|
| Concept | **The Evidence Ledger** |
| Job | Decide whether an AI-generated fix has enough trustworthy evidence to deserve a human's approval. |
| Audience | Open-source maintainers and engineering teams who return daily and scan before they read. |
| Primary action | Inspect evidence, then approve **in Switch** (the console shows the exact command; it never approves). |
| Scan order | 1. case state and whether the commit seal holds · 2. who/what produced each fact (provenance) · 3. next action |
| Tone | Precise, technical, calm, trustworthy; information-dense without clutter. An instrument panel crossed with an audit ledger. |
| Target viewports | `390x844` (phone), `1440x900` (desktop); tablet layouts must not break between them. |

## 2. The memorable detail

1. **Provenance stamps.** Every important fact can name its source and trust level, always with icon + text:
   GitHub (observed by the gate) · Gate (policy decision) · Signed verifier · Agent claim (unverified) · DEMO.
2. **The Loop (StateTrack).** A case's lifecycle drawn as one compact track over the 14 contract states, with
   the commit **seal**: evidence is bound to a full SHA, and when the head moves the seal visibly breaks — earlier
   verification is never shown as applying to the new commit.

## 3. Visual system

- **Dark-first graphite** (canvas → surface → raised → overlay), with an independently tuned **light "paper" theme**
  (warm off-white, not an inversion).
- **Semantic hues, each with one meaning:** cyan = machine activity · amber = human action / awaiting a human ·
  green = verified · red-orange = failed or blocked · rose + hatch = DEMO. Neutral greys carry everything else.
  No purple, no gradients-as-decoration, no glow.
- **Status is never colour alone:** icon + label everywhere; colour is the third cue.
- **Type:** IBM Plex Sans (interface) and IBM Plex Mono (SHAs, case ids, identifiers, numbers), self-hosted from
  local assets. 14px base for a dense tool; tabular numerals for anything that counts or updates.
- **Space:** 4px base scale. **Radius:** small (4–10px), concentric (outer = inner + padding). Borders separate,
  shadows only for elevated layers (popovers, dialogs).
- **Motion:** CSS transitions from motion tokens, `transform`/`opacity` only, never `transition: all`; exits shorter
  than enters; `prefers-reduced-motion` removes movement entirely. Motion only to communicate state or preserve
  continuity (ECC `motion-foundations`).

## 4. Content states (every data-dependent component)

| State | Trigger | Visible feedback | Safe next action |
|---|---|---|---|
| Loading | request in flight | skeleton in the final layout (no shift), `aria-busy` | wait; nothing to click |
| Empty | request succeeded, nothing to show | what is absent and why | the relevant next step |
| Error | request failed | what failed, in plain words, no raw payloads | retry, or where to look |
| Partial | some sources failed | the available data plus a notice naming what is missing | retry the missing part |
| Success | data available | the data, each fact stamped with provenance | the primary action |
| Permission | access boundary | which boundary, without leaking what is behind it | how to request access |

## 5. Trust and safety rules (non-negotiable)

- No fabricated data. Demonstration content exists only in the design reference, is always marked **DEMO**, and
  is excluded from production builds (verified by a build test).
- Untrusted text (issue reports, agent output, logs, audit payloads, branch names) renders as plain text; hidden
  bidi/zero-width characters are made visible; no HTML rendering, no `dangerouslySetInnerHTML`.
- The console has no write path: no approve, reject, merge or privileged call. The approval command is shown only
  when evidence for the current head exists.
- No secrets in `VITE_` variables; no GitHub credentials in the browser; no external font/CDN requests.

## 6. Anti-patterns (rejected)

Generic SaaS dashboard templates · purple "AI" gradients · glassmorphism · glowing borders · cards inside cards ·
oversized decorative cards · decorative charts · fake statistics or activity · emoji icons · `transition: all` ·
colour-only status · placeholder-as-label · positive `tabIndex`.
