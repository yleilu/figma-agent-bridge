---
name: figma-design/mechanics
description: Tool-usage patterns and limits for the figma-design skill. Load when building, editing, or when a call isn't working as expected.
---

# Tool mechanics reference

Exact patterns for the calls that get wrong most often. Each entry shows the form
that works, the form that doesn't (when relevant), and why.

> **Convention:** every file tool also takes a required `fileKey` (from `status()`) — see
> the `set_instance` example under **Limits** for the full inline shape. It is omitted from
> the snippets below for brevity; add it to every call. (Addressing doctrine: `figma-connection`.)

---

## Instance text override — compound child id

**The problem.** `set_instance` sets a component property value on an instance, but
if `update_component` created the TEXT property **without** a `targetNodeId` (leaving
it unbound), the instance's text doesn't change. The property is inert. (Pass
`targetNodeId` at creation time instead and the bind works — see **Limits** below;
this section is the fallback for properties left unbound, or for one-off content not
modeled as a property at all.)

**The fix.** Update the text node directly via `update_node`, using its compound id:

```
I<instanceId>;<masterTextNodeId>
```

The compound id is **deterministic** — you don't need to call `get_node` on every
instance to discover it. Call `get_node` on the **master component** once to find the
text node id (`masterTextNodeId`), then build the compound id for each instance by
combining with that instance's id.

**Full text patch.** When updating instance text, always supply a **complete** text
patch (content + font + color). A content-only patch (`raw.trim()`) errors when the
existing text has mixed styles. Patch shape:

```json
{
  "nodeId": "I<instanceId>;<masterTextNodeId>",
  "patch": {
    "text": {
      "content": "Revenue",
      "font": "font(Inter, SemiBold, 14)",
      "color": "#111827"
    }
  }
}
```

(`update_node` is `{nodeId, patch}` — the NodeSpec fields go **inside** `patch`.) When the
text you are re-writing is token- or style-bound, carry its `var(…)` / `style(…)` wrappers
into the patch — see **Binding variables and applying styles**.

**Efficiency shortcut.** When overriding text on N instances of the same component:

- Long path: for each instance → `get_node(instance)` → parse child id → `update_node(childId, patch)` — N extra round-trips.
- Short path: get master text node id once → build `I<inst>;<master>` for each instance → N `update_node` calls, 0 extra reads.

---

## Fixed-size frames — sizing

Auto-layout frames default to `HUG` sizing on both axes, which collapses the frame
to its content. Set sizing explicitly whenever you want a fixed-size frame:

```json
{ "sizing": ["FIXED", "FIXED"] }
```

Values: `FIXED` / `HUG` / `FILL`. Tuple is `[horizontal, vertical]`.

**On a create, it depends on whether you stated a `layout`:**

- **No `layout` stated** — the frame is created as a vertical stack and the `size` you
  stated is pinned `["FIXED","FIXED"]` for you. Nothing to add. (Want it to hug? State
  `sizing` yourself, or omit `size`.)
- **`layout` stated** (for `gap` / `pad` / a horizontal row) — it is yours, and so is the
  sizing: pass `sizing` alongside `size`, or the layout hugs the dimensions away.

On `update_node`, giving an existing fixed frame a layout always needs `sizing` with it.

---

## Clipped effects — a frame clips by default

**The problem.** A shadow, a glow, an `align=OUTSIDE` stroke, a blur — each paints
**outside** the node it sits on, and the nearest clipping ancestor cuts off whatever
falls past its edge. Frames clip unless told otherwise: the create path never sets
`clipsContent` for you, so a created FRAME takes Figma's own default of `true`. The
data stays honest while the render is wrong — `effects: [shadow(0,8,24,#00000059)]`
reads back exactly as written, because the effect really is on the node; it is the
ancestor that swallows it. Only the PNG shows the loss, which is how one dashboard
build shipped 29 of 29 shadowed nodes clipped, 17 of them rendering nothing at all.

**The fix.** Budget for the effect before you add it.

- Work out its **reach** — how far it paints past the node's box, edge by edge, because
  the offset decides which edges pay: `shadow(x,y,r){spread=s}` reaches `y + r + s`
  below and `r + s − y` above; `blur(r)` reaches `r` all round; an `align=OUTSIDE`
  stroke reaches its weight. (`inner-shadow(…)` and `bg-blur(…)` render inside the node
  and reach nothing.)
- Give **every clipping ancestor** between the node and the canvas that much slack on
  the edges the effect reaches — padding, gap, or plain size beyond the node's box.
- A wrapper that exists only to group its children has no visual reason to clip:
  create it with `clipsContent: false`.

Reads report `clipsContent: true` and omit the field when clipping is off, so an absent
`clipsContent` on a frame you read back is a frame that does not clip — but only on an
**unprojected** read: no narrowing profile carries `clipsContent` at all (`effects`
survives one, `profile: 'style'`, which drops `clipsContent` in its turn), so a
`profile: 'layout'` read-back shows a document with nothing clipping anything.

---

## Stroke-only SVG needs `fill="none"`

**The problem.** SVG's own default for `fill` is black, and `create_from_svg` hands
your markup to Figma unaltered — nothing rewrites it on the way in. So a stroke-only
`<path>` / `<circle>` that names no `fill` imports as a shape carrying a real
`#000000` paint: a black slab where a line icon belongs on a dark surface, and an
off-palette hardcode in every read-back afterwards.

**The fix.** Put `fill="none"` on every stroke-only element before the call:

```xml
<path d="M4 8h8" fill="none" stroke="#94A3B8" stroke-width="1.5" />
```

Nothing warns about the black — the check is a read-back of the imported subtree with
no `#000000` in any `fills`.

---

## Vector geometry — the path a read gives you writes back

**The shape.** A VECTOR node's geometry is `vectorPaths`, an array of `path()` atoms, and
both `create_node` and `update_node` write it — so the `vectorPaths` a read hands you goes
straight back into a patch:

```json
{
  "nodeId": "<vectorId>",
  "patch": {
    "vectorPaths": ["path(NONZERO,\"M 12 0 L 24 24 L 0 24 Z\")"]
  }
}
```

**Fill rule first, data second — both required.** `path(M 12 0 L 24 24 Z)` is the common
slip and it is `INVALID_PARAM` before anything is written, with the canonical form in the
message. Data Figma cannot draw is the other failure and it degrades instead: the node
lands, `vectorPaths` drops, and `warnings[]` carries Figma's own error. Per-point corners
and caps ride in the atom's `{…}` channel; full contract in `grammar.md` — **Vector
geometry**.

**Order inside one patch.** Assigning `vectorPaths` rebuilds the node's network and
**resizes the node to the new path bounds**, so a `size` stated in the same patch is
applied after the geometry — state both and the size you asked for is the one you get. A
path aimed at a node type that carries none is named in `warnings[]`, not swallowed.

---

## A write into a slot is read back, then trusted

**The problem.** A slot arrives with defaults of its own — a vertical stack, 100×100,
an opaque `#FFFFFF` fill (`components.md` §5) — so a write into one lands _on top of_
them rather than replacing them, and `sizing` / `size` are where the request and the
result part company most often: send a row `["FILL", "HUG"]` into a container that
cannot grant a fill and the `FILL` is simply not there on the read-back, while
everything built on top inherits the width it did get. A write reports the degrades it
knows about in `warnings[]` (a slot entry's are prefixed with the slot's name), but a
warning is a **signal that something moved, not proof of what landed** — it says what
the writer knew to say, not what Figma did.

**The fix.** After filling a slot, read the subtree back and diff it against what you
sent:

```json
{ "nodeId": "<slotId>", "depth": 2 }
```

Compare `sizing`, `size`, and `layout` field for field, and fix the drift before
building on top of it — the repair costs whatever you have stacked on the wrong
number by the time you notice.

---

## Single-edge dividers are per-side strokes

**The problem.** A 1 px rectangle standing in for a bottom border is a node somebody
has to keep in sync. In the flow it is a real auto-layout child that takes a gap of
its own; out of the flow (`layoutPositioning: ABSOLUTE`) auto-layout ignores it, so
nothing resizes it. Either way its width is a literal, and the first time the
container's width changes the rule stops matching it — silently, because there is
nothing invalid about a stale rectangle.

**The fix.** Put the edge on the node that owns it — a per-side stroke weight plus a
stroke paint:

```json
{
  "stroke": "stroke([0,0,1,0])",
  "strokes": ["var(border/subtle)#1F2937"]
}
```

Weights are `[top, right, bottom, left]`, so `[0,0,1,0]` is a bottom rule; the atom's
other keys (align, cap, dash) are in `grammar.md`. The border now belongs to the frame
and follows every resize the frame makes. One caveat from that same grammar: a
per-side weight is one of the splits Figma cannot bind, so hang the `var()` on the
paint in `strokes[]` — which is where the token you care about lives anyway.

---

## Gradient borders, and gradients that carry tokens

**A gradient border is a gradient stroke — never a box-in-a-box.** The
padded-wrapper form (a gradient-filled outer frame with a solid inner
panel) costs a node, forces concentric-radius math on the inner corner,
and kinks the corner when that math is skipped. Paint the outline
instead:

```json
{
  "strokes": ["linear(135, var(brand/violet)#7C5CFF@0, var(brand/cyan)#22D3EE@100)"],
  "stroke": "stroke(2, {align=INSIDE})",
  "radius": "var(radius/xl)20"
}
```

One node, one radius, and the paint follows every corner by
construction.

**Gradient stops bind to tokens — bind them by default.** Each stop
takes the same `var()` wrapper a solid paint does:
`linear(135, var(brand/violet)#7C5CFF@0, var(brand/cyan)#22D3EE@100)`.
The read-back returns the wrappers, and a bare hex inside a gradient is
an unbound literal exactly as it is on a solid. Reserve a paint **style**
for a gradient that is itself a named, reused thing (`Gradient/Hero`) —
the style owns the whole field (`fills: "style(Gradient/Hero)"`), one
home for the recipe; the stop bindings ride inside the style's own
definition.

**The wrapper is the write.** An inline `var(Name)value` / `style(Name)value` atom
applies the literal **and then** binds by name — one call, no id lookup:

```json
{
  "nodeId": "<cardId>",
  "patch": {
    "fills": ["var(surface/2)#141B2E"],
    "strokes": ["var(border/subtle)#1F2937"],
    "radius": "var(radius/medium)8"
  }
}
```

```json
{
  "nodeId": "<titleId>",
  "patch": {
    "text": {
      "content": "Revenue",
      "font": "style(Heading/H3)font(Inter,SemiBold,18)",
      "color": "var(text/primary)#F8FAFC"
    }
  }
}
```

The same atoms go straight into a `create_node` `spec` or any node of a `create_tree`
`tree` — binding is a property of the value, not of the tool.

The read-back is the proof: `get_node` returns those same wrapped atoms
(`var(surface/2)#141B2E`, `style(Heading/H3)font(Inter,SemiBold,18)`) — the wrapper
came back, so the binding is live. Write back what a read handed you and you keep the
binding instead of flattening it to a literal.

Binding is **by name**, never by id, and a name that resolves to nothing costs the
binding, not the write: the literal lands and the reply says which token was missed
(`var(surface/2): no variable with that name — literal applied unbound`, as a
`warnings[]` entry or a trailing `Warning:` line). Which fields a wrapper binds is in
`grammar.md` — **`var()` and `style()` rules**; read it before assuming a field binds.

**A style owns the whole field.** Figma holds one style link per slot, and writing the
field directly is what detaches it — so `fills`, `strokes`, `effects` and `grids` are
**either** a style reference **or** a list of literals, never both:

```json
{
  "nodeId": "<cardId>",
  "patch": {
    "effects": "style(AB/Blur)",
    "fills": ["var(surface/2)#141B2E"]
  }
}
```

The mistake worth naming is the mix — the team's blur **plus** your own shadow:

```json
{
  "nodeId": "<cardId>",
  "patch": {
    "effects": [
      "style(AB/Blur)bg-blur(24)",
      "shadow(0,8,24,#00000066)"
    ]
  }
}
```

That is `INVALID_PARAM`, raised before anything is written, and the message is the
fix: _a style owns the whole effects list — use a style containing every effect you
want, or write them all as literals (a style cannot be combined with literal
siblings)_. So put the shadow in the style, or drop the reference and write both —
`"effects": ["bg-blur(24)", "shadow(0,8,24,#00000066)"]`.

A read hands the reference back with the list it resolves to
(`effects: style(AB/Blur)[bg-blur(24)]`), which is writable verbatim: the list rides
along and is never applied as literals. Write a list that isn't what the style
supplies and the style still wins, with one `warnings[]` entry naming what didn't
land. Full contract: `grammar.md` — **A styled field is a reference, not a list**.

**On masters, not instances.** Bind variables and apply styles on the **master
component** — instances inherit automatically. Binding on an instance is overridden
on the next master edit.

**`bind_variable` — the retrofit route,** for a field no write is otherwise touching:

```json
{
  "nodeId": "<masterNodeId>",
  "field": "fills",
  "variableId": "<variableId>"
}
```

- `field` is a **flat node field** — `fills`, `strokes`, `opacity`, `itemSpacing`,
  `cornerRadius`, `strokeWeight`, … — never a dotted path (there is no
  `fills.0.color`).
- `fills` / `strokes` bind **every solid paint** in the array; the tool takes no index.
  (An inline `var()` binds only the paint it sits on.)
- `variableId` is an **id** from `get_variables`; `field` and `variableId` are mutually
  required. Names belong to the inline route, ids to this one.
- A field Figma can't bind degrades rather than fails — the call succeeds and
  `warnings[]` carries `field "effects" is not bindable on FRAME: …`. Effects take a
  style (below), not a variable.

**`bind_variable`'s other job — the collection-mode pin.** Omit `variableId` and
`field` entirely and the call binds nothing; it pins which mode of a collection the
node renders in:

```json
{
  "nodeId": "<frameId>",
  "mode": { "<collectionId>": { "modeName": "Dark" } }
}
```

Each entry takes `modeId`, `modeName` (resolved against the collection's modes), or
`clearMode: true`; read it back as `explicitVariableModes` (`{collectionId: modeId}`).
A call with neither a field binding nor a mode map is rejected as `INVALID_PARAM`.

**`apply_style` — the same retrofit route for styles:**

```json
{
  "nodeId": "<masterNodeId>",
  "styleId": "<styleId>",
  "field": "text"
}
```

`field` is **required** and is one of `fill` | `stroke` | `text` | `effect` | `grid`. It
names the setter to use, not the style's own type — and a category mismatch (a paint
style through `field: "text"`) is a hard error, not a warning. Style ids come from
`get_styles`.

**Spacing tokens are wrappers too.** `layout.gap` (and the GRID spellings `rowGap` /
`colGap`) and each of the four `layout.pad` sides take a `var()` the same way a paint
does, so a spacing scale is bound inline and reads back visibly:

```json
{
  "nodeId": "<cardId>",
  "patch": {
    "layout": {
      "mode": "V",
      "gap": "var(space/8)8",
      "pad": ["var(space/16)16", 16, "var(space/16)16", 16]
    }
  }
}
```

`pad` binds **per side, by position** — the two sides above are bound and left/right stay
literal — because Figma holds each padding side as its own field. A read emits the
wrappers it finds, so a bare `gap: 8` in a read-back is a spacing token that was never
bound, not a binding the read could not see. Write the struct back verbatim and the
binding survives.

One pair is refused everywhere: `align: ["SPACE_BETWEEN", …]` with a **variable-bound**
gap is self-contradictory (space-between means the gap is automatic), and every write
door rejects it. A document that already carries the pair refuses align edits until the
gap is cleared — `bind_variable {nodeId, field: 'itemSpacing', clear: true}`, then
write.

**Uniform binds, split doesn't.** A wrapper on a per-corner `radius`, a per-side
`stroke([…])` weight, or a per-range `text.runs[]` atom writes the literal and warns
(`var(radius/medium) on a per-corner radius: a single binding cannot express per-corner
values — literal applied unbound`). Figma binds all four corners — or all four sides —
at once, so there is nothing faithful to bind. Bind the uniform form, or take the
literal knowingly. (`pad` is not one of these: Figma binds its four sides separately, so
the grammar does too.)

**Rebind, don't delete-and-recreate.** Deleting a variable or style breaks every
binding that pointed at it and the delete reply says nothing about it; you find out
later, when the next `var(Name)` / `style(Name)` write degrades to "no … with that
name". Prefer `update_variables` / `update_styles` over a delete + create.

---

## Combining variants — `combine_variants`

To create a component set (variants), build each variant as a separate component
first, then combine:

```json
{
  "componentIds": ["<id1>", "<id2>", "<id3>"],
  "name": "Button"
}
```

Those are the only params — plus an optional `parentId`, which defaults to the first
component's parent. **The axes are not a param: they come from the component names.**
Figma reads each name as `Property=Value`, so the three components above are named
`State=Default`, `State=Hover`, `State=Pressed` _before_ the call, and the set forms one
`State` axis. Multiple axes comma-separate the pairs: `Style=Primary, Size=Large`.

A name with no `=` packs its whole value into one anonymous axis, so the set won't form a
clean one-property-per-axis grouping. That case doesn't fail — the reply carries a
`warnings[]` entry naming every component whose name lacks the convention.

After combining, the result is a `COMPONENT_SET` node containing `COMPONENT`
children with `variantProperties` set, and the reply's `variantAxes` reports the axes
Figma actually derived — read it back to confirm you got the grouping you meant.
Instances of the set get a `variantProperties` field that selects which variant is shown.

**Then give the set container room.** A fresh set is a dashed frame hugging its
variants flush against the border. Patch it with auto-layout **and** HUG sizing in one
call — `layout: {mode: 'H', pad: […], gap: …}` plus `sizing: ["HUG","HUG"]` — so the
variants sit clear of the dashed frame; layout alone keeps the old FIXED height and the
children poke past it. Set geometry is definition chrome — no screen instance moves
when it changes. The concrete padding and gap are a house value (`figma-bridge-prefs`).

---

## Limits

### `update_component` TEXT property binding — pass `targetNodeId`

`update_component` with `add: [{type: "TEXT", name: "Label", defaultValue: "x"}]`
(no `targetNodeId`) creates the property definition but leaves it **unbound** to any
text node — `set_instance({ fileKey, nodeId, properties: {Label: "Revenue"} })` then
sets the property value on the instance object but no text node changes.

**Fix: bind it at creation.** Add `targetNodeId: "<masterTextNodeId>"` (and optionally
`field`, defaults to `characters` for TEXT) to the `add` entry:

```json
{ "name": "Label", "type": "TEXT", "defaultValue": "x", "targetNodeId": "<masterTextNodeId>" }
```

Verified live: with `targetNodeId` supplied, the property genuinely binds via
`componentPropertyReferences`, and `set_instance({ properties: { Label: "Revenue" } })`
updates the actual rendered text on every instance — both the bare property name and
the full `Name#id` key work as the properties-object key.

**Verifying the bind.** `get_node(masterTextNodeId)` surfaces
`componentPropertyReferences` on every node that carries one, so the map coming back
_is_ the proof the bind landed. Narrowing profiles (`minimal`, `layout`, `style`,
`text`) drop it — read it back unnarrowed, or name it: `get_node(masterTextNodeId, { fields: ["componentPropertyReferences"] })`.

**If you truly need it unbound** (or already have a component whose TEXT property was
added without `targetNodeId`), fall back to the compound-id override path described
above.

### Rotated nodes — the size is true, the position is the bounding box

`size` on a rotated node is its **own unrotated** width and height: the read enriches
every node it returns complete with the real dimensions, so the axis-aligned bounding
box (which a rotation inflates — a 30°-rotated 60×60 measures ~82×82) is not what you
get back.

`position` is the other half and it did **not** get the same treatment: it is derived
from the bounding box, so on a rotated node it is where that box starts, not where the
node's corner is. So the two fields describe **different rectangles** the moment
`rotation` is non-zero (reads omit `rotation` when it is 0, so its presence is the
flag). Never feed both into one geometry calculation there — for a true origin,
un-rotate, read, re-rotate.

### Off-canvas invalid profile

`get_node` may return an invalid or partial profile for nodes positioned outside the
canvas. Handle gracefully (treat as unknown; prompt the user to move the node on-canvas).
