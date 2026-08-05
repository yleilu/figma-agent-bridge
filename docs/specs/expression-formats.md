---
title: figma-agent-bridge Spec — Expression Formats
created: 2026-06-22T17:00:00+08:00
tags:
  - spec
  - figma-bridge
  - expression-formats
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
---

# Expression Formats

> Governed by [[figma-bridge/docs/principles|the principles]] (T8 — one expression grammar, one source of truth; T1 — symmetric facade; T4 — token efficiency).

## Why this format exists

This is the **inspect / view** representation (principle T3). Its job is to let an
agent read a whole design tree **within its context budget** — a verbose tree
would overflow context and force the agent to save-to-file and read in chunks.
So every value is encoded as compactly as it can be while staying learnable.

The **write** side (`create_node` / `update_node`) has no such pressure — it
builds one node or subtree, not a whole document — so it is a **separate, more
explicit** representation and may accept friendlier notations (e.g. `rgba(...)`).
The two are **semantically** round-trippable (the same values are expressible
both ways), but their syntax can differ. The view is deliberately lossy where the
edit form is faithful — see T3.

## Two categories

Everything an agent reads is one of two things:

| Category | What it is | Rendered as | Examples |
|---|---|---|---|
| **Struct** | a composite with named fields | **YAML** (readable; prior research shows YAML reads best for agents) | the node, `layout`, `text` |
| **Atom** | a single leaf value | a **compact string** (the atom grammar below) | paints, gradients, font, effects, stroke, radius, sizing, constraints, scalars |

- **Structs contain atoms** as their field values (a `text` struct's `font:` and
  `color:` are atoms) — with a few **plain-string scalar fields** (`name`, `id`,
  `text.content`, `context`) that are not atom-grammar values.
- **Style tokens resolve to atoms** — a named style is the `style(...)` wrapper
  with its resolved atom following.
- All **atoms share one shape**, so an agent learns the pattern once and can read
  (and the write side can produce) any value type.

## The atom shape

```
[ style(Name) | var(Name) ]  value  [ { key=val, key=val } ]
```

Three parts, the same for every atom:

1. **Wrapper** *(optional, universal)* — `style(Name)` or `var(Name)` marks a
   design-system source; the **resolved value always follows** so the agent sees
   both the source and the appearance. Legal on *every* atom (color, font,
   radius, anything) — there are no special cases.
2. **value** — one of three forms (below). This is the compact core.
3. **`{ … }`** *(optional, universal)* — the one channel for optional / rare
   fields, on *any* atom. Omitted when empty, so the common case stays terse.
   Comma-separated `key=val`.

**value** is exactly one of:

- a **literal** — a number, hex color, enum, or boolean: `8`, `#3B82F6`, `MULTIPLY`, `true`
- a **tuple** — fixed positional group in brackets: `[8,8,0,0]`, `[FILL,HUG]`, `[MIN,STRETCH]`
- a **head** — `kind(positional, …)` for structured values: `linear(...)`, `font(...)`, `shadow(...)`, `stroke(...)`

A field that holds many atoms (e.g. `fills`) is a YAML array of atoms.

> **Canonical rendering (what the view emits) vs. what the parser accepts.** The view
> renders `{…}` as a **trailing** block (`font(...){lh=24}`), head args **unspaced**
> (`font(Inter,SemiBold,18)`, `shadow(0,4,8,#00000040)`) **except gradients**, whose stops are
> **spaced** (`linear(135, #FF0000@0, #00FF00@100)`), and `{…}` keys comma-space separated. The
> parser additionally **accepts and normalizes** the inner-arg form (`font(Inter,SemiBold,18,{lh=24})`),
> arbitrary whitespace, and write-only sugar (`rgb()`/`rgba()`/`solid()`/`image(url)`) — but reads
> always emit the canonical form, so `renderAtom(parseAtom(s))` is stable. (The examples in the
> sections below mix the spaced inner-arg form for readability; the canonical/round-tripping form
> is as stated here.)

## Atom reference

Every variant of every family below is the same `kind(...){…}` shape (or a bare
literal/tuple). The `{…}` keys are listed per family — those are where the long
tail lives, so the core stays short.

### Paints — `fills[]`, `strokes[]`

| Variant | Form |
|---|---|
| solid | `#3B82F6` · `#3B82F680` · `solid(#3B82F6)` · `solid(rgb(0,0,0))` · `rgba(59,130,246,0.5)` |
| linear gradient | `linear(135, #FF0000@0, #00FF00@50, #0000FF@100)` |
| radial gradient | `radial(#FFFFFF@0, #00000000@100)` |
| angular gradient | `angular(#FF0000@0, #00FF00@33, #0000FF@66)` |
| diamond gradient | `diamond(#FF0000@0, #0000FF@100)` |
| image | `image(HASH)` · write also `image(url)` |
| video | `video(HASH)` |
| pattern | `pattern(sourceNodeId){shape=RECT, tile=1, gap=[0,0], align=CENTER}` |

- **Solid:** `solid()` is **optional** — a bare color *is* a solid paint. Color
  notations: `#RRGGBB`, `#RRGGBBAA`, `rgb(r,g,b)`, `rgba(r,g,b,a)` (a = 0–1). The
  view emits hex (most compact); the write parser accepts all.
- **Gradients:** `linear`'s first arg is the angle in degrees (derived from Figma's
  `gradientTransform`). **Angle is linear-only** — `radial`, `angular`, and `diamond`
  carry no angle (the build side never converts angle back to a transform for them);
  non-trivial geometry for any gradient goes in `{tf=[a,b,c,d,e,f]}`. Stops are `#color@percent`.
- **`{…}` keys (any paint):** `op=` (paint opacity — on a **SOLID** this is the
  *same* channel as the colour's alpha, since Figma's `SolidPaint` carries an RGB
  colour and one opacity and has no separate colour alpha; `#RRGGBBAA` and `{op=}`
  are two spellings of it, and a read emits the compact hex form. On a gradient or
  image the paint's opacity is genuinely distinct from the stop/pixel alpha),
  `blend=` (blend mode), `vis=false` (hidden paint). Image/video also: `scale=`
  (FILL/FIT/CROP/TILE), `rot=` (0/90/180/270), `tile=` (scaling factor),
  `filter=` (exposure/contrast/…). Non-trivial gradient geometry: `tf=[a,b,c,d,e,f]`.
- **Pattern:** tiles a source node across the shape. Figma marks four fields
  **required**, so the grammar always emits them and supplies a default when a write
  omits one: `shape=` tile shape — `RECT` (default) / `HEX-H` / `HEX-V`; `tile=`
  scaling factor (default `1`, the same key and meaning as an image's); `gap=[x,y]`
  spacing between tiles (default `[0,0]`); `align=` horizontal alignment — `START` /
  `CENTER` (default) / `END`. A pattern paint missing any of them is rejected at the
  Figma boundary, so partial emission is never valid.

  > **The shipped Figma runtime rejects `PATTERN` outright — a write will fail.**
  > `@figma/plugin-typings` declares `PatternPaint` (unchanged across 1.123–1.132) and
  > this grammar matches it field for field, but the app validates fills against a
  > discriminator that omits `PATTERN` and includes `SHADER`: *"Invalid discriminator
  > value. Expected 'SOLID' | 'SHADER' | 'GRADIENT_*' | 'IMAGE' | …"*. The rejection is
  > at the type, before any field check, so a complete paint fails exactly like a
  > partial one. The form above stays specified because it is Figma's published
  > contract and is what the surface will emit the moment the runtime accepts it.
  > **Delete this note once a pattern fill applies**; nothing else here changes.
- **Image source (write asymmetry):** the view always emits `image(HASH)`; the
  **write parser also accepts `image(url)`** — the server creates the hash
  (`createImageAsync`, deduped by URL). The `create_image(url|bytes)` tool is the
  explicit path for raw **bytes** and for pre-creating a reusable hash. Like
  `rgba()`, `image(url)` is write-only; reads always emit `image(HASH)` so it
  round-trips.

### Effects — `effects[]`

| Variant | Form |
|---|---|
| drop shadow | `shadow(0,4,8,#00000040)` — `x,y,radius,color` |
| inner shadow | `inner-shadow(0,2,4,#00000020)` |
| layer blur | `blur(10)` — radius |
| background blur | `bg-blur(20)` |

- **`{…}` keys:** `spread=`, `blend=`, `vis=false`, `behind=true` (show-behind-node).

### Typography — `font`

```
font(Inter, SemiBold, 18)
font(Inter, SemiBold, 18, {lh=24, ls=0.5})
style(Heading/H1)font(Inter, Bold, 32)
```

- Positional `Family, Style, Size`; `Style` is Figma's `fontStyle`; `Size` in px.
- **`{…}` keys:** `lh=` (line height, `24` px or `150%`), `ls=` (letter spacing,
  px). This is the **one** font grammar — the former separate style-creation
  variant is just `font(...)` with `lh`/`ls` supplied.

### Stroke geometry — `stroke`

The stroke's **paint(s)** live in `strokes[]` (paint atoms, above). The stroke's
**geometry** is one atom (consolidating the formerly scattered weight/align/dash
fields):

```
stroke(2)
stroke(2, {align=INSIDE, cap=ROUND, join=MITER, miter=4, dash=[4,4]})
stroke([2,0,2,0])          # per-side weights [top,right,bottom,left]
```

- Positional = uniform weight (a number) **or** a `[t,r,b,l]` tuple for per-side.
- **`{…}` keys:** `align=` (CENTER/INSIDE/OUTSIDE), `cap=`, `join=`, `miter=`,
  `dash=[…]` (arbitrary-length dash pattern).

### Geometry literals & tuples

| Field | Form |
|---|---|
| corner radius | `8` (uniform) · `[8,8,0,0]` (`[TL,TR,BR,BL]`) |
| sizing | `[FILL,HUG]` (`[horizontal,vertical]`; values FIXED/HUG/FILL) |
| constraints | `[MIN,STRETCH]` (`[horizontal,vertical]`; MIN/MAX/CENTER/STRETCH/SCALE) |

Wrapper still applies uniformly: `var(radius/medium)8`.

### Scalars & enums

Bare literals: `opacity` `0.5` · `rotation` `45` · `blendMode` `MULTIPLY` ·
`visible` `true` · `clipsContent` `false`. Wrappable: `var(token/x)0.5`.

## Structs (YAML)

Composite types render as YAML maps; their leaves are atoms. The fields a struct
exposes:

- **node** — `type, name, id, size, position, layoutPositioning, fills[], strokes[], stroke, effects[], radius, opacity, rotation, blend, visible, clipsContent, exportSettings[], layout, sizing, constraints, text, component, componentProperties, variantProperties, overrides, warnings, context, children[]` (children are nested node structs).
- **layout** — `{mode: H|V|NONE|GRID, gap, pad: [t,r,b,l], align: [primary, counter], wrap, rows, cols, rowGap, colGap}`. `mode: NONE` turns auto-layout off. `mode: GRID` enables Figma's CSS-Grid-like layout; the four grid keys (`rows`, `cols`, `rowGap`, `colGap`) are GRID-only — `gap`/`align`/`wrap` are H/V-only. Deferred follow-on: `gridRowSizes`/`gridColumnSizes` (track sizing) and per-child `gridRowSpan`/`gridColumnSpan`/`gridChild*Align` (child placement) — see `docs/deferred-capabilities.md`.
- **text** — `{content, font, color, align, valign, decoration, case, paragraphSpacing, runs}`. `font`/`color` are atoms; `runs` carries per-range overrides (see below). Line height and letter spacing are canonical on the `font(...)` atom (`font(...){lh=24, ls=0.5}`) — there are no separate top-level `lh`/`ls` text keys.
- **exportSettings** — array of persistent export presets, each `{format: PNG|JPG|SVG|PDF, suffix?, constraint?: [SCALE|WIDTH|HEIGHT, value]}`. Round-trips via `get_node`/`update_node` (the persistent-presets path; the `export` tool itself is one-off render/asset output).
- **layoutPositioning** — `AUTO` | `ABSOLUTE` (a child's flow vs absolute participation). Paired with the parent's `layout.mode` it is what distinguishes a true absolute child from a flow child (the §7 absolute-positioning audit reads this — `position` alone can't, since flow children still carry x/y).
- **componentProperties / variantProperties** *(on INSTANCE / variant nodes)* — the instance's current property values and variant selection. The `componentPropertyDefinitions` (the schema) live on the component/set and are read via `get_components`. **Read-only** — see *Read-only node fields* below.
- **warnings** — the read's honesty channel: one entry per piece of the node's state this read **could not represent**, naming the field and the reason (e.g. a `VIDEO` fill the grammar does not render yet). Omitted entirely when nothing was lost, so its presence is the signal. **Read-only** — see below.
- **Read-only node fields (T2 asymmetries).** Four fields of the node struct are emitted on reads and **ignored on writes**, deliberately:
  - **`componentProperties`** — a *projection* of the instance's current property values. Setting them is `set_instance`'s job, which validates each value against the component's `componentPropertyDefinitions`; a blind spec write-back would have no schema to check against.
  - **`variantProperties`** — likewise a projection of which variant is selected. The variant is chosen by `set_instance`, or by `swap_component` for a different main.
  - **`id`** — assigned by Figma when the node is created. A create cannot choose it, and an update addresses the node by it.
  - **`warnings`** — an observation *about* the read, not a property of the node. It exists so a lossy read says so instead of handing back an array that looks complete; a read-modify-write that echoes it back changes nothing.

  A read-modify-write therefore preserves these values in the document without the
  write asserting them, which is why they can be echoed back safely. Anything else
  the node struct documents **does** round-trip; a field that stops doing so is a
  bug, not a new entry here.
- **overrides** — the structured override delta on an instance: **which fields** (and which nested instances) differ from the main component, so the agent can **read and report** surviving overrides (read via `get_node`). It carries field *names*, not their values — Figma's override record is `{id, overriddenFields}` — so it says *that* a field is overridden, never *what to*; read the value from the node struct itself. **Report-only, not a write format:** `set_instance` accepts per-node `overrides` but degrades them with a warning (`tool-surface.md`), so no read of this field can be fed back to re-apply an override.
- **component** *(on INSTANCE)* — the main-component reference for `create_node(INSTANCE)`: `{ key }` for a published/library component **or component set** (`importComponentByKeyAsync`, falling back to `importComponentSetByKeyAsync` — a set resolves to its `defaultVariant`, matching the local-`id` path, because you instance a variant and never the set itself) **or** `{ id }` for a local component node, plus optional `properties` (component-property values, by exact key). **Write side: both paths.** **Read side:** `get_node` reads back `{ id }` for a **local** instance so it round-trips (T2); round-tripping a **published/library** instance (reading its `key` back) is a **documented deferred gap** (`docs/deferred-capabilities.md`) — it needs `getMainComponentAsync` on the read path (perf-sensitive). Instance property *values* read back via `componentProperties`, not here. Resolves the `tool-surface.md` "create_node(INSTANCE) by key/id" capability to a concrete field.
- **context** — a round-tripping markdown **metadata field** (frontmatter scalars + fixed `##` body sections), stored in shared `pluginData` under `CONTEXT_NS = "figmabridge"` / `CONTEXT_KEY = "context"`. It is a **plain string, not an atom** (renders as a YAML block scalar), size-capped at 2 KB (`CONTEXT_MAX_BYTES` = 2048). View/edit split: the fidelity readers (`get_node`/`get_nodes`) return the full `context` and it round-trips via `create_node`/`update_node`; the view/list readers (`inspect`/`search`/`get_components`) emit a read-only `contextSummary` (the capped frontmatter slice). An over-cap value written via the raw `set_plugin_data` escape hatch is a declared read-only, non-round-trippable state (T2). Full field spec: `docs/specs/self-describing-nodes.md`.

## The `{…}` attribute catalogue (completeness)

The single `{…}` channel is how the grammar covers the Figma value space without
inventing a syntax per type. The keys above close the gaps the old grammar
dropped: paint `op`/`blend`/`vis`, image `scale`/`rot`/`filter`, shadow `spread`/
`behind`, per-side stroke + `cap`/`join`/arbitrary `dash`, gradient `tf`,
`video()`/`pattern()` paints. Two struct-level additions:

- **node layout grids** — `grids: ["columns(12,0,24){offset=16, color=#FF000010}", "columns(12,80,20){align=MIN}"]` (the grid head + the same `{…}` channel; full contract below).
- **vector paths** — `vectorPaths: ["path(NONZERO,\"M0 0 L100 0 L100 100 Z\")", "path(EVENODD,\"M...\")"]` (VECTOR nodes only; read back from `node.vectorPaths`).
- **text per-range runs** — `runs: [{ at:[0,4], font: font(Inter,Bold,16), color: #FF0000 }]`; each run is the same atoms scoped by `at:[start,end]`; base `text.*` is the default, runs override.

## columns(count, sectionSize, gutterSize) / rows(...) / grid(sectionSize)

Layout-grid atoms for a FRAME's `grids[]` field — Figma's own property is `layoutGrids`.

| Variant | Form |
|---|---|
| columns | `columns(count, sectionSize, gutterSize)` |
| rows | `rows(count, sectionSize, gutterSize)` — identical shape, ROWS pattern |
| square grid | `grid(sectionSize)` |

- **`columns`/`rows` positional args:** `count` (a number, or the literal `auto`
  — the **only** place `auto` is legal in this grammar); `sectionSize`
  (column/row width in px); `gutterSize` (a number — there is no auto gutter).
- **`{…}` keys (`columns`/`rows`):** `align=` (`MIN`/`MAX`/`CENTER`/`STRETCH`,
  default `STRETCH`), `offset=` (leading margin, px), `color=` (hex, the
  grid's display color), `vis=false` (hidden grid).
- **`align=STRETCH` (the default) ignores `sectionSize`:** under STRETCH,
  Figma derives the section size from the frame and **rejects** an explicit
  `sectionSize` — give `sectionSize` a real value only alongside a
  non-STRETCH `align`.
- **`grid(sectionSize)`** is the square-cell pattern: one positional arg
  (required — Figma rejects a missing `sectionSize`), plus the shared
  `color=`/`vis=` keys. No `align=`/`offset=` — those are columns/rows-only.

Examples:
```
columns(12,0,24){offset=16, color=#FF000010}
columns(12,80,20){align=MIN}
grid(8)
```

Read back on the `grids` field of a FRAME node. Write: supply in `create_node`/`update_node` spec as `grids: [columns(...), ...]`.

## path(windingRule, "data")

SVG-path atom for VECTOR nodes. `windingRule` is one of `NONZERO | EVENODD | NONE`; `data` is the SVG path data string (spaces as coordinate separators — commas are normalized to spaces on write).

Example: `path(NONZERO,"M0 0 L100 0 L100 100 Z")`

Read back on the `vectorPaths` field of a VECTOR node. Write: supply in `create_node`/`update_node` spec as `vectorPaths: [path(...), ...]`.

**Per-point detail rides in the `{…}` channel, sparsely.** Figma holds a vector two ways:
`vectorPaths` — `{windingRule, data}`, which this atom's head mirrors — and `vectorNetwork`, whose
vertices additionally carry `cornerRadius`, `strokeCap`, `strokeJoin` and `handleMirroring`. The
path data alone cannot express any of it, and a vector drawn by hand or imported from SVG commonly
has it: two corners rounded to different radii is the ordinary case, not an exotic one. Read such a
node without this channel and the agent gets a shape with sharp corners the file does not have.

Four keys carry it, each an **index-keyed sparse list** — `index:value`, only for the points that
differ from the default:

| Key | Figma property | Values |
|---|---|---|
| `corners=` | `cornerRadius` | a number, e.g. `corners=[0:12, 2:4]` |
| `caps=` | `strokeCap` | `NONE`/`ROUND`/`SQUARE`/`ARROW_LINES`/`ARROW_EQUILATERAL` |
| `joins=` | `strokeJoin` | `MITER`/`BEVEL`/`ROUND` |
| `mirrors=` | `handleMirroring` | `NONE`/`ANGLE`/`ANGLE_AND_LENGTH` |

The index is **zero-based into the path's points**, in the order the `data` string visits them —
the same basis as `text.runs`' `at:[start,end]`. A path with several subpaths (more than one `M`)
keeps one flat sequence: Figma emits all subpaths in a single `data` string, so point 4 of a
two-subpath shape is simply its fifth point overall. Verified live against a hand-drawn node
(4 points, 1:1 with the vertex order) and a two-subpath vector (6 points, one entry, 6 vertices). Sparse because it scales: a 500-point illustration
with three rounded corners emits three entries, not five hundred (T4, T10). Keeping them **inside
the atom** rather than in a sibling field is what stops the indices drifting away from the points
they describe when a path is rewritten.

Emitted only when a point carries something non-default, so a vector authored through this grammar
has no such keys and an ordinary read is unchanged.

**The absence promise is per-key, not blanket.** A key that is implemented and absent means every
point is default for that property — that is what makes reading it worth anything. A key that is
**not yet implemented** says nothing either way, and must be listed here as such rather than left
to look like a clean read. Shipping a key means the read can be trusted about it; until then the
honest statement is that we do not know.

**One exception, and it is never silent.** The index counts points within one path, while Figma
numbers a node's vertices across the whole node. Those coincide while `vectorPaths` holds a single
entry — the shape an ordinary vector has, subpaths and all. A node with several entries reads
**without the keys and with a warning naming what was dropped**, and a spec written that way is
declined the same way on write, rather than attaching a radius to whichever corner a flat index
happens to reach. The promise above therefore holds wherever the keys can be trusted, and where it
cannot the read says so instead of looking clean.

**Implemented:** `corners`. **Not yet:** `caps`, `joins`, `mirrors` — a node carrying per-point
stroke caps, joins or handle mirroring reads back without them and without warning today.

Example — the shape a designer drew with two of four corners rounded, to different radii:

```yaml
vectorPaths: [path(NONE,"M 0 253 L 430.5 0 L 777 494.5 L 218.5 797 Z"){corners=[0:12, 2:4]}]
```

Unknown `{…}` keys are ignored on read and only emitted when non-default (T4).

## Worked example (inspect view of one node)

```yaml
type: FRAME
name: Card
id: "12:34"
size: [320, 180]
fills: [solid(#FFFFFF), linear(135, #3B82F6@0, #1D4ED8@100){op=0.08}]
stroke: stroke(1, {align=INSIDE})
strokes: [#E5E7EB]
effects: [shadow(0,4,12,#0000001A){spread=0}]
radius: 12
layout: {mode: V, gap: 8, pad: [16,16,16,16], align: [MIN, MIN]}
children:
  - type: TEXT
    name: Title
    text: {content: "Monthly report", font: style(Heading/H3)font(Inter,SemiBold,18){lh=24}, color: #111827}
  - type: TEXT
    name: Caption
    text: {content: "Updated today", font: font(Inter,Regular,13), color: #6B7280}
```

Structs in YAML (scannable); every leaf is one uniform atom; variants are just
different heads; `style()`/`var()` and `{…}` apply identically everywhere.

## Reading large / deep trees

Tree reads are shaped by **depth + budget + a truncation receipt** (the tool-surface
reading model, decision D1):

- **depth** — at the boundary a node becomes a **stub `{id, name, type, size, childCount}`** that keeps its `id`, so the agent drills down by re-inspecting that id (drill-by-id).
- **budget** — an always-on response-size cap, so even a *wide* node (very many children) can't overflow context; it returns a capped chunk + `childCount`.
- **truncation receipt** — `truncated: [{id, childCount}]` names exactly which subtrees were cut, so "continue" = drill into a named id, not a page scan. A wide node's specific children are fetched by **narrowing with `search`/`match`**, never by paginating.

**Cursor pagination is for flat *list* reads only** (`search`, `get_styles`,
`get_variables`, …) — an opaque, self-contained token. Tree reads use
depth/budget/receipt, not a cursor (one rule per output shape — see the
tool-surface design).

## var() / style() rules

- Both wrap **any** atom; the resolved literal always follows.
- **Both wrappers name their source.** A read emits `style(Brand/Primary)` and
  `var(radius/medium)` — the design-system **name**, never the opaque runtime id.
  The name is what the agent reasons with and what it would write back; an id
  identifies the binding to Figma but tells the agent nothing about which token it
  is looking at, and costs a second call to find out.
- **Both wrappers are read-only — the two *wrapper* asymmetries** (principle T2).
  Each is emitted on a read to surface an existing binding; on **write** each
  resolves to its literal, and the binding is applied by the tool that owns it —
  `bind_variable` for `var()`, `apply_style` for `style()`. Writing a wrapper
  therefore sets the appearance, never the binding. *(Principle T2 requires a field
  that cannot round-trip to be documented rather than silent; this is that
  documentation for the wrappers. The read-only **node fields** are listed
  separately under the node struct.)*
- **Root-only enrichment (T10).** Resolving a binding to its name costs a lookup
  per bound field, so a read emits wrappers on the **directly-requested node**
  only; descendants inside a deep `get_node`/`inspect` subtree carry the resolved
  literal without the wrapper. This is the same bounded-scan rule
  `component.key` already follows (tool-surface design → *Expression integration*)
  and for the same reason: an O(nodes × bound fields) resolution on a deep tree is
  exactly the unbounded work T10 forbids.

## Notes

- The schema source of truth for the round-tripping **edit** form is the
  `NodeSpec` in `packages/shared` — this doc governs the **value grammar** used
  inside it and in the inspect view.
- Hex is always uppercase, 6 or 8 chars, no shorthand.
