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

## The six dimensions

### 1. Design-system adherence *(context-aware)*

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
- **Off-scale spacing / padding** — layout `gap` or `pad` values that don't sit on
  the project's spacing scale (see `references/checks.md`). If no explicit scale is
  discoverable, flag values that are not multiples of 4.
- **Inconsistent corner radius** — radii that differ across sibling cards/chips/buttons
  without an obvious intent to differ; or a mix of per-corner and uniform radii for the
  same element type.
- **Type off the ramp** — font sizes that are not on the project's type scale; or more
  than 4 distinct sizes in one frame without a clear hierarchy.
- **Misaligned or off-grid elements** — siblings in an auto-layout frame whose sizes
  or positions suggest manual override (check `layoutPositioning: ABSOLUTE` on
  children in a flow-mode frame).

### 3. Accessibility

Check regardless of design system:
- **Text contrast** — compare text `color` against the background `fills` of the
  nearest ancestor frame. Apply WCAG AA thresholds:
  - Normal text (< 18 pt, not bold; < 14 pt bold): contrast ratio ≥ 4.5:1
  - Large text (≥ 18 pt regular, ≥ 14 pt bold): contrast ratio ≥ 3:1
  (Thresholds and the contrast-ratio formula are in `references/checks.md`.)
- **Minimum text size** — body / label text below 11 px is a nit; below 9 px is a
  warning (unreadable at standard screen densities).
- **Touch-target size** — interactive elements (buttons, icon buttons, links) whose
  bounding box is smaller than 44 × 44 pt are a warning.
- **Meaning by colour alone** — status indicators or data visualisation that conveys
  meaning exclusively via hue (no label, icon, pattern, or shape difference).

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
legible `name`, and any `context` note should be well-formed. (The naming *opinions* —
what a good name is — live in the `figma-design` skill; this dimension only audits.)

- **Blank or default name** — a `name` that is empty, whitespace-only, or matches
  Figma's default-name pattern (`Frame 12`, `Rectangle`, `Ellipse 3` — the full regex
  is in `references/checks.md`). Nameless nodes block agent and developer targeting.
  - **Text-node exemption:** a text node's `name` may legitimately equal its
    `characters`, so a text node is flagged **only when its name is blank** — never for
    mirroring its own content or the default pattern.
- **Component without a `/` taxonomy** — a `COMPONENT` / `COMPONENT_SET` whose name has
  no slash path (`Button` rather than `Button/Primary`). **Variant children** (names
  containing `=`, e.g. `Size=Lg, State=Hover`) are exempt.
- **Malformed or oversized context** — a `context` value with an unclosed frontmatter
  fence (yields no `contextSummary`, so the note is invisible at a glance), or one that
  exceeds the 2 KB cap (only reachable via the `set_plugin_data` escape hatch).
- **Name ↔ context.role contradiction *(advisory)*** — when a node's `name` and its
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
  threshold (e.g. WCAG AA contrast fail, completely missing section).
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
