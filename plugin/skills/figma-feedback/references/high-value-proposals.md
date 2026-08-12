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

**Project scar — instance text patching (closed):**
Patching the text of N component instances once cost a `get_node(instance)` per instance to
parse the text-child id, then an `update_node` on that child. The consolidation shipped: a
TEXT property bound at definition time (`update_component`'s `add` with `targetNodeId`) turns
the whole chain into one `set_instance` per instance.

**Project scar — stat-card population (closed):**
Populating 4 stat-card instances took 12 `update_node` calls. `batch` now carries that chain
in one request — a generic multi-op envelope rather than a bulk text-specific tool.

---

## 2. Token Efficiency

**What it is:** Concise/detailed response modes, bounded/paginated scans, server-side
aggregation — anything that reduces the token cost of a common read path.

**Why it matters:** Expensive reads on large documents (e.g. a component scan walking every
instance in a 500-component file) can time out or exhaust the context. Bounded defaults and
targeted scopes make the tool usable on real documents.

**Project scar — component-scan timeout (closed):**
`get_components` used to walk every instance in the document on every call to discover remote
components; on a large production file it timed out live. Two fixes landed together — the
expensive scan became opt-in (`includeRemote` defaults to `false`) and the result list became
bounded (`limit` defaults to 100, `cursor` continues).

**Project scar — `inspect` verbosity (closed):**
`inspect` on a complex frame returned a deeply nested tree that flooded the context. It now
takes `depth` and a `budget` cap, and reports what it cut in `truncated[]`.

---

## 3. Actionable Errors — No Silent No-Ops

**What it is:** Replacing silent success (tool returns `ok` but nothing changed) or
unhelpful error messages with specific, actionable feedback that tells the agent exactly
what went wrong and what to do instead.

**Why it matters:** Silent no-ops are the worst failure mode for an agent — the agent
believes it succeeded and moves on. The error only surfaces (if at all) on read-back, by
which point the context has diverged. An actionable error would have stopped the mistake
at the source.

**Project scar — a size write against a locked node:**
A resize aimed at a locked frame returned a success result; nothing in Figma changed. The
agent proceeded, the build was wrong. Proposed: return `{ error: "node is locked — unlock it
first" }` so the agent can surface this to the user immediately.

**Project scar — `set_instance` text inertia (closed):**
`set_instance({ properties: { Label: "Revenue" } })` returned success; the instance text was
unchanged, because the TEXT property had never been bound to a text node. Closed upstream of
the symptom: `update_component` emits a `warnings[]` entry when a property is added without
`targetNodeId` ("…it is unbound and set_instance will be inert").

---

## 4. Missing Capability / CRUD Symmetry

**What it is:** A `create_*` with no matching `delete_*`; a missing arg that forces a
multi-step workaround; a Figma API the bridge doesn't expose at all.

**Why it matters:** CRUD asymmetry forces the agent to leave state behind it can't clean
up, and missing args force workarounds that break on edge cases.

**Project scars** — four asymmetries the agent hit; three have since shipped:

- `create_variables` / `create_styles` had no `delete_*` twin, so the agent could not clean
  up a token it created by mistake. Closed — `delete_variables` / `delete_styles` ship.
- `update_component` could `add` a TEXT property but not bind it to a node, leaving the add
  half-formed. Closed — the `add` entry takes `targetNodeId`.
- `boolean_op` (union, subtract, intersect, exclude) was absent, so combining vectors meant
  leaving for the Figma UI. Closed — `boolean_op` ships.
- Pages could be listed (`list_pages`) and switched (`set_current_page`) but not created or
  removed. Half-closed — `create_page` and `duplicate_page` ship; there is still no
  `delete_page`, so the agent can add pages it cannot remove.

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
`get_node` on an INSTANCE returns `component: { id }` (or `{ key }` for a library main) — an
opaque handle, never the component's name. A `name` alongside it would let the agent verify it
instantiated the right component without a follow-up `get_components` call.

---

## 6. Round-Trip Fidelity

**What it is:** What you create reads back losslessly — the read response reflects the
write state accurately, including variable bindings, instance types, style references, and
node structure.

**Why it matters:** The agent's verification discipline (`export` + `get_node` read-back)
only works if read-back is faithful. A lossy read-back means the agent can't tell success
from silent failure, and the verification step gives false confidence.

**Project scar — variable binding read-back (closed):**
After `bind_variable` on a fill, `get_node` showed a bare hex, so the agent could not confirm
the bind without the more expensive `inspect`. Closed: the read-back now carries the
`var(token/name)#RRGGBB` wrapper, so one cheap read proves the binding.

**Project scar — style reference in text nodes (closed):**
After `apply_style` on a text node, `get_node` returned font/size/color as raw values and the
style name wasn't visible until `inspect`. Closed: the `font` atom reads back as
`style(Name)font(…)`.

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
- **`sizing` default (closed):** a frame in auto-layout mode defaulted to `HUG` and collapsed
  when empty, so nearly every frame the agent created needed an explicit
  `sizing: ['FIXED', 'FIXED']`. Closed: a create that states `size` and no `layout` is pinned
  `['FIXED', 'FIXED']` for you.
- **Node id in create responses:** `create_node`, `create_tree`, and every other create return
  the new node's id. This is already correct — flagged here as a positive example. Do not
  regress: if a create tool ever stops returning the id, file it as a least-surprise
  regression.
- **`inspect` on selection (closed):** `get_selection` once returned bare ids, so the agent
  followed it with an `inspect` per node. Closed twice over: `get_selection` returns
  `{ id, name, type }` per node, and `inspect` with no `nodeId`/`pageId` reads the current
  selection directly — the common case is one call, not N+1.
