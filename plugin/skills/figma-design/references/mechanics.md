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
if `update_component` created the TEXT property without binding it to a text node,
the instance's text doesn't change. The property is inert.

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
to its content. For a fixed-size frame, always set sizing explicitly:

```json
{ "sizing": ["FIXED", "FIXED"] }
```

Values: `FIXED` / `HUG` / `FILL`. Tuple is `[horizontal, vertical]`.

If you create a frame with a target size but omit sizing, auto-layout will override
the dimensions on render. Set sizing at the same time as `size`.

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
  "variantPropertyName": "State",
  "variantValues": ["Default", "Hover", "Pressed"]
}
```

After combining, the result is a `COMPONENT_SET` node containing `COMPONENT`
children with `variantProperties` set. Instances of the set get a `variantProperties`
field that selects which variant is shown.

The variant property name must be consistent across all components in the set; if the
components already have `variantProperties` set, `combine_variants` merges them.

---

## Limits

### `update_component` TEXT property is inert

`update_component` with `add: [{type: "TEXT", name: "Label", defaultValue: "x"}]`
creates the property definition on the component, but it is **not bound** to any
specific text node. Consequently `set_instance({ fileKey, nodeId, properties: {Label: "Revenue"} })`
sets the property value on the instance object but no text node changes.

**Workaround:** use the compound-id override path described above. File the binding
gap as a bug via `figma-feedback` so it can be addressed in the tool.

### No `delete_variables` / `delete_styles`

There is no tool to delete variables or styles. The correct pattern is to reuse
existing ones. If a token or style needs renaming or restructuring, it must be done
directly in Figma by the user — the agent can't clean up stale tokens.

### Rotated frame bounding box

`get_node` on a rotated frame returns the **bounding-box** dimensions (the axis-
aligned rectangle enclosing the rotated frame), not the frame's own width and height.
If you need the frame's intrinsic size, un-rotate it, read, then re-rotate — or check
the `rotation` field and correct mathematically.

### Off-canvas invalid profile

`get_node` may return an invalid or partial profile for nodes positioned outside the
canvas. Handle gracefully (treat as unknown; prompt the user to move the node on-canvas).
