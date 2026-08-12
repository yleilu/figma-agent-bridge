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

## Binding variables and applying styles

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

**Uniform binds, split doesn't.** A wrapper on a per-corner `radius`, a per-side
`stroke([…])` weight, or a per-range `text.runs[]` atom writes the literal and warns
(`var(radius/medium) on a per-corner radius: a single binding cannot express per-corner
values — literal applied unbound`). Figma binds all four corners — or all four sides —
at once, so there is nothing faithful to bind. Bind the uniform form, or take the
literal knowingly.

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

### Rotated frame bounding box

`get_node` on a rotated frame returns the **bounding-box** dimensions (the axis-
aligned rectangle enclosing the rotated frame), not the frame's own width and height.
If you need the frame's intrinsic size, un-rotate it, read, then re-rotate — or check
the `rotation` field and correct mathematically.

### Off-canvas invalid profile

`get_node` may return an invalid or partial profile for nodes positioned outside the
canvas. Handle gracefully (treat as unknown; prompt the user to move the node on-canvas).
