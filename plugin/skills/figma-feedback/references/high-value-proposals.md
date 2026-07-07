---
title: High-Value Proposal Categories
description: Eight categories of high-value proposals for the figma-agent-bridge MCP surface, grounded in Anthropic's writing-effective-tools guidance and this project's own scars.
---

# High-Value Proposal Categories

Load this reference when composing a proposal — use it to sharpen the category label in
the `**Opportunity:**` line and to judge whether a proposal clears the litmus.

The eight categories are grounded in Anthropic's *Writing effective tools for AI agents*
guidance and this project's own accumulated scars. They are ordered from highest to lowest
agent-pain multiplier.

---

## 1. Workflow Consolidation

**What it is:** Collapsing a repeated A→B→C chain into one tool call or one new arg.
The shortcut shape (see `SKILL.md`) is the canonical form.

**Why it matters:** Multi-step chains multiply token usage, introduce ordering hazards,
and produce more failure points. One call is faster, cheaper, and harder to get wrong.

**Project scar — instance text patching:**
Today, patching the text of N component instances requires:
1. `get_node(instance)` — parse the text-child id from the response.
2. `update_node(childId, { content, font, color })` — full patch required; text-only errors on `raw.trim`.
Repeat N times. Proposed consolidation: `set_instance({ instanceId, text: { "label": "…" } })` —
one call per instance, the server resolves the child id internally.

**Project scar — stat-card population:**
Populating 4 stat-card instances took 12 `update_node` calls. A `set_multiple_text_contents`
bulk tool (or a `text` arg on `set_instance`) collapses that to 4 or even 1.

---

## 2. Token Efficiency

**What it is:** Concise/detailed response modes, bounded/paginated scans, server-side
aggregation — anything that reduces the token cost of a common read path.

**Why it matters:** Expensive reads on large documents (e.g., `get_local_components` scanning
all instances in a 500-component file) can time out or exhaust the context. Bounded defaults
and targeted scopes make the tool usable on real documents.

**Project scar — `get_local_components` scan timeout:**
`get_local_components` re-scans all instances across the entire document on every call. On a
large production file it timed out in a live session. Proposed fix: a default `limit` param
and a paginated `cursor` so partial results are useful rather than a timeout with nothing.

**Project scar — `inspect` verbosity:**
`inspect` on a complex frame returns a deeply nested tree that can flood the context. A
`depth` param (already present on some tools) and a `budget` cap (token budget for the
response) would let the agent trade coverage for cost on expensive nodes.

---

## 3. Actionable Errors — No Silent No-Ops

**What it is:** Replacing silent success (tool returns `ok` but nothing changed) or
unhelpful error messages with specific, actionable feedback that tells the agent exactly
what went wrong and what to do instead.

**Why it matters:** Silent no-ops are the worst failure mode for an agent — the agent
believes it succeeded and moves on. The error only surfaces (if at all) on read-back, by
which point the context has diverged. An actionable error would have stopped the mistake
at the source.

**Project scar — `resize_node` on a locked node:**
`resize_node` called on a locked frame returned a success result; nothing in Figma changed.
The agent proceeded, the build was wrong. Proposed: return `{ error: "node is locked —
unlock it first" }` so the agent can surface this to the user immediately.

**Project scar — `set_instance` text inertia:**
`set_instance({ properties: { Label: "Revenue" } })` returned success; the instance text
was unchanged (the TEXT property was never bound to a text node). Proposed: detect the
unbound state and return `{ error: "TEXT property 'Label' is not bound to a text node —
use update_node on the compound child id I<inst>;<masterText> instead" }`.

---

## 4. Missing Capability / CRUD Symmetry

**What it is:** A `create_*` with no matching `delete_*`; a missing arg that forces a
multi-step workaround; a Figma API the bridge doesn't expose at all.

**Why it matters:** CRUD asymmetry forces the agent to leave state behind it can't clean
up, and missing args force workarounds that break on edge cases.

**Project scars:**
- `create_variables` / `create_styles` exist; `delete_variables` / `delete_styles` do not.
  The agent cannot clean up a token it created by mistake.
- `update_component` can `add` a TEXT property but cannot bind it to a node — the add is
  half-formed without a separate bind capability.
- No `create_page` / `delete_page` in the current surface (though `list_pages` /
  `set_current_page` exist) — the agent can't reorganize the document structure.
- No `boolean_op` (union, subtract, intersect, exclude) — vector combination requires a
  workaround via the Figma UI.

---

## 5. Semantic Identifiers Over Low-Level Handles

**What it is:** Exposing names the agent can reason about instead of opaque numeric or
compound ids — or returning the name/path alongside the id so the agent doesn't have to
resolve it separately.

**Why it matters:** Opaque ids force a lookup round-trip to establish context. The agent
can't audit its own output ("did I update the right node?") without a readable name.
Semantic ids also make repro steps in bug reports human-scannable.

**Project scar — compound child id format:**
The instance text-child id `I<instanceId>;<masterTextNodeId>` is deterministic but
undocumented. The agent had to discover it empirically. Proposed: document it formally in
the `inspect` response and teach it in `figma-design/references/mechanics.md` so future
agents don't repeat the discovery cost.

**Project scar — component resolution:**
`get_node` on an INSTANCE returns `componentId` (opaque UUID), not the component name.
A `componentName` field alongside `componentId` in the response would let the agent verify
it instantiated the right component without a follow-up `get_local_components` call.

---

## 6. Round-Trip Fidelity

**What it is:** What you create reads back losslessly — the read response reflects the
write state accurately, including variable bindings, instance types, style references, and
node structure.

**Why it matters:** The agent's verification discipline (`export` + `get_node` read-back)
only works if read-back is faithful. A lossy read-back means the agent can't tell success
from silent failure, and the verification step gives false confidence.

**Project scar — variable binding read-back:**
After `bind_variable` on a fill, `get_node` showed the fill color as a hex value, not as
`var(--token-name)`. The agent couldn't confirm the bind succeeded without `inspect`, which
is more expensive. Proposed: `get_node` fill response includes `{ hex: "…", variable: "…" }`
when a variable is bound, matching the `inspect` response.

**Project scar — style reference in text nodes:**
After `apply_style` on a text node, `get_node` returned font/size/color as raw values, not
as a style reference. The style name wasn't visible until `inspect`. Proposed: include
`textStyleId` and `textStyleName` in the `get_node` text node response.

---

## 7. Reliability Guards / Drift Detection

**What it is:** Checks that surface mismatches before they cause silent drift — version
assertions, state-precondition checks, idempotency guards.

**Why it matters:** An agent that successfully applies a change, but to the wrong version
of a node, produces a result that looks correct until the user looks closely. Fail loudly
at the point of mismatch, not silently later.

**Project scar — stale node reference:**
When `update_node` is called on a node whose parent has been restructured since the last
`inspect`, the call may succeed on a node that no longer exists in the expected position.
Proposed: an optional `parentId` param that the server asserts before mutating — a cheap
precondition check that would have caught several agent mistakes in live sessions.

**Project scar — component master mutation:**
`update_component` on a master silently propagates to all instances. An agent editing what
it believed was an instance may have accidentally mutated the master. Proposed: include
a `"WARNING: this is a master component — changes will propagate to N instances"` in the
success result so the agent can surface the side-effect to the user.

---

## 8. Least-Surprise Defaults

**What it is:** Right behaviour without incantations — default values that match the most
common case, automatically applied behaviours the agent would always want, and tool
responses that include what the agent always needs next.

**Why it matters:** Incantation-required defaults (e.g., must always pass
`sizing: ['FIXED', 'FIXED']` to prevent a frame from collapsing) are invisible failure
modes. Every time the agent forgets, the result is silently wrong. The right default costs
the caller nothing.

**Project scars:**
- **`sizing` default:** `create_frame` defaults to `HUG` sizing in auto-layout mode, which
  collapses frames with no content. Nearly every frame the agent creates needs
  `sizing: ['FIXED', 'FIXED']`. Proposed default: `FIXED` when explicit `width`/`height`
  are passed, so the agent only overrides when it wants HUG.
- **Node id in create responses:** `create_frame`, `create_text`, and similar tools return
  the new node's id. This is already correct — flagged here as a positive example. Do not
  regress: if a create tool ever stops returning the id, file it as a least-surprise
  regression.
- **`inspect` on selection:** `get_selection` returns ids but not node summaries. The agent
  almost always follows `get_selection` with `inspect` on each selected node. Proposed:
  `get_selection` includes a brief `{ id, name, type }` per node so the common case needs
  one call, not N+1.
