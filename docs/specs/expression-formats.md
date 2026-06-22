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

> Governed by [[figma-bridge/docs/principles|the principles]] (T8 — one expression grammar, one source of truth).

Canonical reference for all value expressions used across the bridge. These formats are used in `ParsedNode` fields (read side) and `create_tree` / `update_node` specs (write side).

**Universal prefix rule:** `style(name)` wraps any raw value to indicate it comes from a named Figma style. `var(name)` (M4) wraps any raw value to indicate a variable binding. The resolved raw value always follows so the agent sees both the semantic source and the actual appearance.

**`var()` scope (this phase):** `var(name)` is **read-only** in the current phase. It is **emitted on reads** to surface an existing variable binding, but on **write** it resolves to a **literal** — the binding is not applied. Binding a field to a variable is done via the dedicated `bind_variable` tool, which supports **scalar fields only** (tool-surface fork F-C). This is a **deliberate, documented asymmetry** (principle T2): the `var()` round-trip is intentionally lossy on the write side for now, not silently dropped.

---

## Color

Used in: `fills[]`, `strokes[]`, `text.color`

```
#RRGGBB                                                — solid, full opacity
#RRGGBBAA                                              — solid, with alpha
style(Colors/Primary/500)#3B82F6                       — paint style, resolved
style(Colors/Primary/500)#3B82F680                     — paint style, resolved with alpha
var(surface/primary)#3B82F6                             — variable binding (M4)
linear-gradient(135deg, #FF0000 0%, #00FF00 50%, #0000FF 100%)  — linear gradient
radial-gradient(#FFFFFF 0%, #00000000 100%)             — radial gradient
angular-gradient(#FF0000 0%, #00FF00 33%, #0000FF 66%) — angular gradient
diamond-gradient(#FF0000 0%, #0000FF 100%)              — diamond gradient
image                                                   — image fill
```

Notes:
- Gradient stops listed in Figma's stop order, positions as `%`
- Linear gradient includes `deg` angle (computed from Figma's `gradientTransform` matrix)
- Multiple fills on one node: array `["#3B82F6", "linear-gradient(90deg, #000000 0%, #FFFFFF 100%)"]`
- Hex is always uppercase, 6 or 8 chars (no shorthand)

### Where used in M2

- `get_local_styles`: style value column (e.g., `- Colors/Primary/500 [S:abc] paint #3B82F6`)
- `ParsedNode.fills`, `ParsedNode.strokes`, `ParsedNode.text.color` in `get_node` output

---

## Font

Used in: `text.font`

```
Inter/Regular/16                                        — family/style/size
Inter/SemiBold/18                                       — weight as style name
style(Heading/H1)Inter/Bold/32                          — text style, resolved
var(font/heading)Inter/Bold/32                          — variable binding (M4)
```

Notes:
- Always three parts: `Family/Style/Size`, slash-separated
- Style is Figma's `fontStyle` (Regular, Bold, SemiBold, Italic, Bold Italic, etc.)
- Size is always in px (Figma's unit)

### Style-creation font value (text-style grammar)

`create_styles` / `update_styles` text-style values use a **distinct, richer** font grammar (parsed by `parseStyleFontValue`):

```
Family/Style/Size                                      — minimal (3-part)
Family/Style/Size/LineHeight                           — with line height
Family/Style/Size/LineHeight?ls=<letterSpacing>        — with optional letter-spacing suffix
Inter/SemiBold/18/24px?ls=0.5px                        — example
```

- The trailing `LineHeight` segment is **optional** (`Family/Style/Size[/LineHeight]`).
- The `?ls=<letterSpacing>` suffix is **optional** and supplies letter spacing.
- This is **DISTINCT** from the 3-part node text font (`Family/Style/Size`, parsed by `parseFontExpression`) used in `text.font`. (tool-surface Resolved decision #5.)

### Where used in M2

- `get_local_styles`: style value column (e.g., `- Heading/H1 [S:def] text Inter/Bold/32`)
- `ParsedNode.text.font` in `get_node` output

---

## Effect

Used in: `effects[]`

```
shadow(0,4,8,#00000040)                                 — drop shadow: x,y,radius,color
inner-shadow(0,2,4,#00000020)                           — inner shadow: x,y,radius,color
blur(10)                                                — layer blur: radius
bg-blur(20)                                             — background blur: radius
style(Elevation/Medium)shadow(0,4,8,#00000040)          — effect style, resolved
```

Notes:
- `shadow` = Figma `DROP_SHADOW`
- `inner-shadow` = Figma `INNER_SHADOW`
- `blur` = Figma `LAYER_BLUR`
- `bg-blur` = Figma `BACKGROUND_BLUR`
- Multiple effects on one node: array `["shadow(0,4,8,#000000)", "blur(2)"]`
- Multiple effects in `get_local_styles` (per style): joined with `+` → `shadow(0,4,8,#000000)+blur(2)`
- Spread omitted from shorthand (rarely used). Full data available via raw Figma JSON in `get_node`

### Where used in M2

- `get_local_styles`: style value column (e.g., `- Elevation/Medium [S:ghi] effect shadow(0,4,12,#0000001A)`)
- `ParsedNode.effects` in `get_node` output

---

## Grid Style

Used in: `get_local_styles` only

```
columns(12,32,auto)                                     — column grid: count, width, gutter
rows(6,40,16)                                           — row grid: count, height, gutter
grid(16)                                                — uniform grid: size
style(Layout/12col)columns(12,32,auto)                  — grid style, resolved
```

### Where used in M2

- `get_local_styles`: style value column

---

## Corner Radius

Used in: `radius`

```
8                                                       — uniform all corners
[8,8,0,0]                                              — per-corner: [TL, TR, BR, BL]
```

No style binding. A variable binding is **read** as `var(radius/medium)8` when present, but `var()` is not a current write capability (see the `var()` scope note above — write resolves to the literal; use `bind_variable` for scalar fields).

---

## Layout

Used in: `layout`

```yaml
layout:
  mode: H                    # H (HORIZONTAL) | V (VERTICAL)
  spacing: 16                # itemSpacing in px
  padding: [24,24,24,24]     # [top, right, bottom, left] in px
  align: [MIN,CENTER]        # [primaryAxisAlignItems, counterAxisAlignItems]
  wrap: true                 # only present if WRAP enabled
```

Align values:
- Primary axis: `MIN` | `MAX` | `CENTER` | `SPACE_BETWEEN`
- Counter axis: `MIN` | `MAX` | `CENTER` | `BASELINE`

---

## CSS Grid Layout

Used in: `grid` (when `layoutMode` is `GRID`)

```yaml
grid:
  rows: 3
  columns: 12
  rowGap: 8                  # optional, px
  columnGap: 16              # optional, px
```

---

## Sizing

Used in: `sizing`

```
[FILL, HUG]                                            — [horizontal, vertical]
[FIXED, FIXED]                                         — explicit dimensions
```

Values: `FIXED` | `HUG` | `FILL`

Only present when node is inside an auto-layout parent.

---

## Constraints

Used in: `constraints`

```
[MIN, STRETCH]                                          — [horizontal, vertical]
```

Values: `MIN` | `MAX` | `CENTER` | `STRETCH` | `SCALE`

Only present when node is NOT in an auto-layout parent (auto-layout overrides constraints).

---

## Stroke Properties

Used in: `strokeWeight`, `strokeAlign`, `strokeDash`

```
strokeWeight: 2                                         — px
strokeAlign: INSIDE                                     — INSIDE | OUTSIDE | CENTER
strokeDash: [4, 4]                                      — [dash, gap] — omitted if solid
```

---

## Text Properties

Used in: `text` object fields

```yaml
text:
  content: "Card Title"                                 # the text string
  font: Inter/SemiBold/18                               # or style(Heading/H1)Inter/SemiBold/18
  align: LEFT                                           # LEFT | CENTER | RIGHT | JUSTIFIED
  valign: TOP                                           # TOP | CENTER | BOTTOM
  color: "#1A1A1A"                                      # or style(Colors/Text/Primary)#1A1A1A
  lineHeight: 24px                                      # "24px" | "150%" | "auto"
  letterSpacing: 0.5px                                  # "0.5px" | "2%"
  decoration: UNDERLINE                                 # UNDERLINE | STRIKETHROUGH — omitted if none
  case: UPPER                                           # UPPER | LOWER | TITLE | SMALL_CAPS — omitted if ORIGINAL
  paragraphSpacing: 16                                  # px — omitted if 0
```

### lineHeight format

```
24px                                                    — fixed px
150%                                                    — percentage of font size
auto                                                    — Figma AUTO
```

### letterSpacing format

```
0.5px                                                   — fixed px
2%                                                      — percentage of font size
```

---

## Scalar Properties

Used in: top-level `ParsedNode` fields

```
opacity: 0.5                — 0 to 1, omitted if 1
rotation: 45                — degrees, omitted if 0
blendMode: MULTIPLY         — omitted if PASS_THROUGH
visible: false              — omitted if true
clipsContent: true          — omitted if false
```

### blendMode values

`PASS_THROUGH` | `NORMAL` | `DARKEN` | `MULTIPLY` | `COLOR_BURN` | `LIGHTEN` | `SCREEN` | `COLOR_DODGE` | `OVERLAY` | `SOFT_LIGHT` | `HARD_LIGHT` | `DIFFERENCE` | `EXCLUSION` | `HUE` | `SATURATION` | `COLOR` | `LUMINOSITY`

---

## Milestone Scope

| Expression | M2 (Read) | M3 (Create) | M4 (Design System) | M5 (Modify) |
|-----------|-----------|-------------|--------------------|-----------  |
| Color (`#hex`, gradient) | `get_local_styles`, `ParsedNode` | `create_tree` fills/strokes | `var(name)#hex` | `update_node` |
| Font (`Family/Style/Size`) | `get_local_styles`, `ParsedNode` | `create_tree` text | `var()` binding | `update_node` |
| Effect (`shadow`, `blur`) | `get_local_styles`, `ParsedNode` | `create_tree` effects | — | `update_node` |
| `style()` prefix | `ParsedNode` reads | `create_tree` applies | — | `update_node` |
| `var()` prefix | **read-only** (emitted on reads; write resolves to literal — bind via `bind_variable`, scalar fields only) | — | — | — |
| Stroke props | `ParsedNode` | `create_tree` | — | `update_node` |
| Text props | `ParsedNode` | `create_tree` | — | `update_node` |
| Layout/sizing/constraints | `ParsedNode` | `create_tree` | — | `update_node` |
| Scalars (opacity, rotation, etc.) | `ParsedNode` | `create_tree` | — | `update_node` |
| Grid style | `get_local_styles` | — | — | — |

---

## ParsedNode Type (complete)

> **Illustrative.** The authoritative `ParsedNode` schema lives in `packages/shared`; this block mirrors it for reference and may lag — defer to the shared package.

```typescript
type ParsedNode = {
  id: string
  name: string
  type: string
  size: [number, number]
  position?: [number, number]

  // Layout
  layout?: {
    mode: 'H' | 'V'
    spacing: number
    padding: [number, number, number, number]
    align: [string, string]
    wrap?: boolean
  }
  grid?: {
    rows: number
    columns: number
    rowGap?: number
    columnGap?: number
  }
  sizing?: [string, string]
  constraints?: [string, string]

  // Visual
  fills?: string[]
  strokes?: string[]
  strokeWeight?: number
  strokeAlign?: string
  strokeDash?: [number, number]
  radius?: number | [number, number, number, number]
  opacity?: number
  effects?: string[]
  blendMode?: string
  rotation?: number
  visible?: boolean
  clipsContent?: boolean

  // Text
  text?: {
    content: string
    font: string
    align?: string
    valign?: string
    color?: string
    lineHeight?: string
    letterSpacing?: string
    decoration?: string
    case?: string
    paragraphSpacing?: number
  }

  // Component (INSTANCE)
  component?: {
    name: string
    id: string
    key: string                                  // main-component key (tool-surface Resolved decision #3)
    variant?: Record<string, string>
    overrides?: string[]
  }

  children?: ParsedNode[]
}
```
