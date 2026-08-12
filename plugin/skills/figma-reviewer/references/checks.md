---
title: figma-reviewer — Per-Dimension Checks & Thresholds
type: reference
---

# Per-Dimension Checks & Thresholds

Concrete numbers, formulas, and naming patterns for the `figma-reviewer` skill.
Load this file when reviewing; the `SKILL.md` references it for every threshold.

---

## Dimension 1 — Design-system adherence

**Guard:** only applies when the file has a design system. Check via `get_variables`
(local variable collections) and `get_styles` (shared styles). If both return empty
results and `get_components` shows no shared library components in use, skip this
dimension entirely.

### Token matching

A fill color is **unhardcoded** when `inspect` shows `var(TokenName)#RRGGBB` — the
`var(…)` wrapper is proof the binding exists. A fill showing a bare `#RRGGBB` (no
wrapper) is a candidate for a token check.

To decide whether to flag it:

1. Call `get_variables` and scan the local color collection for the same hex value.
2. If a match is found → `warning`: the node uses a hardcoded value where a token
   exists and should be bound.
3. No match but the value clearly belongs to the palette (reused across many nodes) →
   `nit`: hardcoded value that could become a token.
4. One-off, decorative, or intentionally bespoke → skip.

An **exact** match is the highest-confidence hardcode there is — `warning`, never `nit`:
the palette was right and the binding was skipped. An inline `var(Name)#RRGGBB` write
binds as it lands, so a bare value equal to a token is a skipped binding, not a tool
limit.

**Measure the rate, don't just list offenders.** When more than 25% of the target's
token-valued paints carry no wrapper, add **one** summary finding stating the measured
binding rate (`N of M token-valued paints are bound`) alongside the per-node findings —
a scatter of individual warnings understates a systematic miss.

### Style matching

A text node is **on-style** when `inspect` shows `style(Style/Name)font(…)`. A bare
`font(…)` with no `style(…)` wrapper is a candidate for a style check.

To decide:

1. Call `get_styles` (filter `type: TEXT`).
2. Compare the node's `font(Family, Weight, Size){lh=…}` against each style's font
   atom. If a match exists (same family + weight + size, lh within 2 px) → `warning`.
3. Near-match (same family, different weight or ±2 px size) → `nit`.

### Component detection

Check for duplicate subtrees:

- Two or more sibling frames/groups with the same `name` prefix and same child count
  and same layout mode → `warning`: consider making one a component and the others instances.
- A node of `type: FRAME` or `GROUP` whose structure exactly mirrors a known component
  in `get_components` but is not `type: INSTANCE` → `warning`: detached instance.

---

## Dimension 2 — Consistency

### Spacing scale

Preferred: use the project's spacing variable collection if one exists (look for a
collection named `Spacing`, `Space`, or `Scale` in `get_variables`). Extract the
values and treat them as the canonical scale.

The concrete house spacing scale is a **user preference**: when a `figma-bridge-prefs`
skill is installed, use its `references/review-standards.md` scale. Absent it — or if
`figma-bridge-prefs` is present but its `review-standards` is missing or unparseable — do
**not** assert a shipped scale and never error: fall back to **internal consistency** —
flag spacing that is inconsistent with the file's _own_ prevailing step (the value used
most across siblings). See `docs/specs/customization.md` §11 in the repo (not shipped) (P1).

Severity:

- Off-scale by 1–3 px (rounding slip) → `nit`
- Off-scale by ≥ 4 px (likely deliberate non-scale value) → `warning`
- Off-scale in a prominent spacing (card padding, section gap) → `warning`

What to check:

- `layout.gap` on auto-layout frames
- `layout.pad` (each of top/right/bottom/left) on auto-layout frames
- `size` (width/height) on spacing/divider nodes

### Corner radius

Severity thresholds:

- Mixed radii across sibling elements of the same semantic type (e.g. cards)
  differing by > 2 px → `warning`
- A mix of per-corner (`[TL,TR,BR,BL]` tuple) and uniform (`N`) on the same element
  type without a clear reason → `nit`

### Type scale

Extract all distinct font sizes from the frame (from `inspect`). Flag if:

- Any size is not a member of the project's type-scale variable (if one exists).
- More than 4 distinct sizes in one frame without a clear hierarchy → `warning`
- A size differs from the nearest scale step by 1–2 px → `nit` (likely a rounding error)

The concrete house type ramp is a **user preference**: when a `figma-bridge-prefs` skill
is installed, use its `references/review-standards.md` ramp as the target. Absent it (or
if `review-standards` is missing / unparseable), do **not** assert a shipped list — check
the frame's **own prevailing ramp** for consistency (flag sizes that don't sit on the ramp
the file itself uses most). See `docs/specs/customization.md` §11 in the repo (not shipped).

### Alignment

Flag `layoutPositioning: ABSOLUTE` on children of an auto-layout frame that are **not**
intentional overlays:

- A badge, tooltip, or floating action button overlapping another element → likely intentional.
- A regular content block sitting next to other flow children → `warning`: should be a
  flow child, not absolutely positioned.

---

## Dimension 3 — Accessibility

Accessibility is a **user preference** (`docs/specs/customization.md` §7 in the repo, not
shipped): the concrete standards — contrast ratios, minimum text size, touch-target size — live in the
user's `figma-bridge-prefs` `references/review-standards.md`, **not** here. This section holds only
the _how-to_ (what to look at, and how to compute contrast). **Load the thresholds from the
`figma-bridge-prefs` `review-standards` before flagging.** With no `figma-bridge-prefs`
`review-standards`, accessibility is **unchecked** — you may compute the ratios, but do **not**
assert a threshold or fabricate a shipped minimum (there is none).

### What to look at

- **Text contrast** — compute the contrast ratio (formula below) of text against its nearest
  background, then flag against the user's contrast thresholds.
- **Minimum text size** — read each text node's size, then flag against the user's minimum-text-size
  standard.
- **Touch-target size** — measure the bounding box of interactive nodes, then flag against the
  user's touch-target standard. "Interactive" in Figma context: nodes named with verb patterns
  (`Button`, `Btn`, `CTA`, `Link`, `Toggle`, `Checkbox`, `Radio`, `Icon-*`), or nodes with
  `reactions` set.
- **Meaning by colour alone** — a status indicator (e.g. `type: ELLIPSE` or a solid `FRAME`) or a
  data series that conveys state only through hue, with no accompanying text label, icon, or shape
  change. Flag against the user's accessibility standard (this affects users with colour-vision
  deficiency).

### Contrast ratio formula

Relative luminance of an sRGB color `(R, G, B)` where each channel is 0–255:

```
For each channel c in {R, G, B}:
  c_sRGB = c / 255
  if c_sRGB <= 0.04045:
    c_lin = c_sRGB / 12.92
  else:
    c_lin = ((c_sRGB + 0.055) / 1.055) ^ 2.4

L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
```

Contrast ratio between foreground luminance `L1` and background luminance `L2`
(where `L1 >= L2`):

```
ratio = (L1 + 0.05) / (L2 + 0.05)
```

When the background is a gradient, use the **darkest** stop for light text and the
**lightest** stop for dark text (conservative — flags if any stop fails).

When the text or background has `opacity < 1`, apply the opacity to the alpha channel
before computing luminance.

The severity of each finding (blocker / warning / nit) is whatever the user's
`figma-bridge-prefs` `review-standards` assigns; the reviewer ships none.

---

## Dimension 4 — Layout & structure hygiene

Default-name auditing moved to **Dimension 6 — Naming & context legibility**.

### Pile-up at [0,0]

Flag when ≥ 3 sibling nodes share `position: [0, 0]` at the page root and none of them
has an auto-layout parent. Severity: `warning`.

### Constraint defaults

Check `constraints: [MIN, MIN]` (Figma's default) on nodes inside a fixed-size frame
that has no auto-layout (`layout.mode: NONE`). Flag when there are ≥ 2 sibling nodes
all with default constraints in a frame that appears to be a responsive layout container
(width ≥ 320 px, has text and interactive elements). Severity: `nit`.

### Redundant nesting

A node qualifies as redundant if **all** of:

- `type: FRAME` or `type: GROUP`
- Exactly one child
- `fills: []`, `strokes: []`, `effects: []` (no decoration)
- No named role (name matches a default-name pattern)
- The child's own constraints or layout mode would work the same without the wrapper

Severity: `nit`.

### Orphan / hidden nodes

| Case                                                         | Severity |
| ------------------------------------------------------------ | -------- |
| `visible: false` node not part of a component variant set    | `nit`    |
| Node with `size: [0, 0]` (zero-area)                         | `nit`    |
| Node positioned entirely outside the frame's clipping bounds | `nit`    |

---

## Dimension 5 — Fidelity to intent

No fixed thresholds — this dimension is relative to the stated request. Checklist:

1. **Parse the request** for:
   - Named elements ("a sidebar", "three stat cards", "a search bar")
   - Counts ("four items", "two columns")
   - Specific content ("show the user's name", "use the primary button style")

2. **Match against the built design:**
   - For each named element: is it present? Is it in the right position relative to
     others (e.g. sidebar on the left, nav at the top)?
   - For each count: does the design match?
   - For each content spec: is real content shown, not placeholder?

3. **Check for extras:**
   - Placeholder nodes (`"Lorem ipsum"`, `"Placeholder"`, `"TODO"` in text content)
   - Test or debug frames not part of the design
   - Boilerplate from a template that wasn't part of the request

Severity:

- Missing a named section or feature → `blocker`
- Count mismatch (2 cards instead of 3) → `warning`
- Placeholder content in a real content slot → `warning`
- Minor extra elements not asked for → `nit`

---

## Dimension 6 — Naming & context legibility

### Default-name patterns

The canonical default-name regex (case-insensitive), matching Figma's auto-generated
names with or without a trailing number:

```
^(Frame|Group|Rectangle|Ellipse|Line|Polygon|Star|Vector|Component|Component Set|Instance|Slice|Image|Section|Boolean|Union|Subtract|Intersect|Exclude)(\s+\d+)?$
```

Feed this same pattern to `search` (`match.regex`) to enumerate offenders server-side,
cursor-paginated, instead of walking the tree. A name that is empty or whitespace-only
is always flagged.

**Text-node exemption:** a text node (`type: TEXT`) may legitimately be named after its
own content, so a text node is flagged **only when its name is blank / whitespace** —
never for matching its `characters` or the default pattern.

Severity:

- Root-level frames / page sections → `warning` (agents and developers target them by name)
- Component masters and variants → `warning`
- Blank name on any targetable node → `warning`
- Leaf content nodes inside a component → `nit`
- Purely decorative or structural helpers → `nit`

### Context well-formedness

The full `context` value is on `get_node`; the `contextSummary` slice is on `inspect` /
`search` / `get_components`. A malformed `context` yields **no** `contextSummary`, so the
note is silently invisible at a glance — worth flagging.

| Case                                                                                      | Severity                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Frontmatter fence opened (`---`) but never closed                                         | `warning`                                          |
| `context` exceeds 2 KB (`CONTEXT_MAX_BYTES`; only via the `set_plugin_data` escape hatch) | `warning`                                          |
| Missing `purpose:` in the frontmatter                                                     | `nit` (advisory — convention, not server-enforced) |

### Name ↔ context.role agreement (advisory)

When a node carries both a `name` and a `context` `role`, they should tell the same
story; a node named `SecondaryButton` with `role: button/primary` is contradictory.
Always `nit` / advisory — never a hard fail, since either field could be the stale one.

---

## Quick-reference severity table

| Dimension        | Blocker                                                                                                                                    | Warning                                                           | Nit                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| DS adherence     | —                                                                                                                                          | Hardcoded color/text with matching token/style; detached instance | Near-match token candidate                                       |
| Consistency      | —                                                                                                                                          | Off-scale spacing ≥ 4 px; > 4 type sizes; misaligned block        | Off-scale ≤ 3 px; radius rounding; type size ±2 px               |
| Accessibility    | contrast / touch-target / text-size / colour-alone — severity per the user's `figma-bridge-prefs` thresholds (**unchecked** when no prefs) | —                                                                 | —                                                                |
| Layout hygiene   | —                                                                                                                                          | Pile-up at [0,0]                                                  | Redundant nesting; hidden nodes; default constraints             |
| Fidelity         | Missing named section or feature                                                                                                           | Count mismatch; placeholder content                               | Extra elements not asked for                                     |
| Naming & context | —                                                                                                                                          | Blank/default-named frames/components; unclosed/over-cap context  | Default-named leaves; missing `purpose`; name↔role contradiction |
