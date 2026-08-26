---
name: figma-design
description: >-
  Use whenever the user wants to build, create, edit, or restyle anything in Figma —
  a dashboard, UI screen, component, layout, or design system, even if they don't say
  "Figma". Teaches the three-pillar practice (design system, component-first,
  everything responsive), the value grammar, and the exact tool mechanics
  (bind_variable, apply_style, instance overrides, sizing) that make output correct,
  not just valid. Invoke before building or editing in Figma.
version: 0.5.0
---

# figma-design skill

Purpose: teach **how to operate** the 61-tool surface well. This skill deliberately
does not encode visual taste or a house style — _how the outcome looks is the user's
to specify, per request_. Principles and mechanics age well; baked aesthetics don't.
The skill covers the full surface: create, inspect, and edit (including the current
selection). There is no create-only vs. edit split.

---

## Address the file first

Call `status()`; read the target file's `fileKey` from `joined[]` and pass it on
**every** subsequent file-tool call. If several files are joined and the target is
ambiguous, **ask — never guess.** The full addressing doctrine — the session pair,
multi-file driving, and every error response — is `figma-connection`; load it on any
addressing or connection question.

---

## Start-of-work guard — is there a design system?

Design-system-first is a **decision**, not a mandate. Detect one before building:
`get_variables` (local collections), `get_styles`, `get_components` — any of them
non-empty is the signal, and absence means ask.

- **Found one → adopt it by default.** Reuse and extend its tokens / styles /
  components (single source of truth). Never duplicate what already exists.
- **None found → the user's call.** Offer to establish one, but don't impose it.
  For a quick one-off or mockup, direct values are fine. **Ask when it's unclear**
  which the user wants.
- **Committed to a system with no color tokens → establish them first.** `get_variables`
  coming back with no `COLOR` variable is a **build-blocking precondition**, not a to-do:
  create the palette before the first styled node. Values emitted to be bound later never
  get bound, and a raw hex reads back exactly like a token value that has since drifted.

---

## The three pillars

The practice stands on three pillars of equal weight. Each ships its basic
level here; `figma-bridge-prefs` may raise any pillar to a strict level and
supply concrete values.

1. **Design system** — one source of truth, entered by writing the wrapper.
   - **Single source of truth** — reuse tokens and components; never duplicate.
   - **Bind by writing the wrapper** — the default way to use a token _is_ the write:
     `fills: ["var(surface/2)#141B2E"]`, `text.font: "style(Heading/H2)font(Inter,SemiBold,20)"`.
     An inline `var()` / `style()` wrapper binds as it lands (grammar:
     `references/grammar.md`). A `style()` on `fills` / `strokes` / `effects` / `grids`
     is different in kind: it owns the **whole** field — `effects: "style(AB/Blur)"`, a
     reference and not an entry, so a style beside literal siblings is rejected rather
     than written. Never emit a bare value that merely equals a token — the
     read-back can't tell it from a hardcode that has drifted. `bind_variable` /
     `apply_style` are the retrofit route: a node you aren't otherwise writing, and
     `bind_variable`'s collection-mode pin. The three splits the grammar cuts finer than
     Figma's binding surface (per-corner radius, per-side stroke weight, per-range run
     color) degrade to literal + warning — bind them uniformly, or take the literal
     knowingly.
2. **Component-first** — repeats and stateful things become components **before** they
   are placed, and instances inherit from the master. Never build-place-promote: a node
   inside a SLOT cannot be componentized at all. The modeling doctrine — what must be a
   component, variants vs booleans, slots vs visibility toggles, what to build last —
   is `references/components.md`; load it before creating any component, variant, or slot.
3. **Everything responsive** — nothing FIXED without a reason; masters hug while
   instances fill; text wraps instead of overflowing; floors live on containers as
   min-sizes; collections flow with wrap or hold with grid; squeeze-check a master
   before calling it done. The doctrine — the two layers, the sizing roles, wrap vs
   grid, slot sizing, the device layer — is `references/responsive.md`; load it before
   sizing any component, slot, or text block.

> **Basic level only.** This skill ships only the **basic (reactive)** level of the
> three pillars — adopt a system if one exists, reuse before create, bind an existing
> token, keep components responsive at the floor level. A user's `figma-bridge-prefs`
> may raise these to a strict/proactive level and supply concrete values (tokens,
> spacing scale, type ramp, naming, file organization, data display, breakpoint
> widths). See `docs/specs/customization.md` in the repo (not shipped) (P1).

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
- **Verify after build** — `export` (PNG) + `get_node`/`inspect` read-back, every time: a
  visual-only check misses binding state. Full procedure in **Verification discipline**.

---

## Read the turn-start presence block

Every turn opens with an injected `figma_bridge:` YAML block (see
`docs/specs/plugin-presence.md` in the repo, not shipped) — passive awareness, not something
you fetch. Its per-file `pending_edits` / `pending_edits_state` fields say what the **user**
changed since your last drain. What to do about them:

- **`pending_edits > 0`** → call `pull_changes({fileKey})` **before acting on that file's
  existing nodes**. The user edited them since your last read, and acting blind risks
  clobbering their change.
- **`pending_edits` near or above the drain's own limit, or a drain that comes back
  `truncated: true`** → re-evaluate, don't replay. One call returns at most `limit` entries
  (default 100), and a truncated one carries a `remaining` map —
  `{total, frames: [{fr, n, …}], other}` — that already names where the rest are: re-read
  those frames instead of consuming the list a hundred at a time. Concentration decides —
  100 changes in one frame is one cheap re-read; 100 across twenty frames is a drain.
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
  would say: `Wiring the 4 stat cards`, never `calling set_instance ×4`. No tool names,
  node ids, or param dumps.
- **`level: 'normal'` by default; `'error'` only for a genuine failure a human should
  notice** — `Font missing — used a fallback`, `Couldn't bind the token — hardcoded instead`.
  Never for expected/handled errors, validation rejections, or normal completion (the dot
  settles green on Stop). Busy is automatic — never set it.
- **Usually omit `label`** — `agentType` / "Agent" is fine. Set one friendly name only when
  `agentType` is unhelpful or absent, so the row isn't a generic "Agent".

```
report_status({ fileKey, text: 'Wiring the 4 stat cards' })
report_status({ fileKey, text: 'Font "Inter Tight" missing — used Inter', level: 'error' })
```

(`fileKey` addresses the file like every tool — see **Address the file first**.)

---

## Naming discipline

Every node ships with a meaningful `name` — the layer panel is the design's first read, for
both agents and humans. Name each node for what it _is_ or _does_; never leave a Figma default
(`Frame 12`, `Rectangle 3`). This is discipline, not tooling: every create accepts `name` and
nothing enforces it server-side. The _concrete_ convention — descriptive PascalCase /
Title-Case, the mandatory component `/` taxonomy (`Button/Primary`) — is a **user preference**
in `figma-bridge-prefs` `references/house-style.md`; this skill ships only the floor. See
`docs/specs/customization.md` §11 in the repo (not shipped) (P1).

---

## Organize the file

Placement is documentation: where a thing sits tells the next reader whether editing it is
safe — a master beside one screen reads as local and editable, the same master on a
design-system page reads as shared and load-bearing. `references/components.md` §2 says _what_
becomes a component; this says _where_ it lives.

- **Pages by scope.** Site-wide parts — buttons, chips, inputs, cards, table rows — belong on
  a dedicated design-system page: shared vocabulary, edit with care. A block exactly one
  screen consumes stays on that screen's page, beside its only consumer. Interleaved on one
  canvas, the two are indistinguishable.
- **Name every page.** `create_page` takes a `name`; rename one that earned its purpose later
  with `update_node` on the **page's own id** (from `list_pages`), `patch: {name}` — a PAGE is
  a valid `update_node` target, and only the file/document node refuses a rename. Never leave
  a `Page 1` standing.
- **Masters get a deliberate home.** `position` the anatomy you componentize — a spaced grid
  on its page, never the `[0,0]` that every unpositioned page-root create lands on. Piled
  masters read as unplaced, and enough of them is a review finding.

The concrete page set and grid spacing, if any, come from `figma-bridge-prefs`.

---

## Data coherence

The truth half of pillar 1: one source of truth governs **data** the way it governs
tokens. A rendered number is a claim. These are correctness, not taste — they hold
with or without a design system:

- **One dataset drives related and repeated content.** One price table, one precision per
  asset: the same record shows the same number everywhere it appears. A figure invented
  per card renders perfectly and is still wrong.
- **Chart chrome derives from the series it frames.** Gridlines, axis ticks, and legend
  come from the same extent and scale as the data — an axis whose top sits below the
  tallest bar is a broken chart that looks fine.
- **A spark or mini-chart's shape derives from the metric it decorates.** A negative delta
  never gets a rising spark: the sign and the shape are one fact drawn twice.

---

## Context — the hidden note

`context` is a round-trippable markdown note stored on a node: the non-derivable
_why_ a structural read can't give — purpose, role, status, constraints, links.
Write meaningful notes on masters and load-bearing frames. The authoring shape,
the size budget, and the over-cap boundary are `references/mechanics.md`, **The
context note** — load it before writing or repairing one.

---

## Workflow spine

A default order, not a mandate — adapt to the request:

1. **Tokens** — establish or reuse variable collections (color, spacing, typography
   scales).
2. **Styles** — map tokens to text styles, effect styles.
3. **Components** — build master components; add variants via `combine_variants`.
   Before the first master, run the component census, pass 1 (below).
   Complex components (tables, data grids, calendars) go **last** — model them on paper
   first (`references/components.md`).
4. **Layout** — auto-layout is the default, and the tool's default too: every created
   FRAME and SLOT is a vertical stack unless you opt out with `layout: {mode: 'NONE'}`.
   State `layout` yourself for direction, gap, and padding — and state `sizing` with it,
   or the stack hugs a stated `size` away (`references/mechanics.md`, **Fixed-size
   frames**). `NONE` is for frames whose children really are placed by coordinate — a
   plot area holding gridlines or scatter points — and for nothing else. Align siblings
   with layout, not coordinates: a shared column is one auto-layout parent with a `gap`,
   never hand-matched `x` offsets. Sizing doctrine — which axis FILLs, where floors
   live, wrap vs grid — is `references/responsive.md`. The concrete spacing scale, if
   any, comes from `figma-bridge-prefs`.
5. **Content** — populate text, images, instance overrides.
6. **Verify** — `export` + read-back; check token bindings and instance types.

### The component census — two passes, both written

**Pass 1 — at the components stage, walk the BRIEF.** Before the first
master: list every block and every interactive element the brief names.
For each, decide component or frame with the litmus (`references/components.md`
§2) and write the decision down — three columns, in your progress narration
AND as a `context` note on the design-system page:

| Element (from the brief) | Decision | Why (Q0/Q1/Q2/Q3 — or the four NOs) |

A frame decision with no written NOs is a stop. A repeat count cannot see
a one-occurrence role; the brief walk can — the banner and the close
control live in the brief even when no repetition ever happens.

**Pass 2 — at every screen boundary, walk the REPEATS.** Before assembling
every screen after the first, stop and write a census in your progress
narration — three columns, one row per repeated element:

| Element (by construction, not content) | Seen where | Master |

List every element whose **construction** now exists twice — on the screens built,
in the brief's descriptions of screens to come, or one of each. Shells and wrappers
count: a boxed container with a title row over a body IS an element even when every
occurrence holds different contents. Two things that share their box, their header
arrangement, and their body arrangement are one element wearing different occupants
— slots and properties carry the difference (`references/components.md`). For each
row, name the master that carries it, or create that master before assembling the
screen. **A repeat with no master is a stop, not a note.**

Why a census and not just the rule: in every observed large build, the elements a
brief happened to *name* got masters, and the un-named repeating shell was
hand-built on every screen — the components phase felt finished, attention was
spent on content, and the abstract rule lost to the concrete examples. The census
forces the classification to run at the screen boundary, which is exactly where
reuse is cheapest and rebuilding is about to become the path of least resistance.
Single-screen tasks never trigger it; a six-screen build runs it five times, and
it is three lines each time.

For edits to an existing file, start at whichever step is relevant (often Content or
Verify first to understand the current state).

---

## Verification discipline

After any build or edit:

1. `export` the frame (PNG) to get a rendered snapshot.
2. `get_node` or `inspect` to read the data back — confirm:
   - every token-valued fill / font carries its `var(…)` / `style(…)` wrapper. A bare
     hex where a token holds that value is an _unbound_ value, not a bound one. A
     styled field carries the wrapper once, on the field itself
     (`fills: style(Glass/Fill)[#141B2E99]`), so a bare hex inside those brackets is
     the style's own value, not a miss.
   - instances show `type: INSTANCE` and correct `component` references.
   - layout mode, sizing, and padding match intent.
   - every outward effect — shadow, glow, `align=OUTSIDE` stroke, blur — is on the node
     **and** visible in the PNG: a clipping ancestor cuts the render, never the data
     (`references/mechanics.md`, **Clipped effects**).
3. **Sweep before calling it done.** Scope a sweep to what you built —
   `search({fileKey, scope: 'node', nodeId})` bounds the _scan_ (`limit` bounds only the
   page of results handed back; the plugin scans the whole scope either way). The one
   deliberate exception is the usage query below.
   - **Orphans** — a result carries `size` unless you narrow it away, so `[0, 0]`
     leftovers surface in the sweep itself. Hidden ones don't: `match` has no visibility
     predicate and the scan never emits `visible`, which appears only as `visible: false`
     in an **unprojected** read-back (any narrowing `profile` drops it). Promote,
     instance, or delete what's left — a raw shape repeating a master's anatomy is the
     same finding.
   - **Inventory** — reconcile what this build made against what uses it.
     `get_components` (local only; leave `includeRemote` off — it walks every instance in
     the document), then, for the few masters and tokens you actually doubt,
     `search({fileKey, match: {instancesOf: '<exact master name>'}, limit: 1})` and
     `search({fileKey, match: {variableId: '<id>'}, limit: 1})`. Those two run at
     **document scope on purpose** — a build-scoped zero only means "this screen doesn't
     use it" — which is why they are spent on a handful and never on the library, and each
     costs the plugin a per-candidate lookup besides. **Unused is not prunable:** delete
     only what this build created and nothing else references, and _flag_ anything older
     for the human — a delete breaks every binding that pointed at it and nothing warns
     you (**Limits**). Promote what the build hand-rolled twice.
   - **Structure** — collapse a single-child wrapper that decorates nothing, give siblings
     distinct names, keep an instance named for what it instances. Redundant nesting and
     orphan / hidden nodes are mechanical checks in the `figma-reviewer` skill (its
     `references/checks.md`) — build so they find nothing.

A binding that didn't land is announced twice: first by the write's own reply
(`var(surface/2): no variable with that name — literal applied unbound`), then by the
missing wrapper in the read-back. The literal landed either way — it looks right on the
PNG and is bound to nothing.

A field that reads back differently from what was written is a signal the call succeeded
silently with a wrong result — file a bug via the `figma-feedback` skill.

---

## Wrapping up — offer the feedback review

When you finish and report the result, and **this task recorded new tool friction**
(your own `record_feedback`, or a subagent's report flagging it), load the
`figma-feedback` skill and run its end-of-work review. The gate's shape, batch
semantics, and etiquette are that skill's alone — offer it once as you wrap up,
never mid-build; if nothing new was recorded, say nothing.

---

## Fiddly mechanics

The calls that get wrong most often are documented with exact patterns in
`references/mechanics.md`. Load that reference when:

- setting text content on an instance child
- choosing sizing for a fixed-size frame
- binding a token — the inline wrapper, or the `bind_variable` / `apply_style` retrofit
- combining variants
- adding a shadow, glow, or blur; importing an SVG; filling a slot; drawing a divider
- writing or repairing a node's `context` note

The atom value formats (color, font, gradient, effect, stroke, sizing, constraints)
are in `references/grammar.md`. Load it when writing or reading any atom value.

The modeling decision that comes _before_ those calls — what becomes a component and
when, variants vs booleans, slots vs visibility toggles, complex components last — is
`references/components.md`. Load it before creating any component, variant, or slot.

The sizing decision — FIXED vs HUG vs FILL, min/max floors, wrap vs grid, slot
sizing, the squeeze check — is `references/responsive.md`. Load it before sizing any
component, slot, or text block.

---

## Limits (know before hitting them)

The tool limits — unbound TEXT properties, deletes breaking bindings, rotated-node
geometry, off-canvas reads — live in `references/mechanics.md`, **Limits**. Load it
before working around anything surprising. When a limit blocks a task, record it via
the `figma-feedback` skill (proposals or bugs, as appropriate) and continue with the
best available workaround.

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
