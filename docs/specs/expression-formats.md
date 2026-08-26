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
  with its resolved value following — one atom on a scalar slot, and on a
  styleable array field the whole list the style supplies (**A styled field is a
  reference, not a list**).
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
- a **resolved list** — `[atom, atom, …]`, the entries a style supplies, legal **only** after a
  `style()` wrapper on one of the four styleable array fields (`fills`, `strokes`, `effects`,
  `grids`): `style(AB/Blur)[bg-blur(24), shadow(0,8,24,#00000066)]`

**The field decides how a bracketed value reads**, which is why the two bracket forms never
compete. The four styleable array fields have no tuple-valued atoms, so a bracketed group after a
`style()` there is the resolved list; every field whose value IS a tuple (`radius`, `sizing`,
`constraints`, a per-side `stroke([t,r,b,l])`) is not styleable, so `radius: style(Foo)[8,8,0,0]`
is a wrapper on a tuple — read as one, and warned on by the scope rule below. No field admits both
readings.

A field that holds many atoms (e.g. `fills`) is a YAML array of atoms — unless a
style owns that field, in which case the field is **one** atom naming the style,
with the list it resolves to following (**A styled field is a reference, not a
list**).

> **Canonical rendering (what the view emits) vs. what the parser accepts.** The view
> renders `{…}` as a **trailing** block (`font(...){lh=24}`), head args **unspaced**
> (`font(Inter,SemiBold,18)`, `shadow(0,4,8,#00000040)`) **except gradients**, whose stops are
> **spaced** (`linear(135, #FF0000@0, #00FF00@100)`), `{…}` keys comma-space separated, and a
> **resolved list** comma-space separated inside its brackets
> (`style(AB/Blur)[bg-blur(24), shadow(0,8,24,#00000066)]`) where a **tuple** stays unspaced
> (`[8,8,0,0]`). The
> parser additionally **accepts and normalizes** the inner-arg form (`font(Inter,SemiBold,18,{lh=24})`),
> arbitrary whitespace, and write-only sugar (`rgb()`/`rgba()`/`solid()`/`image(url)`) — but reads
> always emit the canonical form, so `renderAtom(parseAtom(s))` is stable. (The examples in the
> sections below mix the spaced inner-arg form for readability; the canonical/round-tripping form
> is as stated here.)

**An atom that does not parse is rejected, never guessed at.** A string whose head is
known but whose required pieces are missing or malformed — a one-argument
`path(M 0 0 L 24 24)` (no fill rule), a `stroke(fat)` (the weight is not a number) — is
`INVALID_PARAM`, raised before the write reaches the plugin, and the message teaches the
canonical form, not only the failure. A malformed atom has no literal half to fall back
on, so a degrade would have nothing to write — the same reasoning that makes an
unresolvable bare `style()` reference an error rather than a warning. An **engine
refusal** is the other case, and it degrades: a value that parses but that Figma rejects
(`path(NONZERO,"not path data")`) lands the node, drops the field, and reports one
`warnings[]` entry naming the engine's own error (T7).

## Atom reference

Every variant of every family below is the same `kind(...){…}` shape (or a bare
literal/tuple). The `{…}` keys are listed per family — those are where the long
tail lives, so the core stays short.

### Paints — `fills[]`, `strokes[]`

| Variant | Form |
|---|---|
| solid | `#3B82F6` · `#3B82F680` · `solid(#3B82F6)` · `solid(rgb(0,0,0))` · `rgba(59,130,246,0.5)` |
| linear gradient | `linear(135, #FF0000@0, #00FF00@50, #0000FF@100)` |
| gradient stop, bound | `linear(135, var(brand/violet)#7C3AED@0, var(brand/cyan)#22D3EE@100)` |
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

**A create that names no `fills`/`strokes` inherits Figma's default for that type.** Omitting the
key is not the same as asking for nothing — Figma's own create APIs return a painted node, and the
bridge does not override that. What a spec leaves unsaid, a designer drawing the same shape by hand
would also get:

| Type | Default when the key is absent |
|---|---|
| `FRAME` | `fills: [#FFFFFF]` |
| `RECTANGLE` · `ELLIPSE` · `STAR` | `fills: [#D9D9D9]` |
| `TEXT` | `fills: [#000000]` |
| `VECTOR` · `LINE` | `strokes: [#000000]` |

**Pass an empty array to mean none.** `fills: []` and `strokes: []` clear the default and are
distinct from an absent key — that distinction is the only way to say "deliberately unpainted", so
neither side of it may be collapsed into the other. The defaults round-trip: a read reports what
the node actually carries, and writing that back reproduces it.

**A paint style owns the field, so a styled `fills`/`strokes` is not an array at all.** It is the
scalar reference `fills: style(Glass/Fill)`, and a read emits that reference with the list the
style resolves to: `fills: style(Glass/Fill)[#141B2E99]`. Full contract: **A styled field is a
reference, not a list**.

### Effects — `effects[]`

| Variant | Form |
|---|---|
| drop shadow | `shadow(0,4,8,#00000040)` — `x,y,radius,color` |
| inner shadow | `inner-shadow(0,2,4,#00000020)` |
| layer blur | `blur(10)` — radius |
| background blur | `bg-blur(20)` |

- **`{…}` keys:** `spread=`, `blend=`, `vis=false`, `behind=true` (show-behind-node).

**An effect style owns the whole field.** A styled node reads
`effects: style(AB/Blur)[bg-blur(24)]` — never a style beside literal siblings, which is a shape
the grammar rejects rather than writes (**A styled field is a reference, not a list**).

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
- **`{…}` keys:** `align=` (CENTER/INSIDE/OUTSIDE),
  `cap=` (NONE/ROUND/SQUARE/ARROW_LINES/ARROW_EQUILATERAL), `join=` (MITER/BEVEL/ROUND),
  `miter=`, `dash=[…]` (arbitrary-length dash pattern).

`cap=` and `join=` describe the whole node. A node whose individual points disagree has no single
value for them, so the key is omitted here and `path()`'s per-point list says what each point does.

**One vocabulary, and it is the Plugin API's.** Figma names two cap values differently in its REST
export — `LINE_ARROW` and `TRIANGLE_ARROW` for what the Plugin API calls `ARROW_LINES` and
`ARROW_EQUILATERAL`. Reads normalize to the Plugin API spelling, because that is the only spelling
writes accept: handing back REST's would return a value this same grammar rejects, and an arrow is
the commonest cap there is (T2, T8).

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

- **node** — `type, name, id, size, position, layoutPositioning, fills[], strokes[], stroke, effects[], radius, opacity, rotation, blend, visible, clipsContent, exportSettings[], layout, sizing, constraints, text, component, componentProperties, variantProperties, overrides, warnings, readError, readErrors, context, children[]` (children are nested node structs).
- **layout** — `{mode: H|V|NONE|GRID, gap, pad: [t,r,b,l], align: [primary, counter], wrap, rows, cols, rowGap, colGap}`. `mode: NONE` turns auto-layout off — and is the opt-out from the creation default that gives a frame with no stated `layout` a vertical stack (`tool-surface.md`, *Write model → Create / update*). `mode: GRID` enables Figma's CSS-Grid-like layout; the four grid keys (`rows`, `cols`, `rowGap`, `colGap`) are GRID-only — `gap`/`align`/`wrap` are H/V-only. Deferred follow-on: `gridRowSizes`/`gridColumnSizes` (track sizing) and per-child `gridRowSpan`/`gridColumnSpan`/`gridChild*Align` (child placement) — see `docs/deferred-capabilities.md`. `gap` (with `rowGap`/`colGap`) and each `pad` entry are number atoms: a bound one carries its `var()` wrapper (`gap: var(space/8)8`), matching the uniform `radius` precedent (*Scope*, below). **A layouted node always emits `gap` (and both grid gaps), `0` included** — the runtime omits `itemSpacing` at 0 and the reader compensates, so a zeroed gap can never read as unset. **One pair is refused at every write door:** `align: ["SPACE_BETWEEN", …]` with a **variable-bound** `gap` is self-contradictory (space-between means Figma owns the spacing); the error names the recovery (`bind_variable {clear:true}`, then write), and a literal gap beside SPACE_BETWEEN is fine (`tool-surface.md`, *Ordering constraints*).
- **text** — `{content, font, color, align, valign, decoration, case, paragraphSpacing, runs}`. `font`/`color` are atoms; `runs` carries per-range overrides (see below). Line height and letter spacing are canonical on the `font(...)` atom (`font(...){lh=24, ls=0.5}`) — there are no separate top-level `lh`/`ls` text keys.
- **exportSettings** — array of persistent export presets, each `{format: PNG|JPG|SVG|PDF, suffix?, constraint?: [SCALE|WIDTH|HEIGHT, value]}`. Round-trips via `get_node`/`update_node` (the persistent-presets path; the `export` tool itself is one-off render/asset output).
- **position** — `[x, y]`, parent-relative. **Omitted on an invisible child of an auto-layout parent when the read includes the parent** — Figma does not lay out hidden children, so the stored value is stale (T7: a value the engine is not maintaining is not presented as live). A read entered AT such a node (drill-by-id) cannot see its parent, and returns the stored value. A hidden `ABSOLUTE` child keeps its position, and so does a hidden child of a plain (non-auto-layout) frame: those coordinates are real.
- **layoutPositioning** — `AUTO` | `ABSOLUTE` (a child's flow vs absolute participation). Paired with the parent's `layout.mode` it is what distinguishes a true absolute child from a flow child (the §7 absolute-positioning audit reads this — `position` alone can't, since flow children still carry x/y).
- **componentProperties / variantProperties** *(on INSTANCE / variant nodes)* — the instance's current property values and variant selection. The `componentPropertyDefinitions` (the schema) live on the component/set and are read via `get_components`. **Read-only** — see *Read-only node fields* below.
- **warnings** — the read's honesty channel: one entry per piece of the node's state this read **could not represent**, naming the field and the reason (e.g. a `VIDEO` fill the grammar does not render yet). Omitted entirely when nothing was lost, so its presence is the signal. **Read-only** — see below.
- **readError** — the one entry `warnings` cannot carry: not a piece of state the read could not *represent*, but a node the read could not *reach*. It names the failure (the message the node itself raised) on that node alone, so a read that crosses an unresolvable node returns it labelled instead of returning nothing at all — every sibling and ancestor comes back whole. Omitted when the node read cleanly, so its presence is the signal. **Read-only** — see below.
- **readErrors** — the same failure when it has no node to land on: a list of `"<id the read saw>: <message>"` entries, reported on the root of the returned tree. A stale handle is named by one id while the read walks and by another in what the read returns, so the failure cannot always be pinned to a node in the tree the caller receives — it is still reported, at the root, rather than dropped. Omitted when every failure found its own node. **Read-only** — see below.
- **Read-only node fields (T2 asymmetries).** Six fields of the node struct are emitted on reads and **ignored on writes**, deliberately:
  - **`componentProperties`** — a *projection* of the instance's current property values. Setting them is `set_instance`'s job, which validates each value against the component's `componentPropertyDefinitions`; a blind spec write-back would have no schema to check against.
  - **`variantProperties`** — likewise a projection of which variant is selected. The variant is chosen by `set_instance`, or by `swap_component` for a different main.
  - **`id`** — assigned by Figma when the node is created. A create cannot choose it, and an update addresses the node by it.
  - **`warnings`** — an observation *about* the read, not a property of the node. It exists so a lossy read says so instead of handing back an array that looks complete; a read-modify-write that echoes it back changes nothing.
  - **`readError`** — likewise an observation about the read: which node refused to be read, and why. There is nothing to write back, and a node that carries one is precisely a node whose spec is *not* trustworthy to write back.
  - **`readErrors`** — the same observation about a node the read could not even locate in what it returned. It describes the read's own blind spot, not this node's state, so writing it back would assert nothing.

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

Read back on the `grids` field of a FRAME node. Write: supply in `create_node`/`update_node` spec as `grids: [columns(...), ...]` — or, when a grid style owns the field, as the scalar reference `grids: style(Layout/12col)` (**A styled field is a reference, not a list**).

## path(windingRule, "data")

SVG-path atom for VECTOR nodes. `windingRule` is one of `NONZERO | EVENODD | NONE`; `data` is the SVG path data string (spaces as coordinate separators — commas are normalized to spaces on write).

Example: `path(NONZERO,"M0 0 L100 0 L100 100 Z")`

Read back on the `vectorPaths` field of a VECTOR node. Write: supply in `create_node`/`update_node` spec as `vectorPaths: [path(...), ...]`.

**Per-point detail rides in the `{…}` channel, sparsely.** Figma holds a vector two ways:
`vectorPaths` — `{windingRule, data}`, which this atom's head mirrors — and `vectorNetwork`, whose
vertices additionally carry `cornerRadius`, `strokeCap` and `strokeJoin`. The path data alone
cannot express any of it, and a vector drawn by hand or imported from SVG commonly has it: two
corners rounded to different radii, or an arrowhead on one end of a line and nothing on the other.
Read such a node without this channel and the agent gets a shape the file does not have — sharp
where it is round, blunt where it points.

Three keys carry it, each an **index-keyed sparse list** — `index:value`, only for the points that
differ from the node-level default:

| Key | Figma property | Values |
|---|---|---|
| `corners=` | `cornerRadius` | a number, e.g. `corners=[0:12,2:4]` |
| `caps=` | `strokeCap` | `NONE`/`ROUND`/`SQUARE`/`ARROW_LINES`/`ARROW_EQUILATERAL` |
| `joins=` | `strokeJoin` | `MITER`/`BEVEL`/`ROUND` |

Each has a node-level twin in `stroke()`, which is where a value shared by every point belongs;
these keys are for the points that disagree with it. `caps=` is the one that earns its keep — an
arrowhead is a stroke cap, so a line pointing one way needs two different caps and the node-level
field cannot hold both.

**`handleMirroring` is deliberately absent.** It decides how Figma's pen tool moves the opposite
handle while a human drags one — it changes nothing rendered, since the curve is fully determined
by handle positions the `data` string already carries losslessly. It is editor state, not design
state, and a key that cannot change what anyone sees is not worth a place in the grammar.

The index is **zero-based into the path's points**, in the order the `data` string visits them —
the same basis as `text.runs`' `at:[start,end]`. A path with several subpaths (more than one `M`)
keeps one flat sequence: Figma emits all subpaths in a single `data` string, so point 4 of a
two-subpath shape is simply its fifth point overall. Verified live against a hand-drawn node
(4 points, 1:1 with the vertex order) and a two-subpath vector (6 points, one entry, 6 vertices).
Sparse because it scales: a 500-point illustration with three rounded corners emits three entries,
not five hundred (T4, T10). Keeping them **inside the atom** rather than in a sibling field is what
stops the indices drifting away from the points they describe when a path is rewritten.

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

**All three keys are implemented**, so an absent key carries its full meaning: every point is
default for that property. Nothing in this channel is a silent unknown.

**When the points disagree, the node-level twin goes quiet.** Figma reports a node's own
`strokeCap` or `strokeJoin` as *mixed* once its points differ, which is not a value and must not be
rendered as one. `stroke()` therefore omits that key and the per-point list carries the whole
truth — the reverse of the ordinary case, where the node-level value carries it and the per-point
list is absent. Between them exactly one is authoritative, never both and never neither.

Example — the shape a designer drew with two of four corners rounded, to different radii:

```yaml
vectorPaths: [path(NONE,"M 0 253 L 430.5 0 L 777 494.5 L 218.5 797 Z"){corners=[0:12,2:4]}]
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
effects: style(Elevation/Card)[shadow(0,4,12,#0000001A)]
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
different heads; `var()` and `{…}` apply identically everywhere. `fills` and
`effects` here are the two shapes a styleable field takes: a literal array, and
the style that owns the field with the list it resolves to.

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

- Both wrap **any** atom; the resolved literal always follows. A wrapper on an
  atom with no value — `fills: [var(surface/2)]` — is an error on both faces: the
  wrapper names the binding, the literal *is* the value, and a write carrying only
  a name would leave the appearance undefined until something else resolved it.
  The one form that is not this is a bare `style(Name)` standing as the **whole
  content of one of the four styleable array fields** (`fills`, `strokes`,
  `effects`, `grids`) — alone, or as that field's only array entry: that is not a
  wrapper missing its atom but a reference to the style that owns the field, and
  the style is what supplies the value (**A styled field is a reference, not a
  list**). **The scalar slots have no reference form:** on `text.font` and
  `text.color` a `style()` wraps its resolved atom as it always has, and a bare
  one is the valueless-wrapper error above.
- **Both wrappers name their source.** A read emits `style(Brand/Primary)` and
  `var(radius/medium)` — the design-system **name**, never the opaque runtime id.
  The name is what the agent reasons with and what it would write back; an id
  identifies the binding to Figma but tells the agent nothing about which token it
  is looking at, and costs a second call to find out.
- **An entry-level wrapper with a value BINDS on write — the wrappers round-trip**
  (principle T2). Entry-level is `var()` on every field it binds, and `style()` on
  the scalar slots `text.font` / `text.color`. A read emits `var(surface/2)#141B2E`;
  writing that same atom back applies the literal **and then** re-establishes the
  binding — `var(name)` resolves a variable **by name** and binds the field,
  `style(Name)` resolves a local style by name and category and applies it. Literal
  first, binding second, and the order decides who wins: the literal guarantees the
  field is never left undefined and is what **remains** if the binding cannot be
  made, while a binding that lands **governs** the value from then on — a token
  whose value has moved on since the agent last read it overrides the stale
  literal, which is exactly what being bound means.

  **A `style()` reference on one of the four styleable array fields has no literal
  half.** The style is the whole write; a resolved list riding with it is not
  applied as literals, and there is no literal left over to survive a binding that
  cannot be made (**A styled field is a reference, not a list**).

  This is what makes the pair **symmetric**: the read face and the write face
  speak the same string, so a read-modify-write preserves the binding it was shown
  instead of flattening it to a literal. `bind_variable` / `apply_style` remain the
  explicit route — for binding a field a write is not otherwise touching, and for
  the things only they do (`bind_variable`'s collection-mode pin).

  It also makes the design-system path the **cheap** one, which is what T9 needs
  from the grammar. A binding that costs a second call per node per field loses
  to a literal that is inline and looks identical on the canvas — so the agent
  writes the right *value* and skips the *token*, and the document ends up
  unbound at exactly the scale where tokens matter most. Inline, the two cost the
  same, and the atom the read handed over is already the bound one.

  **Binding is by NAME; an id is never accepted inline.** The name is what the read
  emitted and what the agent reasons with (above); an id inside a wrapper is not a
  shorter spelling of the same thing but a second vocabulary, and the grammar keeps
  one. A name resolves to the **first match among the file's local collections** (or
  local styles of that category), so two collections publishing the same name are
  indistinguishable inline and a colliding name may bind a variable other than the
  one the read reported — the standing cost of a name-only grammar, and the reason a
  design system wants distinct token names.

  **An unresolvable name degrades, never aborts** (T7). A `var(name)` with no
  matching variable, or a `style(Name)` with no matching style of that category,
  applies the literal and reports one `warnings[]` entry naming the wrapper
  (`var(surface/2): no variable with that name — literal applied unbound`). The
  node is still created or updated with the appearance that was asked for; a
  missing token costs a binding, never the write.

  **That is the rule for a wrapper that sits on a literal.** A styleable field
  written as a bare reference has no literal to keep, so there the same failure is
  an error instead of a warning (**A styled field is a reference, not a list**).

  **Scope — a wrapper binds on the fields listed here:** `fills[]`, `strokes[]`,
  a **uniform** `stroke(…)` weight, a **uniform** `radius`, and the layout spacing
  scalars — `layout.gap` (with its GRID spellings `rowGap`/`colGap`) and each of
  the four `layout.pad` sides — for `var()`;
  `fills`, `strokes`, `effects`, `grids` and `text.font` for `style()`;
  `text.color` for both (it is the text node's first fill). A `var()` binds per
  paint, so `fills[]`/`strokes[]` bind by index; a `var()` on `pad` binds per
  side, by position — `pad: [var(space/8)8, 16, var(space/8)8, 16]` binds top and
  bottom and leaves the sides literal — because Figma binds every padding side
  independently, exactly as paints bind by index; a `style()` owns the whole field,
  so on the four array fields it replaces the array rather than sitting inside one
  (**A styled field is a reference, not a list**).

  **A gradient binds per STOP.** A gradient's colours are per stop and so are its
  tokens — a two-colour banner is two design-system decisions — so the stop is the
  one head argument that carries a wrapper of its own:
  `linear(135, var(brand/violet)#7C3AED@0, var(brand/cyan)#22D3EE@100)`. The
  atom-level wrapper cannot say this; one wrapper on `linear(...)` would claim a
  single variable owns both ends. Only `var()` applies — a style names a whole
  paint slot and there is nothing for it to own one stop of — and an unbound stop
  stays bare beside a bound neighbour. Figma carries the binding on the ColorStop
  (`gradientStops[i].boundVariables.color`); where a runtime does not, the literal
  colour lands and one `warnings[]` entry names the stop it could not bind (T7).

  Everywhere else a wrapper still resolves to its literal and reports one
  `warnings[]` entry, so a write is never silent about the half it could not do.
  Three of those are exceptions a read can itself produce, and all three are named
  deliberately — each one a value the grammar splits finer than the binding surface
  does: a per-range **`text.runs[].color`**, which the binding surface reaches only
  at node level; a **per-corner `radius`** (`var(radius/md)[8,8,0,0]`), because
  Figma binds all four corners with one field — binding it would square the corners
  the tuple says are different, so the geometry is kept and the binding is dropped;
  and a **per-side stroke weight** (`var(border/thin)stroke([0,0,1,0])`), for the
  same reason on the other axis — one binding cannot express four sides, so the
  four weights are written and the binding is dropped.
- **Wrappers reach descendants; resolution is per token, not per field.** A read
  emits `style(...)`/`var(...)` on every node it returns complete — the requested
  node and, within `depth`, its descendants. Anything else would contradict the
  edit reader's own promise of *"the node's complete faithful spec at the
  requested depth"* (tool-surface → *Read model*): a descendant whose
  `style(Brand/Primary)` had been flattened to `#0A84FF` looks writable and is
  not, which is precisely the failure T2 exists to prevent.

  **The bound is per distinct token, not per bound field.** On a 12-card
  design-system subtree — 97 nodes, **280 bound fields** — the bindings resolve
  from **8 distinct ids**, because a design system is a few tokens reused
  everywhere (T9 makes that the house style, so the denser the document the
  better the ratio). Resolving each distinct id once costs **1 ms**; even
  resolving per field costs **26 ms**.

  The cost therefore scales with **how many tokens the document defines**, not
  with how large the subtree is — a bound that tightens as a tree grows. Resolve
  each distinct id once per read and apply it by id.

  **`component.key` follows, on its own measurement.** An instance's main cannot
  be looked up by id — each instance must be asked — so batching does not apply
  and the only question is whether the per-instance call is affordable. It is:
  48 instances resolve in **2-5 ms** (~0.06 ms each), the same order as the
  bindings above. One rule covers both.

## A styled field is a reference, not a list

**Figma holds one style link per field slot, and a node has five slots:** fill,
stroke, effect, text and grid (the five `apply_style` names). Each slot has one
owner, exclusively. A style owns the whole field, or the field is literal; there
is no state in which a style and an extra literal sit side by side, and no way to
ask Figma for one. Assigning the field directly on a styled node **detaches** the
style — Figma's own behaviour, not this bridge's. The slots are independent of
each other, so a node carrying a paint style on `fills` and an effect style on
`effects` at the same time is ordinary, and both round-trip. Two field names can
reach one slot, though: a TEXT node's `text.color` **is** its first fill, so
`fills` and `text.color` are two spellings of that node's fill slot, not two
slots.

An array-valued styleable field — `fills`, `strokes`, `effects`, `grids` — has
exactly two write forms:

- **a reference** — the field is the scalar atom `style(Name)`, and the style
  supplies every entry: `effects: style(AB/Blur)`
- **a list of literals** — the field is an array, each entry its own atom,
  `var()` wrappers included: `effects: [bg-blur(24), shadow(0,8,24,#00000066)]`

A reference may carry the resolved list a read appends to it —
`effects: style(AB/Blur)[bg-blur(24)]` — and that write means exactly what the
bare reference means: the style is the field's content, so the list rides along
and is **never applied as literals**. That is what makes a read writable verbatim.

**A ride-along list that differs from the style is named, not obeyed and not
dropped in silence** (T7). The style governs, so the write lands the style's own
content either way; when the list written is not what the style supplies, the
write reports one `warnings[]` entry naming the style, what it actually supplies,
and what did not land:

```
style(AB/Blur) owns effects — it supplies [bg-blur(24)], so the 1 extra effect written beside it was not applied; add it to the style, or write every effect as a literal.
```

A verbatim write-back never fires it: the list a read just emitted is the style's
content, so the two are equal and the round-trip stays silent. It fires on a list
an agent composed itself — the "team blur **plus** my shadow" the rejections
catch in array spelling — and on a list that has gone stale because the style
moved on since the read, which is worth hearing too. The comparison is of
canonical atom strings, order included, against the style that rules 3 and 4
already resolved. A list that differs without carrying extras — reordered, or
shorter than what the style supplies — earns the same single warning, phrased for
what it is: the style's content is named and the written list is called out as
not what landed. It is a **warning, never a rejection**: a style edited between
the read and the write must not turn a correct write-back into an error. The
warning reads the ride-along in every spelling the write face accepts — the
bracketed list, the legacy lone atom beside the style, the array-wrapped read
form, and the same-name multi-entry array — exactly as rules 3 and 4 read the
reference, so no spelling is the quiet one.

**Write sugar:** a one-entry array whose only entry is a style —
`effects: [style(AB/Blur)bg-blur(24)]`, the bare `effects: [style(AB/Blur)]`, or
the read form array-wrapped out of habit,
`effects: [style(AB/Blur)[bg-blur(24)]]` — is accepted as the reference form, the
way `image(url)` is accepted for `image(HASH)`, so a spec written against the
older grammar stays writable. The sugar reaches the multi-entry legacy read form
too: an array whose entries are **all** wrapped by the **same** style name — the
shape the older reader emitted for a multi-value style — normalises to the
reference exactly as the lone atom does, its entries riding as the resolved list
through the differ warning like any other spelling. Like `image(url)` it is
write-only: a read emits the reference.

**Four inputs are rejected** — `INVALID_PARAM`, raised before the write reaches
the document:

1. a `style()` entry beside literal siblings in one field;
2. two or more **different** `style()` names in one field (same-name entries are
   the multi-entry sugar above) — including the cross-field spelling of that
   mistake, a different style named on `fills` and on `text.color` of one TEXT
   node, which are one slot;
3. a reference whose name resolves to a style of the **wrong type** for the slot
   — a paint style named on `effects`, an effect style named on `fills`;
4. a reference whose name resolves to **nothing**.

Rules 3 and 4 read the reference in every spelling — the scalar and the array
sugars are the same input, so no spelling is the loophole.

Rules 1 and 2 are the mix the slot cannot hold: the write states more than one
owner for a field that has room for one, so landing it would mean choosing which
half of the request to drop — and dropping half a request is the failure this
form exists to make unrepresentable. Rules 3 and 4 are where a reference parts
company with the degrade rule above: a wrapper that sits on a literal still has
that literal when its name resolves to nothing, so it warns and the appearance
survives; a reference has no literal, because the name **is** the field's whole
content, so degrading would write nothing at all and call it success.

Every rejection says how to write what was meant, not only what was wrong. Rules
1 and 2 carry this message, naming the field the write used:

```
a style owns the whole effects list — use a style containing every effect you want, or write them all as literals (a style cannot be combined with literal siblings)
```

so the same message reads `fills`, `strokes` or `grids` on those fields. Rules 3
and 4 name the style that failed to resolve and what the slot needed instead, in
the same teach-the-fix shape.

**A read emits the reference with its resolved list.** The atom for a styled
array slot is the wrapper, then a **bracketed comma-separated list** of the atoms
the style resolves to — each one the ordinary canonical atom of that field's
family, `{…}` and all:

```
fills: style(Glass/Fill)[#141B2E99]
effects: style(AB/Blur)[bg-blur(24), shadow(0,8,24,#00000066)]
```

The brackets are **always** there — a style holding one effect emits a one-entry
list — so the form is parsed unconditionally rather than sniffed. No entry inside
the list carries a wrapper of its own: the style is named once, outside, and it
is the source of all of them.

**Every emission is writable verbatim, and writing it back changes nothing**
(T2). The name resolves to the same style, the style still owns the field, and
re-applying it re-establishes the same link; the resolved list is what the read
showed for it, not a second instruction competing with it. A read-modify-write of
a styled node is a no-op on both the appearance and the binding.

**What this does not change.**

- **`text.font`** is the text slot, and a text style resolves to a single font
  atom, so it keeps the scalar shape it has always had —
  `style(Heading/H1)font(Inter,Bold,32)`, no brackets, because there is no list
  to bracket. There is no reference form on a scalar slot: the resolved atom is
  required there exactly as it is today. The array slots' list-after-wrapper form
  is that precedent widened to fields that hold many atoms, not a second grammar.
  `text.color` is the same scalar shape (it is the text node's first fill).
- **`var()`** is untouched, on every field it already reaches. A variable binds
  one paint, so a `var()` wraps an **entry** and several entries may each carry
  their own: `fills: [var(surface/2)#141B2E, #FFFFFF20]`. That is the difference
  between the two wrappers in one line — a `style()` names the owner of a field,
  a `var()` names the source of an entry — and it is why only one of them turns a
  field into a scalar.
- **The atom is the same string on both faces** (T8): `style(AB/Blur)[bg-blur(24)]`
  is byte-identical in the YAML view and in the JSON edit form. Only the quoting
  around it belongs to the face.

## Notes

- The schema source of truth for the round-tripping **edit** form is the
  `NodeSpec` in `packages/shared` — this doc governs the **value grammar** used
  inside it and in the inspect view.
- Hex is always uppercase, 6 or 8 chars, no shorthand.
