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

Purpose: teach **how to operate** the 61-tool surface well. This skill deliberately
does not encode visual taste or a house style — _how the outcome looks is the user's
to specify, per request_. Principles and mechanics age well; baked aesthetics don't.
The skill covers the full surface: create, inspect, and edit (including the current
selection). There is no create-only vs. edit split.

---

## Address the file first

Call `status()`; read the target file's `fileKey` from `joined[]` (or `available[]` on a
cold start — the server auto-joins an available file on first use) and pass it on **every**
subsequent file-tool call. If several files are joined and the target is ambiguous, **ask —
never guess.** (`connect` / `status` are the session pair — neither requires a per-call
`fileKey`; `connect` takes one only to choose which file to pair with.) Full multi-file /
error model:
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
2. **Component-first** — repeats and stateful things become components **before** they
   are placed, and instances inherit from the master. Never build-place-promote: a node
   inside a SLOT cannot be componentized at all. The modeling doctrine — what must be a
   component, variants vs booleans, slots vs visibility toggles, what to build last —
   is `references/components.md`; load it before creating any component, variant, or slot.
3. **Bind by writing the wrapper** — the default way to use a token _is_ the write:
   `fills: ["var(surface/2)#141B2E"]`, `text.font: "style(Heading/H2)font(Inter,SemiBold,20)"`.
   An inline `var()` / `style()` wrapper binds as it lands (grammar:
   `references/grammar.md`). Never emit a bare value that merely equals a token — the
   read-back can't tell it from a hardcode that has drifted. `bind_variable` /
   `apply_style` are the retrofit route: a node you aren't otherwise writing, and
   `bind_variable`'s collection-mode pin. The three splits the grammar cuts finer than
   Figma's binding surface (per-corner radius, per-side stroke weight, per-range run
   color) degrade to literal + warning — bind them uniformly, or take the literal
   knowingly.

> **Basic level only.** This skill ships only the **basic (reactive)** level of
> design-system-first and component-first — adopt a system if one exists, reuse before
> create, bind an existing token. A user's `figma-bridge-prefs` may raise these to a
> strict/proactive level and supply concrete values (tokens, spacing scale, type ramp,
> naming). See `docs/specs/customization.md` in the repo (not shipped) (P1).

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
  confirm the result. Read-back proves `var(…)` / `style(…)` bindings and `INSTANCE`
  types; a visual-only check misses binding state. You don't have to wait for it to
  learn a token name was wrong: a wrapper that resolved to nothing is reported in the
  write's own reply.

---

## Read the turn-start presence block

Every turn opens with an injected `figma_bridge:` YAML block (see
`docs/specs/plugin-presence.md` in the repo, not shipped) — passive awareness, not something you
fetch. Its per-file
`pending_edits` / `pending_edits_state` fields say what the **user** changed since your last
drain. What to do about them:

- **`pending_edits > 0`** → call `pull_changes({fileKey})` **before acting on that file's
  existing nodes**. The user edited them since your last read, and acting blind risks
  clobbering their change.
- **`pending_edits_state: gap`** → the feed lost part of the history. Drain, then **re-read
  what you already hold** — what came back can't be assumed to be everything that happened.
- **`pending_edits_state: no_baseline`** on a file you haven't read yet obliges nothing:
  the reads you were going to make *are* the baseline.
- **Both fields absent** → "unknown, no signal". Never read it as `0`.

How often to re-verify beyond that (re-read before every batch, not only before a
destructive op) is a preference — see `figma-bridge-prefs`.

The same block's reachability fields (`recently_offline[]`, `relay: unreachable`) are
`figma-connection`'s.

---

## Report your progress

**Always keep the panel current.** `report_status` paints one live line onto the plugin's
agent-status panel — your row is a progress dot, a label, and that line. Narrate what you're
doing: never work silently, never let the line go stale. Update it _before_ you start a step,
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

| Say this (intent)          | Not this (mechanics)            |
| -------------------------- | ------------------------------- |
| `Drawing the header bar`   | `create_node RECTANGLE 56:12`   |
| `Wiring the 4 stat cards`  | `calling set_instance ×4`       |
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

- **Meaningful, non-default names (floor).** Name every node for what it _is_ or _does_;
  never leave a Figma default (`Frame 12`, `Rectangle 3`). The _concrete_ convention —
  descriptive PascalCase / Title-Case and the mandatory component `/` taxonomy
  (`Button/Primary`) — is a **user preference**, relocated to `figma-bridge-prefs`
  `references/house-style.md`; this skill ships only the floor (a meaningful,
  self-describing name on every node). See
  `docs/specs/customization.md` §11 in the repo (not shipped) (P1).

---

## Context — the hidden note

`context` is a round-trippable markdown note stored on a node: the non-derivable _why_ a
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

- **Frontmatter** — `purpose` (required by convention: what it is and what it's _for_),
  `role` (design-system label like `button/primary`), `status` (`draft` | `stable` |
  `deprecated`, default `stable`), `updated` (provenance — `agent · <date>`). All but
  `purpose` are optional.
- **Body** — the three fixed sections `## Constraints`, `## Links`, `## Notes`, in that
  order. Skip any you have nothing for; don't invent new headings.
- **Keep it to one screen of _why_** — a ~600-character soft budget. Past that you're
  writing docs: link out via `## Links` instead. The hard cap is 2 KB; a write over it
  is rejected with a clean size error.

One boundary to respect:

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
   Complex components (tables, data grids, calendars) go **last** — model them on paper
   first (`references/components.md`).
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
   - every token-valued fill / font carries its `var(…)` / `style(…)` wrapper. A bare
     hex where a token holds that value is an _unbound_ value, not a bound one.
   - instances show `type: INSTANCE` and correct `component` references.
   - layout mode, sizing, and padding match intent.

A binding that didn't land is announced twice: first by the write's own reply
(`var(surface/2): no variable with that name — literal applied unbound`), then by the
missing wrapper in the read-back. The literal landed either way — it looks right on the
PNG and is bound to nothing.

If a field reads back differently from what was written, that's a signal to check
whether the tool call succeeded silently with a wrong result — file a bug via the
`figma-feedback` skill.

---

## Wrapping up — offer the feedback review

The gate is raised by the **main agent** (`AskUserQuestion` only works at the top level),
but the trigger flows through the whole chain — and covers both ways work reaches you:

- **You built directly** (this skill is loaded): when you finish and report the result to
  the user, if **this task recorded new friction**, offer the **end-of-work review** — the
  fixed three-way gate from the `figma-feedback` skill.
- **A `figma-designer` / `figma-reviewer` subagent built** (it loaded this skill; the main
  agent may not): the subagent records friction and **flags it in its report back** —
  "recorded N tool-friction items — invoke the figma-feedback skill and present its fixed
  end-of-work gate verbatim." Act on that flag: load `figma-feedback` and run the gate.

Either way the gate files the **whole pending backlog** in one batch (new items plus anything
deferred earlier). Trigger only on **new friction this task** — if nothing new was recorded,
say nothing, even if an older backlog exists (it rides along the next time friction is filed;
a purely-deferred backlog may linger, which is acceptable). This is an **optional courtesy,
not a required step:** offer it once as you wrap up, never mid-build, never twice. If the
moment isn't right, skip it. Don't nag.

---

## Fiddly mechanics

The calls that get wrong most often are documented with exact patterns in
`references/mechanics.md`. Load that reference when:

- setting text content on an instance child
- choosing sizing for a fixed-size frame
- binding a token — the inline wrapper, or the `bind_variable` / `apply_style` retrofit
- combining variants

The atom value formats (color, font, gradient, effect, stroke, sizing, constraints)
are in `references/grammar.md`. Load it when writing or reading any atom value.

The modeling decision that comes _before_ those calls — what becomes a component and
when, variants vs booleans, slots vs visibility toggles, complex components last — is
`references/components.md`. Load it before creating any component, variant, or slot.

---

## Limits (know before hitting them)

- `update_component`'s `add` entries bind a TEXT property to a text node **only when
  you pass `targetNodeId`** — done that way, the bind is real: `set_instance` on that
  property genuinely updates the instance's rendered text (verified live). Omit
  `targetNodeId` and the property is added unbound — `set_instance` is then inert, and
  the compound-id override path is the fallback (see `references/mechanics.md`).
- `delete_variables` removes variables by id **and** whole collections (deleting a
  collection cascades its variables); `delete_styles` removes local styles by id or by
  name + type. Prefer reuse over delete-and-recreate: a delete breaks every binding that
  pointed at that token or style, and nothing warns you.
- `get_node` on a rotated frame returns the bounding-box size, not the frame's own
  width/height — account for this when checking dimensions.
- `get_node` may return an invalid profile for nodes that are partially outside the
  canvas — handle gracefully.

When a limit blocks a task, record it via the `figma-feedback` skill (proposals or
bugs, as appropriate) and continue with the best available workaround.

## User preferences

If a skill named **`figma-bridge-prefs`** is in your available skills, **ensure it is loaded**
(load it if not yet loaded), **then read its `references/house-style.md` if you have not
already read it this session** — the read is **not** gated on the skill being freshly loaded.
(The skill is often already loaded at build start, so a load-gated read would silently skip the
house style.) It raises the level of the defaults above and supplies concrete values; it may
only make you stricter — it never relaxes the verification discipline. If you loaded
`figma-bridge-prefs` but could not read its reference, **say so and proceed on the basic
floor** — do not proceed as if the house style applied. An absent or unreadable
`house-style.md` simply means the basic floor — never an error. Match the **exact** name
`figma-bridge-prefs` (not a prefix or substring). If none is present, you may offer to run
`figma-setup` to create one.
