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

A field holding many atoms (e.g. `fills`) is an array of atoms.

**Canonical form (what reads emit):** `{…}` trailing, head args unspaced
(`font(Inter,SemiBold,18)`), gradient stops spaced (`linear(135, #FF0000@0, #00FF00@100)`).
The parser also accepts inner-arg form and arbitrary whitespace.

---

## Paints — `fills[]`, `strokes[]`

| Variant | Form |
|---|---|
| solid | `#3B82F6` · `#3B82F680` · `solid(#3B82F6)` · `rgba(59,130,246,0.5)` |
| linear gradient | `linear(135, #FF0000@0, #00FF00@50, #0000FF@100)` |
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
- Gradient stops: `#color@percent`. Angle is **linear-only** (first arg). Radial,
  angular, diamond carry no angle; non-trivial geometry goes in `{tf=[a,b,c,d,e,f]}`.
- `image(url)` is write-only sugar — reads always emit `image(HASH)`.
- `{…}` keys for any paint: `op=` (paint opacity), `blend=` (blend mode),
  `vis=false` (hidden). Image/video extras: `scale=` (FILL/FIT/CROP/TILE), `rot=`,
  `tile=`, `filter=`.

---

## Effects — `effects[]`

| Variant | Form |
|---|---|
| drop shadow | `shadow(x,y,radius,color)` — e.g. `shadow(0,4,8,#00000040)` |
| inner shadow | `inner-shadow(0,2,4,#00000020)` |
| layer blur | `blur(radius)` — e.g. `blur(10)` |
| background blur | `bg-blur(20)` |

`{…}` keys: `spread=`, `blend=`, `vis=false`, `behind=true` (show behind node).

---

## Typography — `font`

```
font(Inter, SemiBold, 18)
font(Inter, SemiBold, 18, {lh=24, ls=0.5})
style(Heading/H1)font(Inter, Bold, 32)
```

- Positional: `Family, Style, Size` (px).
- `Style` is Figma's `fontStyle` field (e.g. `Regular`, `Medium`, `SemiBold`, `Bold`,
  `Italic`, `Bold Italic`).
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

## Geometry — corner radius, sizing, constraints

| Field | Form |
|---|---|
| corner radius | `8` (uniform) · `[8,8,0,0]` (TL,TR,BR,BL) |
| sizing | `[FILL,HUG]` — `[horizontal, vertical]`; values: FIXED / HUG / FILL |
| constraints | `[MIN,STRETCH]` — `[horizontal, vertical]`; values: MIN / MAX / CENTER / STRETCH / SCALE |

The `var()` wrapper applies uniformly: `var(radius/medium)8`.

---

## Scalars & enums

Bare literals: `opacity` `0.5` · `rotation` `45` · `blendMode` `MULTIPLY` ·
`visible` `true` · `clipsContent` `false`. All wrappable: `var(token/x)0.5`.

---

## `var()` and `style()` rules

- Both wrap **any** atom; the resolved literal **always follows** the wrapper.
- **Both name their source** — `style(Brand/Primary)`, `var(radius/medium)`, never
  an opaque id. The name is what you reason with and what you would write back.
- **Both are read-only** — emitted on reads to surface an existing binding. On
  **write**, either resolves to its literal, so writing one sets the appearance
  and not the binding. Apply bindings with the tool that owns them:
  `bind_variable` for `var()`, `apply_style` for `style()`.
- **Only the node you asked for carries a wrapper.** Descendants inside a deep
  `get_node`/`inspect` show the resolved literal without it, so a binding you care
  about is best read by requesting that node directly.

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
effects:
  - shadow(0,4,12,#0000001A){spread=0}
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

Key struct fields:
- **`layout`** — `{mode: H|V|NONE, gap, pad: [t,r,b,l], align: [primary, counter], wrap}`.
- **`text`** — `{content, font, color, align, valign, decoration, case, runs}`.
  Line height + letter spacing are on the `font(...)` atom (`{lh=, ls=}`), not
  separate top-level keys.
- **`sizing`** — `[horizontal, vertical]` atom (FIXED/HUG/FILL).
- **`layoutPositioning`** — `AUTO` | `ABSOLUTE` (child's flow participation).
- **`componentProperties`** *(INSTANCE)* — current property values.
- **`overrides`** *(INSTANCE)* — structured delta from main component.
- **`component`** *(INSTANCE)* — `{id}` for local, `{key}` for library/published.

---

## Tree reading model

Tree reads use **depth + budget + truncation receipt**:
- At the depth boundary a node becomes a stub `{id, name, type, size, childCount}`.
- A budget cap prevents wide nodes from overflowing context.
- `truncated: [{id, childCount}]` tells you exactly which subtrees were cut — drill
  into those ids, don't re-scan.

Flat list reads (`get_styles`, `get_variables`, search results) use an **opaque cursor**
for pagination, not depth/budget.
