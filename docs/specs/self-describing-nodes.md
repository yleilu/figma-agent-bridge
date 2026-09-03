---
title: Self-Describing Nodes — Naming, Description & Context
created: 2026-07-08T16:23:32+08:00
tags:
  - spec
  - figma-bridge
  - context
  - naming
type: spec
related:
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/reference/api-coverage]]"
---

# Self-Describing Nodes — Naming, Description & Context

## Purpose

A Figma design should explain itself. This spec adds **three legibility surfaces** so an agent —
or a human opening the file — can understand what any node is, and how to treat it, **in the read
they are already doing**, with no second call:

| Surface | Visibility | Applies to | Mechanism |
|---|---|---|---|
| **Name** | Visible (layer panel) | Every node | `node.name` — skill discipline + reviewer audit |
| **Description** | Visible (assets panel) | Component / component-set / style | `node.description` — surfaced on the asset reads |
| **Context** | Hidden (structured note) | Any node | A round-trippable `NodeSpec` field, stored in shared `pluginData` |

Naming is the *visible* label; context is the *hidden* structured intent that travels with the
node; description is the *visible* rationale on reusable assets. Together a node carries a single,
non-contradictory story.

## Motivation — the current gaps

1. **`pluginData` is wired but never surfaced.** `get_plugin_data` / `set_plugin_data` work
   end-to-end, but no general read returns a node's plugin data — `JSON_REST_V1` omits it — so an
   agent must make a *second* call per node to learn its context. That second call is what this
   spec removes.
2. **`description` is write-only.** It is writable via `create_component` / `update_component` and
   the style tools, but no read returns it — `get_components` emits only `{id, name, key, type,
   page, …}`. The human-facing docs that already exist are invisible to agents.
3. **Default names.** Nodes ship as `Frame 12` / `Rectangle 3`, leaving the layer panel unreadable.

## Principle alignment

No principle changes. This spec is consistent with `docs/principles.md`:

- **T1 — clean symmetric facade.** Context reuses the existing `get_plugin_data` /
  `set_plugin_data` pair for low-level access and is surfaced as a `NodeSpec` field whose write
  side is `create_node` / `update_node` — the same round-trip anchor every editable concept uses.
  No rival "context" tool, no new command.
- **T2 — round-trip fidelity.** `context` **round-trips**: `get_node` returns it and
  `create_node` / `update_node` write it, so a read-modify-write or a clone preserves it (and it
  survives Figma clone/duplicate natively, because `pluginData` travels with the node). The one
  bounded exception — a value stored **above the 2 KB cap**, reachable only via the raw
  `set_plugin_data` escape hatch or external tooling (the store is shared) — is a **declared
  read-only, non-round-trippable state** (see *Size*), not a silent gap. `description` round-trips
  through its own twins (`get_components` ↔ `create_component` / `update_component`; `get_styles` ↔
  `create_styles` / `update_styles`) — the read-many/write-one naming pair documented under D5.
- **T3 — node view vs edit formats.** `context` is a `NodeSpec` field, so the **full** value appears
  in the edit form (`get_node` / `get_nodes`, round-trips); the **view/list** readers (`inspect`,
  `search`, `get_components`) surface a compact, read-only **`contextSummary`** (the frontmatter
  slice) under a **distinct field name**, so a summary can never be mistaken for — or written back
  as — the round-trippable value. `description` is surfaced read-only on the asset reads, written
  via its twins.
- **T4 — token efficiency.** The full `context` rides only the fidelity readers (`get_node` /
  `get_nodes`) and is bounded by the 2 KB per-field cap; every view/list reader (`inspect`,
  `search`, `get_components`) carries only `contextSummary`, itself capped at
  `CONTEXT_SUMMARY_MAX_BYTES` — never an unbounded per-node inline.
- **T6 — possible + useful, no opinions.** Context is *data*. The generic `set_plugin_data` stays
  unopinionated (it enforces only Figma's real limit); the 2 KB cap is validation on the typed
  `context` field, not an opinion baked into a generic tool.
- **T7 — honest capability.** `create_node` / `update_node` reject an oversized `context` with a
  clean structured error. An over-cap value (only reachable via the escape hatch) is returned
  faithfully by the fidelity readers; its non-round-trippability surfaces honestly as that same
  rejection on write-back — no silent truncation. The write degrades with a warning on the rare
  node types that lack plugin-data support rather than throwing.
- **T8 — one expression grammar.** `context` is a `NodeSpec` node-struct **metadata field** (a
  field, not an atom); landing it adds it to `expression-formats.md`'s node struct as a
  round-tripping field — see *Sibling specs*.
- **T10 — bounded by default.** Fidelity reads are bounded by `depth` and the 2 KB per-field cap;
  `inspect` by its budget; `search` / `get_components` by their `limit` — and `contextSummary`
  keeps per-entry cost small.
- **P1 — what ships vs what the user customizes.** The size cap is data validation. Naming
  **discipline** (name every node meaningfully at creation) and the basic component-first /
  design-system-first workflow ship as the professional **floor** in `figma-design`; the concrete
  naming **convention** (PascalCase, the `/` taxonomy, semantic-text rules) and any
  stricter-than-basic standard are **user preferences** in `figma-bridge-prefs`, not a single
  shipped bucket — see [[figma-bridge/docs/specs/customization|customization.md]]. *What* to record
  as context, and the markdown *structure* (required `purpose`, the `status` enum, the fixed
  sections), stay advisory skill-layer convention, not server-enforced.
- **B2 — versioned and compatible.** An optional `NodeSpec` field plus `description` on the asset
  reads are additive and backward-compatible; no new command; `get_plugin_data` / `set_plugin_data`
  are reused verbatim.

---

## Surface 1 — Naming

Naming is entirely plugin-layer: the tools already accept `name` on every create. This surface
adds **no code, no tool, and no version bump** — the rules live in the `figma-design` skill and the
audit lives in the `figma-reviewer` agent. The design facts:

- **Discipline, not tooling.** Agents name every node meaningfully at creation; there is no
  server-side enforcement. The **basic** naming discipline — name every node meaningfully — and the
  component-first practice ship as the professional **floor** in the `figma-design` skill. The
  concrete **convention** (descriptive PascalCase / Title-Case layer names; a mandatory `/` taxonomy
  for components — `Button/Primary`, `Icon/Chevron`; semantic names for structural text) is a
  **user preference** in `figma-bridge-prefs`, not a shipped default — see
  [[figma-bridge/docs/specs/customization|customization.md]]. Neither is duplicated here.
- **Auditing.** The `figma-reviewer` agent flags names that are blank, whitespace-only, or match
  the default-name heuristic
  (`^(Frame|Group|Rectangle|Ellipse|Line|Polygon|Star|Vector|Component|Component Set|Instance|Slice|Image|Section|Boolean|Union|Subtract|Intersect|Exclude)(\s+\d+)?$`)
  — the **basic floor**. Flagging components that lack a `/` taxonomy is a **stricter naming
  standard** that applies **only when `figma-bridge-prefs` opts into it** (see
  [[figma-bridge/docs/specs/customization|customization.md]]). **Variant children** (names
  containing `=`, e.g. `Size=Lg, State=Hover`) are exempt from the taxonomy check. Text nodes are
  exempt from the "matches type" rule (their name may legitimately equal their content); only blank
  text-node names are flagged.
- **Bounded enumeration.** The audit finds offenders with `search` using `match.regex` = the
  default-name pattern (server-side filter, cursor-paginated, T10-bounded), and applies fixes via
  `update_node` (name), batched through `batch`. The name↔context agreement check (a good name
  should not contradict `context.role`) is a skill-layer judgment, not a server rule.

---

## Surface 2 — Description

Close the write-only asymmetry: make the already-writable `description` **readable** on the reads
that enumerate the assets it belongs to.

- **`get_components`** — each component / component-set entry gains a `description` field.
- **`get_styles`** — each style entry gains a `description` field.
- Both round-trip through their existing write twins (`update_component`, `update_styles`), so
  surfacing them is purely additive — no new write path.
- **Not** surfaced on `get_node` / `inspect`: `description` is written by the component/style
  tools, not by `update_node`, so keeping it on the asset reads avoids a round-trip break on the
  generic node readers.
- **Variables are excluded.** A variable is not a node — Figma exposes `Variable.description`, not
  `node.description` — and the variable tools do not write it today. Out of scope here.
- The field is **omitted** when the asset has no description (never null/empty).

---

## Surface 3 — Context

### What it is

`context` is a round-trippable `NodeSpec` **metadata field** holding a markdown note: the
non-derivable intent a structural read can't give (purpose, role, status, constraints, links). It
is written when you create or update a node and read back on the node reads.

### Storage

The field is a **facade over shared `pluginData`**: a reserved shared namespace and key, defined
once as shared constants —

- `CONTEXT_NS = "figmabridge"` (a dedicated constant; **not** `APP_NAME`, which is scoped/hyphenated
  and packaging-tied)
- `CONTEXT_KEY = "context"`

Shared (not private) so the value is REST-readable and reachable by other tooling. `get_node` reads
`getSharedPluginData(CONTEXT_NS, CONTEXT_KEY)`; `create_node` / `update_node` write it via
`setSharedPluginData`.

### Writing

- **Primary path — the `NodeSpec` field.** `create_node({…, context})` and
  `update_node(id, {context})` write it. Because `context` is part of the `NodeSpec`, it also
  travels through anything that round-trips a spec (e.g. `create_tree` nodes, clones).
- **Update semantics.** On `update_node`, an **omitted** `context` leaves the stored value
  untouched (partial update); a **supplied empty or whitespace-only** `context` **clears** (deletes)
  the reserved key — matching `set_plugin_data`'s empty-string-clears rule. (So a stored empty value
  and an absent one are indistinguishable, which is why reads omit both.)
- **Escape hatch — `set_plugin_data`.** The generic low-level tool can still write the reserved
  key directly. It stays **unopinionated**: it enforces only Figma's real per-entry limit, so it
  can write a value **above the 2 KB cap** — which the *Size* section declares read-only. The
  `figma-reviewer` audit catches oversized or malformed context written this way.

### Reading (surfacing)

| Read | Field returned | Content | Why |
|---|---|---|---|
| `get_node` / `get_nodes` | `context` | **Full** verbatim markdown | Fidelity readers — round-trip requires the whole value; bounded by `depth` + the 2 KB cap |
| `inspect` | `contextSummary` | frontmatter slice | View reader — answers "what is this?" at a glance, within the existing budget |
| `search` | `contextSummary` | frontmatter slice | List reader (limit 50) — must not inline the full value |
| `get_components` | `contextSummary` (+ `description`) | frontmatter slice | Browsing components; bounded by the `limit` |

- **Two distinct fields, never confused.** The fidelity readers return the full value as `context`
  (round-trippable). The view/list readers return only `contextSummary` — a **read-only** frontmatter
  slice under a different name, so a consumer can't accidentally write a truncated summary back
  through `update_node`. The full body (`## Constraints` / `## Links` / `## Notes`) is reached with
  a focused `get_node`.
- **Summary extraction.** `contextSummary` is the **inner** text (between the fences, not the fence
  lines) of a frontmatter block delimited by a leading `---\n` anchored at byte 0 (a `\r\n` CRLF is
  tolerated) and the next **line-anchored** `^---$` — so a `---` thematic break or a fenced `---` in
  the body is not mistaken for the closing fence. It is then capped at **`CONTEXT_SUMMARY_MAX_BYTES`**
  with a `…` marker. If the value has **no leading frontmatter, or an opening fence with no closing
  `^---$`**, `contextSummary` is **omitted** (the full value is still reachable via `get_node`).
  `contextSummary` is derived server-side and is not subject to `fields` / `profile` projection.
- `context` / `contextSummary` / `description` are **omitted** when absent or empty (never null/empty).
- In `inspect`'s atom-per-leaf view, `contextSummary` renders as a YAML block scalar.

### Format

Markdown — frontmatter scalars + fixed body sections. All fields optional except `purpose`.

| Field | Placement | Job | Req? |
|---|---|---|---|
| `purpose` | frontmatter | What it is and what it's *for* | ✅ by convention¹ |
| `role` | frontmatter | Design-system taxonomy label (`button/primary`) | – |
| `status` | frontmatter | `draft` \| `stable` \| `deprecated` (default `stable`) | – |
| `updated` | frontmatter | Provenance: who wrote it + when (`agent · 2026-07-08`) | – |
| `## Constraints` | body | Invariants to respect when editing | – |
| `## Links` | body | Source-of-truth pointers (`linear:ENG-1234`) | – |
| `## Notes` | body | Free prose — anything the fields don't capture | – |

¹ `purpose` is required by *convention* (the skill teaches it), not server-validated — the server
enforces only the size cap (see *Size*). Deliberately excluded to avoid re-describing the node:
bindings (structural reads already return bound variables) and per-instance override lists (use
`## Notes`).

**Canonical example:**

```markdown
---
purpose: Primary checkout CTA — sole entry to checkout
role: button/primary
status: stable
updated: agent · 2026-07-08
---
## Constraints
Token-bound (do not restyle) · text localized · width fluid

## Links
linear:ENG-1234 · pr:#456

## Notes
Visually dominant by design; only one primary per screen.
```

The value is stored and surfaced **verbatim**; the server never parses the fields (parsing is
skill-layer).

### Size

- **Hard cap — 2 KB** (`CONTEXT_MAX_BYTES = 2048`, UTF-8 bytes, a shared constant), enforced as
  **validation on the `context` `NodeSpec` field** wherever a spec is written (`create_node` /
  `update_node` / `create_tree`). The write rejects an oversized value with a clean, actionable
  error (e.g. `context is 3140 bytes; limit is 2048 — trim the body or move detail behind a Links
  entry`) rather than letting Figma throw. Because it is field validation, it is *not* an opinion
  baked into the generic `set_plugin_data`. The cap is a **read-cost bound** (context rides on every
  node read, so bounding write-size bounds read cost), which is why it sits far below Figma's real
  per-entry limit.
- **Summary cap — `CONTEXT_SUMMARY_MAX_BYTES` = 512** (UTF-8 bytes): the derived `contextSummary` on
  `inspect` / `search` / `get_components` is truncated to this with a `…` marker, so those list/tree
  reads stay bounded even when the underlying `context` is over-cap (via the escape hatch).
  `description` on those reads is returned **in full** — it is the field's canonical read — bounded
  by the read's `limit`.
- **Over-cap `context` is read-only (a declared T7 asymmetry).** Because the store is *shared*, a
  value above 2 KB can still reach the reserved key via the raw `set_plugin_data` escape hatch or
  external tooling — paths we cannot gate. Such a value is **read-only**: the fidelity readers return
  it faithfully, and a naive full-spec write-back through `create_node` / `update_node` is rejected
  with the clean size error. The agent proceeds by **omitting** `context` (preserved, per *Writing*)
  or **trimming** it to ≤ 2 KB. This is the one declared break in the round-trip promise (T2), not a
  silent one.
- **Soft target — ~1 KB / ~600 chars**, taught in the `figma-design` skill: context is "one
  screen's worth of *why*" — approaching the cap means you're writing docs, so link out instead.
- The markdown **structure** (required `purpose`, the `status` enum, the fixed sections) is
  **advisory** skill convention — the server validates size only and stores the raw string. No
  read-time synthesis of defaults.

### Mechanism (design constraints)

`context` is not part of Figma's standard node export (`JSON_REST_V1` omits plugin data), so:

- **Merge / split at the plugin.** The node read fetches the reserved key and attaches it; the
  write path calls `setSharedPluginData`. A downstream serializer cannot recover data the export
  never carried.
- **Fidelity readers carry the full field for free.** Projection returns the node unchanged when no
  `profile` / `fields` selector is passed (an identity projection), so the full `context` field
  appears on `get_node` / `get_nodes` as soon as it is on the `NodeSpec` type; it must be added to
  `PROFILES.full` only so that callers who narrow to `profile:"full"` still receive it.
- **View/list readers override to the summary.** `inspect` and `search` build on the same node
  serialization but must **replace** the full `context` with the `contextSummary` slice, so the
  identity carry does not leak the full value onto these bounded readers. `get_components` builds its
  entries without the node export, so it needs an explicit per-entry fetch:
  `getSharedPluginData(CONTEXT_NS, CONTEXT_KEY)` sliced to `contextSummary`, plus the component's
  `.description`. `get_styles` fetches **only** `.description` — a style is not a node, so it has no
  `context`. All are bounded by the read's `limit`, the summary cap, and (for `description`) its
  canonical full read.

---

## Sibling specs

This design amends two governed specs; the edits cascade **when the feature lands** (they describe
behavior that doesn't exist yet):

- **`expression-formats.md`** — add `context` to the node struct as a round-tripping metadata field
  (a field, not an atom).
- **`tool-surface.md`** — add `description` to the `get_components` / `get_styles` return shapes;
  add `context` (fidelity readers) and the `CONTEXT_SUMMARY_MAX_BYTES`-capped `contextSummary`
  (`inspect` / `search` / `get_components`) to the node-read contracts; add `context` to the `full`
  read profile. No new warnings channel — the over-cap state surfaces via the existing write-side
  rejection.
