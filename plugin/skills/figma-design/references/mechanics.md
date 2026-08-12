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
  "text": {
    "content": "Revenue",
    "font": "font(Inter, SemiBold, 14)",
    "color": "#111827"
  }
}
```

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

**On masters, not instances.** Bind variables and apply styles on the **master
component** — instances inherit automatically. Binding on an instance is overridden
on the next master edit.

**`bind_variable`** — binds a design token (local variable) to a scalar field on a
node:

```json
{
  "nodeId": "<masterNodeId>",
  "fieldPath": "fills.0.color",
  "variableId": "<variableId>"
}
```

After binding, `get_node` read-back shows `var(token/name)#RRGGBB` — the `var(...)`
wrapper confirms the binding is live.

**`apply_style`** — applies a named style (text, fill, effect, grid) to a node:

```json
{
  "nodeId": "<masterNodeId>",
  "styleType": "TEXT",
  "styleId": "<styleId>"
}
```

Get style ids from `get_styles`. Read-back shows `style(Name)font(...)` on the
text's `font` atom.

**`bind_variable` vs `apply_style`:** use `bind_variable` for individual token
bindings (color, spacing, radius); use `apply_style` for composite named styles
(typography ramp, fill style, effect set).

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
