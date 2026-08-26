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

**Read the field before you read the entry.** A styled field is a **reference**, not
an array: `fills: style(Glass/Fill)[#141B2E99]` is the whole field owned by a paint
style, and no entry inside those brackets carries a wrapper of its own — the style is
named once, outside. Those bare hexes are the style's own values, so a paint under
`style(…)[…]` is **bound**, never a candidate. Only the entries of a genuine array —
`fills: [#141B2E99, var(surface/2)#141B2E]` — are read entry by entry.

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

### Spacing tokens

Spacing binds and reads back like a paint does. `layout.gap` — with the GRID spellings
`rowGap` / `colGap` — and each of the four `layout.pad` sides carry a `var()` wrapper
when they are bound: `gap: var(space/8)8`, `pad: [var(space/16)16, 16, …]`. `pad` binds
**per side, by position**, so one bound side beside three literals is a real and
reportable state, not a read artefact.

So a **bare number is evidence**, the same way a bare hex is: it means the value is
unbound, not that the binding is invisible. Run the sweep when the file has a spacing
collection — scan `get_variables` for the value, and a bare `gap` / `pad` side equal to a
spacing token is a skipped binding → `warning`; a bare value that belongs to the scale but
matches no token → `nit`. Measure this rate too when the file has a spacing collection at
all: `N of M spacing values are bound` says more than a list of frames.

### Style matching

A text node is **on-style** when `inspect` shows `style(Style/Name)font(…)`. A bare
`font(…)` with no `style(…)` wrapper is a candidate for a style check.

To decide:

1. Call `get_styles` (filter `type: 'text'` — the categories are lowercase:
   `paint` / `text` / `effect` / `grid`).
2. Compare the node's `font(Family, Weight, Size){lh=…}` against each style's font
   atom. If a match exists (same family + weight + size, lh within 2 px) → `warning`.
3. Near-match (same family, different weight or ±2 px size) → `nit`.

**The other four slots are on-style at the field, not the entry.** `fills`,
`strokes`, `effects` and `grids` each read as the scalar reference when a style owns
them — `effects: style(AB/Blur)[bg-blur(24)]` — and as a plain array when nothing
does. So the detection is the shape of the field: a `style(…)` head means on-style,
an array means a candidate. Compare a candidate array against `get_styles` of the
matching category (`paint` / `effect` / `grid`) the same way.

### Component detection

Duplicate detection is **mechanical** — run this on every review, not on suspicion.

A node's **signature** is its child count plus the types of its first-level children,
sorted: `1 · [TEXT]`, `3 · [FRAME, TEXT, TEXT]`. A leaf's signature is `0 · []`.

**1. Inventory the real masters (two reads).** `get_components` enumerates components and
sets but **never a set's variant children** — and it is bounded (`limit` defaults to 100),
so page it with the returned `cursor` while `truncated` is true, or say in the report that
you checked the first N. Collect every `COMPONENT` and `COMPONENT_SET` id, then read them
all in one batch:

```json
{
  "nodeIds": ["<componentId>", "<componentSetId>", "…"],
  "depth": 2,
  "fields": ["id", "name", "type", "size", "children"]
}
```

`depth: 2` is what makes a variant set legible: a set's children _are_ its variants, so
depth 1 would hand you `[COMPONENT, COMPONENT]` — an anatomy of nothing. At depth 2 each
variant's own children come back, and since the projection applies to the top-level node
only, those children arrive with their `fills` and `text` intact — which is what step 3
needs. A **set contributes one inventory entry per variant child** (the variants are the
real masters); each entry is `{name, signature, size, first-level child descriptors}`,
using the set's name for a variant.

**2. Signature-match the target.** For every node in the target that is not an `INSTANCE`
and not a descendant of one, compute its signature and look it up. **No type filter and no
child-count floor**: a one-child `FRAME` duplicating a `Button` master, and a bare `TEXT`
duplicating a `Chip` master, are exactly the cases this check exists for.

**3. Corroborate before flagging.** A signature alone never flags — `2 · [TEXT, TEXT]` is
every card header in the file. Flag only when the signature matches **and at least one** of
these holds:

- **Name affinity** — the candidate's name, or its parent's, shares a ≥ 4-character
  case-insensitive stem with the master's name (compare the segment before `/` or `=`).
- **Size affinity** — both dimensions within ±10% of the master's (or ±4 px, whichever is
  larger).
- **Leaf affinity** — child for child, in order, the candidate's first-level children match
  the master's on type _and_ on the atom that carries their look: `text.font` for a TEXT
  child, the first `fills` entry otherwise — or, when a paint style owns `fills`, the
  reference the whole field is (`fills: style(Glass/Fill)[…]`), which is the stronger
  match of the two.

All three come out of reads you already have, and each one fails independently of the
signature: a copy inherits the master's wording, its geometry, or its paint — a coincidence
of shape inherits none of them.

**Ambiguity guard.** A signature that matches **≥ 3 different masters** is generic; skip
that candidate whatever the corroborators say.

Findings:

- Signature + ≥ 1 corroborator on a non-`INSTANCE` node → `warning`: detached or duplicated
  element — **name the master it matches and the corroborator that fired**.
- ≥ 2 siblings sharing a signature and a corroborator with **no** master matching →
  `warning`: component candidate.

**Skip what the design says is deliberate:** a candidate whose `context` (`purpose` /
`role`) or whose name declares a different role from the master's is a look-alike, not a
copy. Signature + corroborator is strong evidence, never proof — report what matched and
let the human judge.

### The block litmus (Q0)

Every direct child of a screen's content region — the `block/*` class —
must read back `type: INSTANCE`. A block-level FRAME with no master is a
`warning` naming Q0 (`figma-design` components.md §2): blocks are
components even at one occurrence. The design-system page missing its
census `context` note is a `nit`.

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

A bound value arrives wrapped — `gap: var(space/8)8` — so read the number out of the
wrapper for the scale check, and treat the missing wrapper as its own finding under
**Dimension 1 → Spacing tokens**. A value on the scale but unbound and a value bound to
a token off the scale are different problems and belong in different findings.

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
  background (when a style owns that field, the colour is inside `style(…)[…]` — read the
  atoms in the brackets), then flag against the user's contrast thresholds.
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

### Clipped effects — reach vs slack

Frames clip by default, so an outward effect can be perfectly present in the data and
absent from the render: the read-back returns the `effects` that were written, and an
ancestor swallows them. This check is **arithmetic — compute it, don't judge it.**

**Read the target unprojected.** `clipsContent` survives no narrowing profile at all, and
`effects` survives only `profile: 'style'` — which carries neither `clipsContent` nor
`size` / `position`, so no one narrowed read holds the fields this check needs, and
`inspect` applies its profile to _every_ node in the tree. Under a narrowed read the walk
finds no clipping ancestors and silently reports nothing. Read with no `fields` /
`profile`, or `profile: 'full'`.

Run it on every node carrying a `shadow(…)`, a `blur(…)`, or a
`stroke(…, {align=OUTSIDE})`. `inner-shadow(…)` and `bg-blur(…)` render inside the
node's own area — skip both.

**`effects` has two read forms, and reach is computed from both.** Unstyled, it is the
array of atoms — `effects: [shadow(0,8,24,#00000059), blur(4)]`. Styled, an effect
style owns the field and it is one scalar reference carrying the list it resolves to —
`effects: style(Elevation/Card)[shadow(0,4,12,#0000001A)]`. **Parse the
brackets and read the atoms inside**: a style's shadow paints exactly as far as a
literal one, so skipping the scalar form under-reports the check to zero on every
design-system node. `strokes`/`fills` take the same two forms; the `stroke(…)`
geometry atom is not styleable and always reads as itself.

**Skip anything rotated** — a rotated node's `size` is its own unrotated width and
height while its `position` is its bounding box's origin, so the two describe different
rectangles and slack computed from them is fiction. A non-zero `rotation` on the node or
on any ancestor in the walk means: no finding, and one line in the report saying the clip
check was skipped there and the PNG is the only judge.

**1. Reach, per side** — how far the paint extends past each edge of the node's box.
The offset decides which edges pay:

```
shadow(x,y,r){spread=s}   →  left   max(0, −x + r + s)
                             right  max(0,  x + r + s)
                             top    max(0, −y + r + s)
                             bottom max(0,  y + r + s)
blur(r)                   →  r on all four sides
stroke(w,{align=OUTSIDE}) →  w on all four sides

reach[side] = the largest of those present on the node, side by side
```

**2. Slack, per side** — for each ancestor that clips (reads emit `clipsContent` only
when it is `true`, so an absent field means that ancestor does not clip), express the
node's box in that ancestor's coordinates by summing the parent-relative `position`
values on the way up, then:

```
slack = [ left: x, top: y, right: W − (x + w), bottom: H − (y + h) ]
```

`[w,h]` is the node's `size`, `[W,H]` the ancestor's. Walk every clipping ancestor inside
the reviewed target. **The read's root node carries an absolute canvas position**, not a
parent-relative one — start the sum below it (or subtract it), or every node in the tree
comes out flush and the check reports a tree-wide fiction.

**3. Compare, side by side.** Any side where `slack[side] < reach[side]` → `warning`.
Anchor the finding on **the node that carries the effect** — its name / id fills the
finding header — and put the clipping ancestor, the side(s), and both numbers per side in
`Issue:`. `Fix:` is "give `<ancestor>` ≥ `<reach>` px of slack on `<side(s)>`", or "set
`clipsContent: false` on `<ancestor>`" when that ancestor exists only to group its
children.

Two words the report has to keep honest:

- **"may be clipped", not "is invisible".** `reach` is an **upper bound** — a shadow
  fades across its blur radius, so the last pixels it loses can be imperceptible. Report
  the arithmetic as a suspicion; the export PNG is the proof.
- **"fully clipped" is the stronger claim** and needs the stronger test: `slack[side] ≤ 0`
  on **every** side the effect reaches (`reach[side] > 0`) — the node is flush with or
  outside its ancestor all the way round, so nothing of the effect has anywhere to land.
  One flush side is a trimmed edge, not an invisible effect.

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

**A sweep with a mistyped filter fails, it does not over-return.** Every filter goes
inside `match` — `{scope, nodeId, match: {name, regex, type, …}}` — and an unknown key,
at the top level or inside `match`, is `INVALID_PARAM` naming the key it refused. So
`search({name: 'Frame'})` and `search({match: {namee: 'Frame'}})` both stop the sweep
rather than answering with the whole scope. Trust a search's row count only from a call
that was accepted.

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

## Dimension 7 — Responsiveness

**Floor dimension** — runs with or without `figma-bridge-prefs`. The probe is
threshold-free: "nothing escapes" is binary.

### The intent escape (check first)

Never flag geometry the request or brief states. A stated width ("sidebar is 240",
"canvas is 1440") is a reason; intrinsic art (icons, avatars, dots, plot frames) is a
reason. The dimension hunts **unforced** FIXED only. When in doubt whether a size was
specified, report the finding as advisory and say the intent is unresolved.

### Static audit

Read `sizing`, `minWidth`/`maxWidth`, and text width modes on the target:

- **FIXED sizing on a text-bearing node** with no stated reason → `warning`.
- **HUG-width multi-word text** (content contains whitespace and the node's horizontal
  sizing is HUG, inside a FILL/FIXED ancestor) → `warning` — this is the overflow
  mechanism.
- **Long text without a maxWidth** (single-line length beyond the house measure cap
  when prefs supply one; advisory without prefs) → `nit`.
- **A descendant whose bounds already escape its container** at authored size →
  `blocker` (it is broken before any resize).

### The squeeze probe (the verdict)

For each text-bearing master in the review target:

1. Clone one instance into scratch space (never the reviewed artifact).
2. Set the probe's width to the master's `minWidth`; with no floor, ~60% of its
   natural width.
3. Read all descendant bounds against the probe's container box.
4. **Any escape → `blocker`** on the master (name the escaping descendant and the
   overhang in px).
5. Delete the probe. The reviewed artifact is never mutated.

With `figma-bridge-prefs` installed, probe additionally at each house breakpoint width
from `review-standards.md`, and flag a text-bearing master that carries no min/max
contract → `warning` (prefs only — never asserted without them).

---

## Quick-reference severity table

| Dimension        | Blocker                                                                                                                                    | Warning                                                           | Nit                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| DS adherence     | —                                                                                                                                          | Hardcoded color/text with matching token/style; detached instance | Near-match token candidate                                       |
| Consistency      | —                                                                                                                                          | Off-scale spacing ≥ 4 px; > 4 type sizes; misaligned block        | Off-scale ≤ 3 px; radius rounding; type size ±2 px               |
| Accessibility    | contrast / touch-target / text-size / colour-alone — severity per the user's `figma-bridge-prefs` thresholds (**unchecked** when no prefs) | —                                                                 | —                                                                |
| Layout hygiene   | —                                                                                                                                          | Pile-up at [0,0]; effect may be clipped (reach > slack on a side) | Redundant nesting; hidden nodes; default constraints             |
| Fidelity         | Missing named section or feature                                                                                                           | Count mismatch; placeholder content                               | Extra elements not asked for                                     |
| Naming & context | —                                                                                                                                          | Blank/default-named frames/components; unclosed/over-cap context  | Default-named leaves; missing `purpose`; name↔role contradiction |
| Responsiveness   | Squeeze-probe escape; bounds already escaping at authored size                                                                             | Unforced FIXED on text-bearing node; HUG-width multi-word text; missing min/max contract (prefs only) | Long text without a maxWidth                                     |
