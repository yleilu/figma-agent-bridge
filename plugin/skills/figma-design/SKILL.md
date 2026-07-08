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
