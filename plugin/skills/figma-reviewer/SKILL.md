---
name: figma-reviewer
description: >-
  Use to review a Figma design — as figma-designer's own self-check before calling a
  build done, or an existing frame/file on request ("review my selection"). Checks
  design-system adherence, consistency, accessibility, layout hygiene, and fidelity to
  intent; emits a standardized report and then offers to fix (never auto-mutates).
version: 0.1.0
---

# figma-reviewer skill

Reviews a **design artifact** against six quality dimensions and emits a standardized
report. Distinct from `figma-feedback`, which reviews the **tool** (bugs/proposals).

Consumed by:

- `figma-reviewer` agent — a dedicated review pass on an existing design
- `figma-designer` — self-review gate before a build is called done

---

## When to invoke

- **Self-review (figma-designer):** after every build pass, before reporting completion.
  Run the review on the top-level frame just built; iterate if blockers found.
- **On-request:** user asks "review my selection", "audit this frame", "check this
  design" — run on the current selection or a named node.

---

## Read first, report second, offer to fix third

The flow is strictly three phases — never collapse them:

1. **Read** the target — resolve **which file** too: use the `fileKey` **figma-designer
   passed you** (self-check); only on a **cold** on-request review, resolve it via
   `status().joined[]`. Pass that `fileKey` on every read call. A `WRONG_FILE` response
   means the fileKey is unknown/unavailable — **ASK which file, never guess.** Then
   `inspect` for the structure + properties; `get_node` for a node you need the faithful
   edit form of (e.g. to check its exact token binding); `export` a PNG for a fidelity
   check against the stated intent.
2. **Report** every finding using the output format below. Present the full report
   before touching anything.
3. **Offer to fix** — ask the user which findings to address. On approval, apply edits
   using the `figma-design` mechanics (bind tokens, fix spacing, rename nodes, etc.).

**Never auto-mutate.** The report comes first; mutation only follows explicit approval.

---

## Report your progress

**Always narrate as you review** — never inspect silently. `report_status` works exactly as
it does in figma-design (**Report your progress** there is the source of truth for cadence,
`level`, and etiquette), applied to inspection: post a line as you enter each dimension
(`Auditing token bindings on the stat cards`, `Checking contrast`). `level` follows
figma-design — use `error` only if the **review itself** can't proceed (file unreadable,
`WRONG_FILE`, export fails), **never** for design defects you find: those carry their own
`blocker`/`warning`/`nit` severity in the finding report, and the dot stays green through a
successful review. Fire-and-forget — it's the progress line, not the finding report.

---

## The six dimensions

### 1. Design-system adherence _(context-aware)_

**Only check when the file has a design system** (the §6.1 guard: local variables /
shared styles / components-in-use). If none is found, skip this dimension — the
dimension does not apply and filing findings against it would be wrong.

When a design system exists, check for:

- **Hardcoded color that should be a token** — a `fills` value that is a plain hex
  but a matching `var(…)` token exists in the local variable collection.
- **Text off a style** — `font(…)` without a `style(…)` wrapper where a matching
  text style is defined (`get_styles` to enumerate).
- **Duplicated element that should be a component** — identical subtrees (same
  structure + content) that do not share a master. Instances should be `INSTANCE`
  nodes pointing at one `COMPONENT`.
- **Detached instance** — a node whose `type` is `FRAME` or `GROUP` but whose
  shape exactly matches a known component (check `get_components`). Indicates a
  past Detach-from-Component action that broke the link.

### 2. Consistency

Check regardless of whether a design system is present:

- **Off-scale spacing / padding** — layout `gap` or `pad` values that don't sit on the
  scale (see `references/checks.md`): the user's `figma-bridge-prefs` `review-standards`
  scale when installed, else the file's **own** prevailing step. If neither is
  discoverable, do **not** assert a shipped scale — check internal consistency, never
  "multiples of 4".
- **Inconsistent corner radius** — radii that differ across sibling cards/chips/buttons
  without an obvious intent to differ; or a mix of per-corner and uniform radii for the
  same element type.
- **Type off the ramp** — font sizes not on the ramp — the `figma-bridge-prefs`
  `review-standards` ramp when installed, else the file's own prevailing ramp; never a
  shipped baseline; or more than 4 distinct sizes in one frame without a clear hierarchy.
- **Misaligned or off-grid elements** — siblings in an auto-layout frame whose sizes
  or positions suggest manual override (check `layoutPositioning: ABSOLUTE` on
  children in a flow-mode frame).

### 3. Accessibility _(user preference — thresholds from `figma-bridge-prefs`)_

Accessibility standards are a **user preference** (customization.md §7). Check contrast,
touch-target size, and text size against the thresholds in the loaded `figma-bridge-prefs`
`review-standards.md`. **No `figma-bridge-prefs` (or no `review-standards`) → accessibility is
unchecked** — you may compute the values, but do **not** assert a threshold; the reviewer
defines none.

- **Text contrast** — compare text `color` against the background `fills` of the nearest
  ancestor frame; compute the contrast ratio (formula in `references/checks.md`) and flag
  against the user's contrast thresholds.
- **Minimum text size** — read each text node's size and flag against the user's
  minimum-text-size standard.
- **Touch-target size** — measure interactive elements' (buttons, icon buttons, links)
  bounding boxes and flag against the user's touch-target standard.
- **Meaning by colour alone** — status indicators or data visualisation that conveys meaning
  exclusively via hue (no label, icon, pattern, or shape difference); flag against the user's
  accessibility standard.

The _how-to_ (contrast formula, interactive-node detection) is in `references/checks.md`; the
concrete numbers come only from `figma-bridge-prefs`.

### 4. Layout & structure hygiene

- **Absolute positioning where auto-layout fits** — a child with `layoutPositioning:
ABSOLUTE` inside an auto-layout frame, where the positioning could be expressed as
  flow. (Legitimate use: overlapping badges, floating tooltips — use judgement.)
- **Pile-up at [0,0]** — multiple sibling nodes all at `position: [0, 0]` on the page
  root with no layout parent (the "create-without-placement" symptom).
- **Missing constraints** — nodes inside a fixed-size frame with neither auto-layout
  nor constraints set (`constraints: [MIN, MIN]` is the Figma default — flag it on
  anything that should be responsive).
- **Redundant nesting** — a `FRAME` or `GROUP` that has exactly one child, no fills,
  no strokes, no effects, and no constraints that differ from the child's own. It adds
  no value and should be flattened.
- **Orphan / hidden nodes** — `visible: false` nodes that are not part of a variant or
  interaction; nodes with zero size; nodes clipped entirely outside the frame bounds.

### 5. Fidelity to intent

Compare the built design against the stated request:

- **Matches the request** — all mentioned components, screens, or sections are present.
- **Nothing missing** — check the request for count ("three cards") or specific items
  ("a search bar", "a sidebar nav") and verify each is present.
- **Nothing extra** — placeholder content, leftover test nodes, or boilerplate that
  wasn't asked for.
- **Content accuracy** — placeholder text ("Lorem ipsum", "Text", "Label") in content
  positions that the request specified real values for.

This dimension is always relative to the stated intent; if no intent was stated (a
pure style audit), skip it.

### 6. Naming & context legibility

Audits the two hidden-in-plain-sight legibility surfaces: every node should carry a
legible `name`, and any `context` note should be well-formed. (The naming _floor_ — a
meaningful, non-default name — comes from the loaded `figma-design` skill; the concrete
naming _convention_, if any, comes from the loaded `figma-bridge-prefs`. The reviewer
itself defines neither — this dimension only audits against what those supply plus the
blank / default-name floor.)

- **Blank or default name** — a `name` that is empty, whitespace-only, or matches
  Figma's default-name pattern (`Frame 12`, `Rectangle`, `Ellipse 3` — the full regex
  is in `references/checks.md`). Nameless nodes block agent and developer targeting.
  - **Text-node exemption:** a text node's `name` may legitimately equal its
    `characters`, so a text node is flagged **only when its name is blank** — never for
    mirroring its own content or the default pattern.
- **Malformed or oversized context** — a `context` value with an unclosed frontmatter
  fence (yields no `contextSummary`, so the note is invisible at a glance), or one that
  exceeds the 2 KB cap (only reachable via the `set_plugin_data` escape hatch).
- **Name ↔ context.role contradiction _(advisory)_** — when a node's `name` and its
  `context` frontmatter `role` tell different stories (a node named `SecondaryButton`
  with `role: button/primary`). Advisory only — a judgement call, never a hard fail,
  since either field could be the stale one.

**Bounded enumeration.** Don't walk the whole tree by hand — run `search` with
`match.regex` set to the default-name pattern (a server-side, cursor-paginated, bounded
filter) to collect offenders, then batch renames via `update_node` / `batch`.

---

## Output format

Emit one finding per line in this shape:

```
[<severity>] <dimension> — <node name / id>
  Issue: <what's wrong>
  Fix:   <concrete suggestion>
```

Severity levels:

- `blocker` — prevents the design from meeting its purpose or fails a hard
  threshold (e.g. a completely missing section, or an accessibility contrast fail
  against the user's `figma-bridge-prefs` blocker threshold).
- `warning` — degrades quality or maintainability; should be fixed before shipping.
- `nit` — polish item; low urgency but worth noting.

After all findings, emit a **verdict block**:

```
---
Verdict: <PASS | PASS WITH NITS | NEEDS WORK | BLOCKED>
Blockers: N   Warnings: N   Nits: N

<One or two sentence summary of the overall state.>
```

Verdict rules:

- `PASS` — zero blockers, zero warnings (nits allowed).
- `PASS WITH NITS` — zero blockers, zero warnings, one or more nits.
- `NEEDS WORK` — one or more warnings, zero blockers.
- `BLOCKED` — one or more blockers.

If there are zero findings, emit the verdict block only with a brief confirmation
("No findings — the design meets all checked dimensions.").

---

## After the report: offer to fix

Once the report is presented, offer:

> "I can apply the fixes above. Which findings should I address? (You can say 'all',
> 'blockers only', list severities, or name specific findings.)"

On approval:

- Apply edits using `figma-design` mechanics (token binding, renaming, layout fixes).
- Re-run the affected dimension(s) and confirm the finding is resolved.
- Do not re-run the full review unless asked.

### Routing tool-limit findings

If a finding cannot be fixed with the available tools (e.g. the required Figma API is
not exposed, or the fix would need a `delete_styles` / `delete_variables` call that
doesn't exist), do **not** invent a workaround that breaks the design. Instead:

1. Note in the report: `Fix: (tool limitation — see figma-feedback)`.
2. After the report, file a `record_feedback` entry under the `proposals` category
   using the `figma-feedback` skill format.
3. Tell the user the limitation has been logged and what the manual workaround is.

---

## Detailed thresholds

Concrete numbers, formulas, spacing scales, and naming patterns are in
`references/checks.md`. Load it when reviewing — it prevents guessing at thresholds.

## Review basis

Before checking any dimension, load what you measure against. The basis is three layers: the
`figma-design` basic doctrine, the `figma-bridge-prefs` house preferences (when present), and
your own non-overridable floor.

**Load `figma-design`** — the basic design doctrine the designer built with (design-system-first,
component-first, and the naming _floor_ of a meaningful, non-default name). **Ensure it is
loaded** (load it if not yet loaded), **then read its references if you have not already read
them this session** — the read is **not** gated on the skill being freshly loaded. This is the
basic-rules layer you review the design against.

**Load `figma-bridge-prefs` if present** — if a skill of that **exact** name (not a prefix or
substring) is in your available skills, **ensure it is loaded** (load it if not yet loaded),
**then read its `references/review-standards.md` if you have not already read it this session**
— again the read is **not** gated on the skill being freshly loaded. (In a figma-designer
self-review both skills are already loaded from the build pass, so a load-gated read would
silently skip the house standards — reuse them, don't reload.) It supplies the concrete house
scale / tokens / type ramp / naming _convention_ you measure against, and may add stricter
checks. If none is present, you may offer to run `figma-setup` to create one.

**Graceful degradation.** If you loaded a skill but could not read its reference, **say so and
proceed on the basic floor** — do not proceed as if its standards applied. If
`figma-bridge-prefs` is present but its `review-standards` is missing or unparseable, treat it
as **no house standard** — fall back to `figma-design` basics + internal-consistency + the
floor, and never error.

**The floor is non-overridable.** Neither loaded skill can relax it: **verification (export +
read-back) and destructive-op safety** are yours alone; you still emit those findings.
Accessibility is **not** in this floor — it is a user preference: check it against the loaded
`figma-bridge-prefs` thresholds, and with no prefs it is unchecked (assert no threshold). You
measure the design against `figma-design` basics + `figma-bridge-prefs` preferences + this floor.
