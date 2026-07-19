---
name: figma-design
description: >-
  Use whenever the user wants to build, create, edit, or restyle anything in Figma —
  a dashboard, UI screen, component, layout, or design system, even if they don't say
  "Figma". Teaches the design-system-first workflow, the value grammar, and the exact
  tool mechanics (bind_variable, apply_style, instance overrides, sizing) that make
  output correct, not just valid. Invoke before building or editing in Figma.
version: 0.1.0
---

# figma-design skill

Purpose: teach **how to operate** the 47-tool surface well. This skill deliberately
does not encode visual taste or a house style — *how the outcome looks is the user's
to specify, per request*. Principles and mechanics age well; baked aesthetics don't.
The skill covers the full surface: create, inspect, and edit (including the current
selection). There is no create-only vs. edit split.

---

## Address the file first

Call `status()`; read the target file's `fileKey` from `joined[]` (or `available[]` on a
cold start — the server auto-joins an available file on first use) and pass it on **every**
subsequent file-tool call. If several files are joined and the target is ambiguous, **ask —
never guess.** (`connect` / `status` take no `fileKey`.) Full multi-file / error model:
`figma-connection`.

---

## Start-of-work guard — is there a design system?

Design-system-first is a **decision**, not a mandate. Before building, detect whether
the file already uses one — local variables (design tokens), shared styles, or
components already in use signal systematic design.

- **Found one → adopt it by default.** Reuse and extend its tokens / styles /
  components (single source of truth). Never duplicate what already exists.
- **None found → the user's call.** Offer to establish one, but don't impose it.
  For a quick one-off or mockup, direct values are fine. **Ask when it's unclear**
  which the user wants.

Detection tools: `get_variables` (local variable collections), `get_styles`,
`get_components`. Presence of any is a signal; absence means ask.

---

## Principles

These apply once a design system is in play:

1. **Single source of truth** — reuse tokens and components; never duplicate.
2. **Component-first** — repeated elements become components; instances inherit
   changes from the master.
3. **Don't hardcode a value that has a token** — bind the variable (`bind_variable`)
   or apply the style (`apply_style`). Hardcoded values that shadow tokens drift
   silently.

---

## Operating rules

Rules for running the surface smoothly and cheaply:

- **Reuse before create** — search for an existing component or token before making a
  new one. `get_components` + `get_variables` first; `create_component` / `create_variables`
  only when nothing exists.
- **"check my selection"** → call `inspect` on the selection and describe it. Read,
  don't assume.
- **Mind token usage** — batch calls where the API allows; prefer scoped reads over
  whole-document scans; don't re-scan the document when you already have the ids.
- **Verify after build** — use `export` (PNG) + `get_node`/`inspect` read-back to
  confirm the result. Read-back proves `var(…)` bindings and `INSTANCE` types; a
  visual-only check misses binding state.

---

## Report your progress

**Always keep the panel current.** `report_status` paints one live line onto the plugin's
agent-status panel — your row is a progress dot, a label, and that line. Narrate what you're
doing: never work silently, never let the line go stale. Update it *before* you start a step,
not after. It is **fire-and-forget** — display-only, latest-wins, no round-trip, no return to
act on — one cheap call, so always send it. It is **not feedback**: no Send, no human gate,
nothing reaches GitHub; don't borrow `figma-feedback`'s record-don't-send etiquette.

- **Update per unit of work — always, but not per tool call.** Post a line the moment you
  begin a coherent step, and a fresh line whenever the work materially shifts. Every figma
  call already auto-emits a busy skeleton (the per-move loader), so you don't narrate per
  call — you post at the step boundary, and each call then shows that wordless skeleton until
  your next line. Never fall silent or skip a step's line: a new step always gets a new line.
- **Say the intent, not the mechanics** — present-tense, one line, what a watching human
  would say. Never tool names, node ids, or param dumps.
- **`level: 'normal'` by default; `'error'` only for a genuine failure a human should
  notice** — `Font missing — used a fallback`, `Couldn't bind the token — hardcoded instead`.
  Never for expected/handled errors, validation rejections, or normal completion (the dot
  settles green on Stop). Busy is automatic — never set it.
- **Usually omit `label`** — `agentType` / "Agent" is fine. Set one friendly name only when
  `agentType` is unhelpful or absent, so the row isn't a generic "Agent".

| Say this (intent) | Not this (mechanics) |
|---|---|
| `Drawing the header bar` | `create_node RECTANGLE 56:12` |
| `Wiring the 4 stat cards` | `calling set_instance ×4` |
| `Scanning existing tokens` | `get_variables then get_styles` |

```
report_status({ fileKey, text: 'Wiring the 4 stat cards' })
report_status({ fileKey, text: 'Font "Inter Tight" missing — used Inter', level: 'error' })
```

(`fileKey` addresses the file like every tool — see **Address the file first**.)

---

## Naming discipline

Every node ships with a meaningful `name` — the layer panel is the design's first read,
for both agents and humans. This is discipline, not tooling: the tools accept `name` on
every create, and nothing enforces it server-side. Never leave the Figma defaults
(`Frame 12`, `Rectangle 3`).

- **Semantic layer names** — name a node for what it *is* or *does*, in descriptive
  PascalCase / Title-Case (`CheckoutButton`, `Search Bar`, `StatCard`).
- **`/` taxonomy for components** — a `COMPONENT` / `COMPONENT_SET` carries a slash path
  that places it in the system: `Button/Primary`, `Icon/Chevron`, `Card/Product`. The
  taxonomy is how the component browser groups assets, so it is mandatory on every
  master. Variant children are named by their properties (`Size=Lg, State=Hover`) — that
  `=` form is the variant convention, not a taxonomy path.
- **Semantic names for structural text** — a text node that plays a structural role (a
  heading, a label, a field caption) earns a role name (`SectionTitle`, `PriceLabel`),
  not its literal content. A text node whose name simply mirrors its own characters is
  fine for plain copy — the reviewer exempts it — but structural text deserves a real
  name.

---

## Context — the hidden note

`context` is a round-trippable markdown note stored on a node: the non-derivable *why* a
structural read can't give — purpose, role, status, constraints, links. Write it with
`create_node` / `update_node` (the `context` field); read it back in full on `get_node`
/ `get_nodes`, or as a compact `contextSummary` (the frontmatter slice) on `inspect` /
`search` / `get_components`.

**Author it in this shape** — frontmatter scalars, then fixed body sections:

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

- **Frontmatter** — `purpose` (required by convention: what it is and what it's *for*),
  `role` (design-system label like `button/primary`), `status` (`draft` | `stable` |
  `deprecated`, default `stable`), `updated` (provenance — `agent · <date>`). All but
  `purpose` are optional.
- **Body** — the three fixed sections `## Constraints`, `## Links`, `## Notes`, in that
  order. Skip any you have nothing for; don't invent new headings.
- **Keep it to one screen of *why*** — a ~600-character soft budget. Past that you're
  writing docs: link out via `## Links` instead. The hard cap is 2 KB; a write over it
  is rejected with a clean size error.

Two boundaries to respect:

- **Root-only read-back (v1).** `context` can be *written* on any node — including
  `create_tree` descendants — but it is only *read back* when that node is the read /
  export **root**. A deep `get_node` returns `context` on the root, not on descendants.
  Do not rely on a deep read or a `create_tree` round-trip to preserve descendant
  context; write it, then read each node *as its own root* to confirm.
- **Over-cap writes are read-only.** The raw `set_plugin_data(figmabridge/context, …)`
  escape hatch is unopinionated and can store a value above the 2 KB cap. Such a value
  reads back faithfully but is **read-only** — a full-spec write-back through
  `update_node` is rejected with the size error. Trim to ≤ 2 KB, or omit `context`
  (omitting preserves the stored value) to edit the rest of the node.

---

## Workflow spine

A default order, not a mandate — adapt to the request:

1. **Tokens** — establish or reuse variable collections (color, spacing, typography
   scales).
2. **Styles** — map tokens to text styles, effect styles.
3. **Components** — build master components; add variants via `combine_variants`.
4. **Layout** — compose frames with auto-layout (`set_layout_mode`, sizing rules).
5. **Content** — populate text, images, instance overrides.
6. **Verify** — `export` + read-back; check token bindings and instance types.

For edits to an existing file, start at whichever step is relevant (often Content or
Verify first to understand the current state).

---

## Verification discipline

After any build or edit:

1. `export` the frame (PNG) to get a rendered snapshot.
2. `get_node` or `inspect` to read the data back — confirm:
   - fills show `var(…)` wrappers when bound (not bare hex).
   - instances show `type: INSTANCE` and correct `component` references.
   - layout mode, sizing, and padding match intent.

If a field reads back differently from what was written, that's a signal to check
whether the tool call succeeded silently with a wrong result — file a bug via the
`figma-feedback` skill.

---

## Fiddly mechanics

The calls that get wrong most often are documented with exact patterns in
`references/mechanics.md`. Load that reference when:

- setting text content on an instance child
- choosing sizing for a fixed-size frame
- binding variables or applying styles on master components
- combining variants

The atom value formats (color, font, gradient, effect, stroke, sizing, constraints)
are in `references/grammar.md`. Load it when writing or reading any atom value.

---

## Limits (know before hitting them)

- `update_component` can **add** a TEXT component property but does **not bind** it
  to any text node — `set_instance` setting that property is therefore inert. Use the
  compound-id override path instead (see `references/mechanics.md`).
- No `delete_variables` or `delete_styles` — reuse rather than clean up.
- `get_node` on a rotated frame returns the bounding-box size, not the frame's own
  width/height — account for this when checking dimensions.
- `get_node` may return an invalid profile for nodes that are partially outside the
  canvas — handle gracefully.

When a limit blocks a task, record it via the `figma-feedback` skill (proposals or
bugs, as appropriate) and continue with the best available workaround.
