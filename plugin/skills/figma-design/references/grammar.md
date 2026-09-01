---
name: figma-design/grammar
description: Self-contained snapshot of the atom value formats used by the figma-agent-bridge tools. Load when writing or reading any color, font, gradient, effect, stroke, sizing, or constraint value.
---

# Value grammar reference

This is a **self-contained** snapshot of the atom formats used by the MCP tools.
The canonical source is `docs/specs/expression-formats.md` in the repo; this copy
ships with the plugin since the spec file does not.

---

## Two output categories

| Category | What | Rendered as |
|---|---|---|
| **Struct** | composite with named fields | YAML in `inspect`; JSON in every other read |
| **Atom** | single leaf value | compact string (this grammar) — identical either way |

Structs contain atoms as field values. All atoms share one shape.

---

## The atom shape

```
[ style(Name) | var(Name) ]  value  [ { key=val, key=val } ]
```

Three parts, always in this order:

1. **Wrapper** *(optional)* — `style(Name)` or `var(Name)` marks a design-system
   source; the **resolved value always follows**. Legal on every atom type.
2. **value** — one of: a bare **literal** (`8`, `#3B82F6`, `MULTIPLY`, `true`), a
   **tuple** (`[8,8,0,0]`, `[FILL,HUG]`), or a **head** (`kind(args…)`).
3. **`{ … }`** *(optional)* — optional/rare fields, comma-separated `key=val`.
   Omitted when empty; always trailing.

A field holding many atoms (e.g. `fills`) is an array of atoms — **unless a style
owns it**, and then the whole field is one reference atom (**A styled field is a
reference, not a list**, below).

**Canonical form (what reads emit):** `{…}` trailing, head args unspaced
(`font(Inter,SemiBold,18)`), gradient stops spaced (`linear(135, #FF0000@0, #00FF00@100)`).
The parser also accepts inner-arg form and arbitrary whitespace.

**`path()` and `stroke()` refuse an atom they cannot read.** A missing fill rule
(`path(M 0 0 L 24 24)`) or a weight that is not a number (`stroke(fat)`) is
`INVALID_PARAM`, raised before the write reaches the document, with the canonical form in
the message. Neither head has a literal half to fall back on — the whole shape lives in
the data string, and a weight that is not a number is no weight — so a degrade would write
nothing and call it success.

**Everywhere else, state every positional arg the family section names.** `font(Inter)` is
not `font(Inter,Regular,16)` with the blanks filled in, and `linear(135)` is not a gradient
with default stops: a short atom is written as it stands and the missing piece lands empty.
Take the canonical form from the family section below, or from a read of a node that
already carries the value you want — a read emits the canonical form.

**An engine refusal is the other case and it degrades:** a value that parses but that
Figma rejects lands the node, drops that one field, and reports Figma's own error on
`warnings[]`.

---

## Paints — `fills[]`, `strokes[]`

| Variant | Form |
|---|---|
| solid | `#3B82F6` · `#3B82F680` · `solid(#3B82F6)` · `rgba(59,130,246,0.5)` |
| linear gradient | `linear(135, #FF0000@0, #00FF00@50, #0000FF@100)` — a stop may carry a binding: `linear(135, var(brand/violet)#7C5CFF@0, var(brand/cyan)#22D3EE@100)` |
| radial gradient | `radial(#FFFFFF@0, #00000000@100)` |
| angular gradient | `angular(#FF0000@0, #00FF00@33, #0000FF@66)` |
| diamond gradient | `diamond(#FF0000@0, #0000FF@100)` |
| image | `image(HASH)` — write also accepts `image(url)` |
| video | `video(HASH)` |
| pattern | `pattern(componentId)` |

Notes:
- `solid()` is optional — a bare hex color is a solid paint.
- Color: `#RRGGBB`, `#RRGGBBAA` (hex always **uppercase, 6 or 8 chars**, no
  shorthand); `rgb(r,g,b)`, `rgba(r,g,b,a)` (a = 0–1) accepted on write.
- Gradient stops: `#color@percent`, optionally wrapper-bound —
  `var(Name)#color@percent` binds that stop's color to the named variable on write,
  and a read emits the wrapper per stop. A name that resolves to nothing degrades to
  the literal with a warning naming the stop, like every `var()`. Angle is
  **linear-only** (first arg). Radial, angular, diamond carry no angle; non-trivial
  geometry goes in `{tf=[a,b,c,d,e,f]}`.
- `image(url)` is write-only sugar — reads always emit `image(HASH)`.
- `{…}` keys for any paint: `op=` (paint opacity), `blend=` (blend mode),
  `vis=false` (hidden). Image/video extras: `scale=` (FILL/FIT/CROP/TILE), `rot=`,
  `tile=`, `filter=`.
- **A paint style owns the whole field**, so a styled `fills` is not an array at all:
  `fills: style(Glass/Fill)[#141B2E99]` (below).

---

## Effects — `effects[]`

| Variant | Form |
|---|---|
| drop shadow | `shadow(x,y,radius,color)` — e.g. `shadow(0,4,8,#00000040)` |
| inner shadow | `inner-shadow(0,2,4,#00000020)` |
| layer blur | `blur(radius)` — e.g. `blur(10)` |
| background blur | `bg-blur(20)` |

`{…}` keys: `spread=`, `blend=`, `vis=false`, `behind=true` (show behind node).

**An effect style owns the whole field** — `effects: style(AB/Blur)[bg-blur(24)]`,
never a style beside literal siblings (below).

---

## Typography — `font`

```
font(Inter, Semi Bold, 18)
font(Inter, Semi Bold, 18, {lh=24, ls=0.5})
style(Heading/H1)font(Inter, Bold, 32)
```

- Positional: `Family, Style, Size` (px).
- `Style` is Figma's `fontStyle` field (e.g. `Regular`, `Medium`, `SemiBold`, `Bold`,
  `Italic`, `Bold Italic`).
- The `Style` value must match the family's **registered** style name exactly — some
  families space it (Inter registers `Semi Bold`, not `SemiBold`); `list_fonts` returns the
  registered names.
- `{…}` keys: `lh=` (line height — `24` px or `150%`), `ls=` (letter spacing, px).
- `style(Name)` wrapper + resolved `font(...)` following — the resolved value always
  trails the wrapper.

---

## Stroke geometry — `stroke`

Stroke paint(s) live in `strokes[]` (paint atoms). Stroke geometry is a separate atom:

```
stroke(2)
stroke(2, {align=INSIDE, cap=ROUND, join=MITER, miter=4, dash=[4,4]})
stroke([2,0,2,0])        # per-side weights [top, right, bottom, left]
```

- Positional = uniform weight (number) **or** `[t,r,b,l]` tuple for per-side.
- `{…}` keys: `align=` (CENTER/INSIDE/OUTSIDE), `cap=`, `join=`, `miter=`,
  `dash=[…]` (arbitrary-length dash pattern).

---

## Vector geometry — `vectorPaths[]`

SVG path data for a VECTOR node. **Both arguments are required, fill rule first:**

```
path(NONZERO,"M 0 0 L 24 24 L 0 24 Z")
path(EVENODD,"M0 0 L100 0 L100 100 Z"){corners=[0:12,2:4]}
```

- Fill rule: `NONZERO` | `EVENODD` | `NONE`.
- Data: the SVG path string, in double quotes. A comma inside it is a separator like a
  space and is normalized to one on write, so data copied straight out of an SVG file
  lands as written. **`H`, `V`, `S`, `T` and `A` are normalized too** — Figma's converter
  refuses all five, and each is pure syntax sugar over a command it takes (`H`/`V` become
  `L`, `S`/`T` become `C`/`Q` with the mirrored control point, an arc becomes cubics), so
  the surface performs the rewrite rather than handing you a refusal you could only answer
  by doing it yourself. Data with none of them is passed through unchanged.
- The field is an array — `vectorPaths: [path(…), path(…)]` — and both `create_node` and
  `update_node` write it, so the `vectorPaths` a read emits is writable back verbatim.
  On an update the assignment rebuilds the node's network **and resizes the node to the
  new path bounds**, so a `size` in the same patch is applied after the geometry — and it
  **walks the node to the path minimum**, so `position` translates the frame the data
  already set (`final = stated + that walk`) rather than replacing it.

**Per-point detail rides in the `{…}` channel, sparsely** — three index-keyed lists
naming only the points that differ from the node's own value:

| Key | What it sets | Values |
|---|---|---|
| `corners=` | per-point corner radius | a number — `corners=[0:12,2:4]` |
| `caps=` | per-point `strokeCap` | NONE / ROUND / SQUARE / ARROW_LINES / ARROW_EQUILATERAL |
| `joins=` | per-point `strokeJoin` | MITER / BEVEL / ROUND |

The index is zero-based into the path's own points, in the order the data string visits
them. Each key has a node-level twin on `stroke(…)`, and exactly one of the two is
authoritative: when the points disagree, `stroke(…)` omits that key and the per-point
list carries the whole truth. The keys are read and written only while `vectorPaths`
holds a **single** entry — with several entries the index cannot name a point, so the
read drops them with a warning and a write is declined the same way.

**Forget the fill rule and the atom is rejected.** `path(M 12 0 L 24 24 Z)` is
`INVALID_PARAM`, and the message carries the canonical spelling. The whole shape lives in
the data string, so there is nothing to fall back on. Data that parses but that Figma
refuses — `path(NONZERO,"not path data")` — is the engine refusal instead: the node
lands, `vectorPaths` drops, and `warnings[]` names Figma's own error. A node type that
carries no path data warns as well, rather than swallowing the geometry.

---

## Geometry — corner radius, sizing, constraints

| Field | Form |
|---|---|
| corner radius | `8` (uniform) · `[8,8,0,0]` (TL,TR,BR,BL) |
| sizing | `[FILL,HUG]` — `[horizontal, vertical]`; values: FIXED / HUG / FILL |
| constraints | `[MIN,STRETCH]` — `[horizontal, vertical]`; values: MIN / MAX / CENTER / STRETCH / SCALE |

The `var()` wrapper applies uniformly: `var(radius/medium)8`.

---

## Scalars & enums

Bare literals: `opacity` `0.5` · `rotation` `45` · `blend` `MULTIPLY` ·
`visible` `true` · `clipsContent` `false`. All wrappable: `var(token/x)0.5`.
(The node-level field is `blend`; `blendMode` is Figma's own name for it and is
what a paint or effect entry carries internally.)

---

## `var()` and `style()` rules

- Both wrap **any** atom; the resolved literal **always follows** the wrapper. A
  wrapper with **no value** — `fills: [var(surface/2)]` — is an **error** on both
  faces: the wrapper names the binding, the literal *is* the value. The one form that
  is not this is a bare `style(Name)` standing as the whole content of `fills`,
  `strokes`, `effects` or `grids`: that is a **reference** to the style that owns the
  field, and the style supplies the value (next section).
- **Both name their source** — `style(Brand/Primary)`, `var(radius/medium)`, never
  an opaque id. The name is what you reason with and what you would write back.
- **A wrapper with a value BINDS on write** — the pair round-trips. Write back the
  `var(surface/2)#141B2E` a read handed you and the write applies the literal **and
  then** binds by name: `var(Name)` binds the field to that variable, `style(Name)`
  applies the local style of that category. Literal first, binding second — the
  literal is what remains if the binding cannot be made, and a binding that lands
  governs the value from then on. So a read-modify-write **keeps** the binding it
  was shown instead of flattening it to a literal.
- **A name that resolves to nothing degrades, never aborts.** No such variable or
  style → the literal is applied and one `warnings[]` entry says so
  (`var(surface/2): no variable with that name — literal applied unbound`). A
  missing token costs a binding, never the write. Binding is **by name** only; an
  id inside a wrapper is not accepted. (A styled-field **reference** has no literal
  to keep, so there an unresolvable name is an error instead — next section.)
- **Where a wrapper binds:** `fills[]`, `strokes[]`, **gradient stops** (per stop,
  inside the gradient head), a **uniform** `stroke(…)` weight, a **uniform**
  `radius`, and the layout spacing scalars — `layout.gap` (with its GRID spellings
  `rowGap` / `colGap`) and each of the four `layout.pad` sides — for `var()`; `fills`, `strokes`, `effects`,
  `grids` (as the whole field) and `text.font` for `style()`; `text.color` for both.
  Anywhere else the literal still lands and a warning names what could not be bound
  — including the three the grammar splits finer than Figma's binding surface does:
  per-range `text.runs[].color`, per-corner `radius` (`[8,8,0,0]`), and per-side
  stroke weight (`stroke([0,0,1,0])`).
- **Spacing binds per slot, the way paints bind per entry.** A `var()` on `gap` wraps
  the number — `layout: {gap: var(space/8)8}` — and `pad` binds **per side, by
  position**, because Figma holds each padding side as its own field:
  `pad: [var(space/8)8, 16, var(space/8)8, 16]` binds top and bottom and leaves left
  and right literal. A read emits every wrapper it finds, an all-zero `pad` included
  when a side is bound (dropping it would drop the binding sitting on it), and **a
  layouted node always emits `gap` (and both grid gaps), `0` included** — a zeroed gap
  can never read as unset. Writing
  that struct back applies the number **and** re-establishes the binding.
  **One pair is refused at every write door:** `align: ["SPACE_BETWEEN", …]` with a
  **variable-bound** `gap` is self-contradictory (space-between means Figma owns the
  spacing); the error names the recovery (`bind_variable {clear: true}` on the gap,
  then write), and a literal gap beside SPACE_BETWEEN is fine. A `style()`
  on a spacing scalar finds no route and warns — a style cannot own one — and a
  spacing leaf that states no number is `INVALID_PARAM`, canonical spelling in the
  message.
- `bind_variable` / `apply_style` are still the explicit route — for binding a
  field a write is not otherwise touching, and for `bind_variable`'s
  collection-mode pin.
- **Every node a read returns complete carries its wrappers** — the node you asked
  for and, within `depth`, its descendants. A descendant's `style(Brand/Primary)`
  is not flattened to `#0A84FF`, so you can edit deep in a tree without a second
  read to discover what was bound.

---

## A styled field is a reference, not a list

Figma holds **one style link per field slot**, and a node has five slots — fill,
stroke, effect, text, grid (the five `apply_style` names). Each has one owner,
exclusively: a style owns the whole field, or the field is literal, and assigning the
field directly **detaches** the style (Figma's own behaviour). The slots are
independent, so a paint style on `fills` and an effect style on `effects` at the same
time is ordinary. A TEXT node's `text.color` **is** its first fill, so `fills` and
`text.color` are two spellings of one slot, not two.

The four array fields — `fills`, `strokes`, `effects`, `grids` — have exactly two
write forms:

```
effects: style(AB/Blur)                             # a reference — the style IS the field
effects: [bg-blur(24), shadow(0,8,24,#00000066)]    # a list of literals
```

A reference may carry the resolved list a read appends to it —
`effects: style(AB/Blur)[bg-blur(24)]` — and that means exactly what the bare
reference means: the list rides along and is **never applied as literals**. That is
what makes a read writable verbatim.

**Write sugar** (write-only — a read always emits the reference). Four array
spellings state one owner and normalise to the reference, so a spec written against
the older grammar still lands:

```
[style(AB/Blur)bg-blur(24)]                                 # the lone atom
[style(AB/Blur)]                                            # bare, in a one-entry array
[style(AB/Blur)[bg-blur(24)]]                               # the read form, array-wrapped
[style(AB/Blur)bg-blur(24), style(AB/Blur)shadow(0,8,24,#00000066)]   # every entry, SAME name
```

**A ride-along list that differs from the style is named, not obeyed.** The style
governs, so its own content lands either way and one `warnings[]` entry says what did
not: `style(AB/Blur) owns effects — it supplies [bg-blur(24)], so the 1 extra effect
written beside it was not applied; …`. A warning, never a rejection — writing a read
back verbatim never fires it.

**Four inputs are rejected** — `INVALID_PARAM`, before anything reaches the document:

1. a `style()` entry **beside literal siblings** in one field;
2. two or more **different** `style()` names in one field (same-name entries are the
   sugar above) — including the cross-field spelling, a different style on `fills`
   and on `text.color` of one TEXT node;
3. a name that resolves to a style of the **wrong type** for the slot — a paint style
   named on `effects`, an effect style named on `fills`;
4. a name that resolves to **nothing**.

Rules 1 and 2 are the mix the slot cannot hold, and the error teaches the fix: _a
style owns the whole effects list — use a style containing every effect you want, or
write them all as literals (a style cannot be combined with literal siblings)_.
Rules 3 and 4 are where a reference parts company with the degrade rule above: a
wrapper on a literal still has that literal, a reference has none, so degrading would
write nothing at all and call it success.

**A read emits the reference with its resolved list, brackets always:**

```yaml
fills: style(Glass/Fill)[#141B2E99]
effects: style(AB/Stack)[bg-blur(24), shadow(0,8,24,#00000066)]
```

A style holding one effect emits a one-entry list, so the form is read
unconditionally, never sniffed. **No entry inside the list carries a wrapper of its
own** — the style is named once, outside, and is the source of all of them, so a bare
hex in there is a styled value, not a hardcode. An unstyled field is the array of
atoms it has always been.

**What this does not change.** `text.font` is the text slot and a text style resolves
to a single font atom, so it keeps the scalar shape it has always had —
`style(Heading/H1)font(Inter,Bold,32)`, no brackets, and no reference form: the
resolved atom is required there. `text.color` is the same shape (it is the text
node's first fill). `var()` is untouched everywhere — a variable binds one paint, so
it wraps an **entry** and several entries may each carry their own:
`fills: [var(surface/2)#141B2E, #FFFFFF20]`. A `style()` names the owner of a field;
a `var()` names the source of an entry.

---

## Node struct fields (inspect / get_node)

The struct wrapping atom values. Shown as `inspect` renders it — YAML, the one
YAML reader. `get_node` / `get_nodes` return the **same fields with the same
atom strings**, serialized as JSON; only the container differs, never an atom.

```yaml
type: FRAME
name: Card
id: "12:34"
size: [320, 180]
fills:
  - solid(#FFFFFF)
  - linear(135, #3B82F6@0, #1D4ED8@100){op=0.08}
stroke: stroke(1, {align=INSIDE})
strokes:
  - '#E5E7EB'
effects: style(Elevation/Card)[shadow(0,4,12,#0000001A)]
radius: 12
layout: {mode: V, gap: 8, pad: [16,16,16,16], align: [MIN, MIN]}
sizing: [FIXED, FIXED]
constraints: [MIN, MIN]
children:
  - type: TEXT
    name: Title
    text:
      content: "Monthly report"
      font: style(Heading/H3)font(Inter,SemiBold,18){lh=24}
      color: '#111827'
  - type: TEXT
    name: Caption
    text:
      content: "Updated today"
      font: font(Inter,Regular,13)
      color: '#6B7280'
```

`fills` and `effects` above are the two shapes a styleable field takes: a literal
array, and the style that owns the field with the list it resolves to.

Key struct fields:
- **`layout`** — `{mode: H|V|NONE|GRID, gap, pad: [t,r,b,l], align: [primary, counter],
  wrap, rows, cols, rowGap, colGap, rowSizes, colSizes}`. `gap` / `align` / `wrap` are
  H/V-only; the six grid keys are GRID-only. `gap`, `rowGap`, `colGap` and each `pad`
  entry are number atoms, so a bound one carries its `var()` wrapper:
  `gap: var(space/8)8`.
  **`rowSizes` / `colSizes`** size the tracks one by one — a list of track atoms in
  CSS-grid's own vocabulary: `1fr` (a fraction of the free space; bare `fr` means one),
  `240px` (fixed; bare `240` is the same), `hug` (sized to its content). They describe
  tracks that already exist, so set `rows` / `cols` to the count you mean; naming more
  applies the ones that fit and warns.
- **`cell`** *(a direct child of a GRID frame)* — `{row, col, rowSpan, colSpan,
  align: [horizontal, vertical]}`. `layout` is what a node does to its children;
  `cell` is what its parent's grid does to it. `row` / `col` are 0-based cell anchors,
  the spans are positive integers, `align` is `MIN`/`CENTER`/`MAX`/`AUTO` per axis.
  This is the classic shell:

  ```yaml
  layout: {mode: GRID, rows: 3, cols: 3, rowSizes: [64px, 1fr, 1fr], colSizes: [240px, 1fr, 1fr]}
  # children:
  #   Header  cell: {row: 0, col: 0, colSpan: 3}
  #   Sidebar cell: {row: 1, col: 0, rowSpan: 2}
  #   Main    cell: {row: 1, col: 1, rowSpan: 2, colSpan: 2}
  ```

  On a child whose parent is not a GRID it is ignored, and the reply says so. A cell
  is held by at most one node: an occupied anchor, an overlapping span, or a span past
  the last track is refused per key with a warning — the rest of the write still lands.
  A read states `row` / `col` on every grid child (that is the only record of where it
  is), and states a span only past `1` and an align only past `AUTO`.
- **`text`** — `{content, font, color, align, valign, decoration, case, runs}`.
  Line height + letter spacing are on the `font(...)` atom (`{lh=, ls=}`), not
  separate top-level keys.
- **`sizing`** — `[horizontal, vertical]` atom (FIXED/HUG/FILL).
- **`layoutPositioning`** — `AUTO` | `ABSOLUTE` (child's flow participation).
- **`componentProperties`** *(INSTANCE)* — current property values. **Read-only** —
  set them with `set_instance`, which validates each against the component's
  definitions. Same for `variantProperties`, and for `id`, which Figma assigns.
  Echoing them back in a spec is safe; they are ignored, not applied.
- **`overrides`** *(INSTANCE)* — structured delta from main component.
- **`component`** *(INSTANCE)* — `{id}` for local, `{key}` for library/published.

---

## Tree reading model

Tree reads use **depth + budget + truncation receipt**:
- At the depth boundary a node becomes a stub `{id, name, type, size?, childCount}`.
  `size` is carried, never invented: a node the file holds no measured size for (a PAGE)
  omits it rather than padding `[0, 0]`.
- A budget cap prevents wide nodes from overflowing context.
- `truncated: [{id, childCount}]` names what was **cut**: a node dropped from the view
  outright, whatever it held, and a node returned as a stub whose subtree was cut. A
  collapsed leaf cut nothing and earns no entry. Drill into those ids, don't re-scan.

Flat list reads (`get_styles`, `get_variables`, search results) use an **opaque cursor**
for pagination, not depth/budget.
