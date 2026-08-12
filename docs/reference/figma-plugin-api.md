---
title: Figma Plugin API Reference
created: 2026-06-22T17:00:00+08:00
tags:
  - reference
  - figma-bridge
  - figma-api
type: reference
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
---

# Figma Plugin API Reference

> Governed by [[figma-bridge/docs/principles|the principles]]. This is the **physical
> ceiling** the tool layer maps onto: by [[figma-bridge/docs/principles#T6 — Possible + useful, no opinions|T6]]
> the tools aim to expose every distinct capability below, and by
> [[figma-bridge/docs/principles#T7 — Honest capability|T7]] every tool maps to a real API here.

**The physical limitation — anything not in this file is not possible.** This is the raw
Figma Plugin API surface; the tool layer ([[figma-bridge/docs/specs/tool-surface]]) is a
clean facade over it.

**Fallback rule for scenario agents:** use our tools first. When our tools can't do
something the API below allows, fall back to the raw API and mark it `FALLBACK → raw API`.

**Provenance.** The method/property inventory was extracted via runtime introspection of
the live `figma` global in the Figma plugin sandbox on **2026-03-22**; every entry was
verified to exist at runtime. Items that exist but are **not in Figma's public docs** are
flagged `UNDOCUMENTED` — treat them as feature-detect-only (degrade gracefully per
[[figma-bridge/docs/principles#T7 — Honest capability|T7]]).

> Consolidated from two former sources — a curated method list and a runtime dump —
> since removed. One fact, one place.

---

## Node Creation

| Method | Returns | Notes |
|--------|---------|-------|
| `figma.createFrame()` | FrameNode | Primary container |
| `figma.createRectangle()` | RectangleNode | Basic shape |
| `figma.createEllipse()` | EllipseNode | Circle / ellipse / arc |
| `figma.createText()` | TextNode | Requires `loadFontAsync` before setting text |
| `figma.createLine()` | LineNode | Line shape |
| `figma.createVector()` | VectorNode | Custom paths |
| `figma.createPolygon()` | PolygonNode | Multi-sided polygon |
| `figma.createStar()` | StarNode | Star shape |
| `figma.createComponent()` | ComponentNode | Reusable component |
| `figma.createComponentFromNode(node)` | ComponentNode | Promote to component; preserves children and properties |
| `figma.createSection()` | SectionNode | Canvas organization |
| `figma.createPage()` | PageNode | New page |
| `figma.createPageDivider()` | PageNode | Page divider |
| `figma.createSlice()` | SliceNode | Export slice |
| `figma.createTextPath(node, seg, pos)` | TextPathNode | Text on path |
| `figma.createNodeFromSvg(svgString)` | FrameNode | SVG import |
| `figma.createNodeFromJSXAsync(jsx)` | Promise\<SceneNode\> | JSX creation |
| `figma.createImage(bytes)` | Image | Image from `Uint8Array` (for ImagePaint) |
| `figma.createImageAsync(url)` | Promise\<Image\> | Image from URL (for ImagePaint) |
| `figma.createVideo(bytes)` | Video | Video from bytes |
| `figma.createVideoAsync(bytes)` | Promise\<Video\> | Video async |
| `figma.createBooleanOperation()` | BooleanOperationNode | **DEPRECATED** — use `union`/`subtract`/etc. |

## Node Transformation

| Method | Returns | Notes |
|--------|---------|-------|
| `figma.group(nodes, parent, index?)` | GroupNode | Group nodes |
| `figma.union(nodes, parent, index?)` | BooleanOperationNode | Boolean union |
| `figma.subtract(nodes, parent, index?)` | BooleanOperationNode | Boolean subtract |
| `figma.intersect(nodes, parent, index?)` | BooleanOperationNode | Boolean intersect |
| `figma.exclude(nodes, parent, index?)` | BooleanOperationNode | Boolean exclude |
| `figma.flatten(nodes, parent?, index?)` | VectorNode | Flatten to single vector |
| `figma.ungroup(node)` | SceneNode[] | Ungroup |
| `figma.transformGroup(nodes, parent, index, modifiers: TransformModifier[])` | TransformGroupNode | **A repeat-pattern feature** (linear/radial repeat), NOT general grouping. `type TransformModifier = LinearRepeatModifier \| RadialRepeatModifier`. Typed in 1.130.0. |

## Components

| Method / Property | Type | Notes |
|-------------------|------|-------|
| `figma.createComponent()` | ComponentNode | New empty component |
| `figma.createComponentFromNode(node)` | ComponentNode | Promote to component |
| `figma.combineAsVariants(nodes, parent, index?)` | ComponentSetNode | Create variant set |
| `figma.importComponentByKeyAsync(key)` | Promise\<ComponentNode\> | Import team component |
| `figma.importComponentSetByKeyAsync(key)` | Promise\<ComponentSetNode\> | Import team variant set |
| `component.createInstance()` | InstanceNode | Create instance |
| `component.key` | string (read-only) | Component key for cross-file instances |
| `component.remote` | boolean (read-only) | From team library? |
| `component.description` / `descriptionMarkdown` | string (read-write) | Description |
| `component.documentationLinks` | DocumentationLink[] (read-write) | External docs |
| `component.componentPropertyDefinitions` | object (read-only) | All property definitions |
| `component.variantProperties` | object (read-only) | Variant properties |
| `component.addComponentProperty(name, type, default)` | string | Add `BOOLEAN` / `TEXT` / `INSTANCE_SWAP` / `SLOT` property |
| `component.editComponentProperty(name, options)` | void | Modify property |
| `component.deleteComponentProperty(name)` | void | Remove property |
| `component.createSlot()` | SlotNode | **NEW in 1.130.0**, runtime-available in our sandbox but **absent from the pinned 1.123.0 typings** — feature-detect + cast before use (or bump `@figma/plugin-typings` toward 1.130.0). Takes **NO argument** — creates a brand-new empty SLOT node inside the component and returns it (auto-named "Slot"); name it via the returned node's `.name` property. Does NOT promote any existing child frame. (live-verified 2026-07-17). `interface SlotNode extends DefaultFrameMixin` → a SLOT **is an appendable frame-container** (`appendChild`/`children`), which is what makes slot-fill feasible. The returned slot is **born 100×100, FIXED, with an opaque `#FFFFFF` fill and NO auto-layout** (live-verified 2026-08-11) — so a fresh slot is visible white rather than transparent, and is exactly the shape that refuses a FILL direct child (see [Ordering Constraints](#ordering-constraints)). |
| `component.getInstancesAsync()` | Promise\<InstanceNode[]\> | All instances |
| `component.getPublishStatusAsync()` | Promise\<string\> | Publish status |
| `component.instances` | InstanceNode[] (read-only) | **DEPRECATED** — use `getInstancesAsync()` |
| `instance.mainComponent` / `masterComponent` | ComponentNode (read-write) | Source component (`masterComponent` is an alias) |
| `instance.componentProperties` | object (read-only) | Current property values |
| `instance.variantProperties` | object (read-only) | Variant property values |
| `instance.scaleFactor` | number (read-write) | Instance scale |
| `instance.isExposedInstance` / `exposedInstances` | (read-write / read-only) | Exposed-instance state |
| `instance.overrides` | object[] (read-only) | Applied overrides |
| `instance.setProperties(props)` | void | Set BOOLEAN / TEXT / INSTANCE_SWAP property overrides |
| `instance.swapComponent(component)` | void | Swap to a different component |
| `instance.detachInstance()` | FrameNode | Detach from component |
| `instance.resetOverrides()` / `removeOverrides()` | void | Reset / remove all overrides |

**Component property types** (verified at runtime):

| Type | `addComponentProperty` | Default value | Notes |
|------|------------------------|---------------|-------|
| `BOOLEAN` | works | `true` / `false` | Toggle child visibility |
| `TEXT` | works | any string | Text override |
| `INSTANCE_SWAP` | works | valid component key (non-empty) | Swap child instance |
| `SLOT` | works | `''` | **UNDOCUMENTED** — content slot |
| `VARIANT` | ComponentSet only | — | Lives on ComponentSetNode, not ComponentNode |

## Node Mutation

| Operation | API | Notes |
|-----------|-----|-------|
| Position | `node.x = n; node.y = n` | Read-write |
| Rotation | `node.rotation = deg` | Read-write |
| Resize | `node.resize(w, h)` | `width`/`height` are read-only; also `resizeWithoutConstraints`, `rescale(scale)` |
| Reparent | `parent.appendChild(node)` / `parent.insertChild(index, node)` | Frames also have `appendChildAt(row, col, node)` for grid layout |
| Delete | `node.remove()` | |
| Clone | `node.clone()` | |
| Fills | `node.fills = Paint[]` / `node.setFillsAsync(...)` | See [Paint Types](#paint-types) |
| Strokes | `node.strokes = Paint[]` / `node.setStrokesAsync(...)` | Plus `strokeWeight`, `strokeAlign`, `strokeJoin`, `strokeCap`, `strokeMiterLimit`, `dashPattern` |
| Effects | `node.effects = Effect[]` | See [Effect Types](#effect-types) |
| Text | `node.characters = '...'` | Requires `loadFontAsync` first; ordering constraint below |
| Aspect ratio | `node.lockAspectRatio()` / `unlockAspectRatio()` | |
| Outline | `node.outlineStroke()` | Convert stroke to vector outline |

## Styles

| Method | Returns | Notes |
|--------|---------|-------|
| `figma.createPaintStyle()` | PaintStyle | Set `.name`, `.paints` |
| `figma.createTextStyle()` | TextStyle | Set `.name`, font props |
| `figma.createEffectStyle()` | EffectStyle | Set `.name`, `.effects` |
| `figma.createGridStyle()` | GridStyle | Set `.name`, `.layoutGrids` |
| `figma.getLocalPaintStylesAsync()` | Promise\<PaintStyle[]\> | Read all paint styles |
| `figma.getLocalTextStylesAsync()` | Promise\<TextStyle[]\> | Read all text styles |
| `figma.getLocalEffectStylesAsync()` | Promise\<EffectStyle[]\> | Read all effect styles |
| `figma.getLocalGridStylesAsync()` | Promise\<GridStyle[]\> | Read all grid styles |
| `figma.getStyleByIdAsync(id)` | Promise\<BaseStyle\> | Lookup style |
| `figma.importStyleByKeyAsync(key)` | Promise\<BaseStyle\> | Import team style |

Apply to a node via the async setters (preferred) or the id assignments:
`node.setFillStyleIdAsync()`, `node.setStrokeStyleIdAsync()`, `node.setEffectStyleIdAsync()`,
or `node.fillStyleId = id`, `node.strokeStyleId = id`, `node.effectStyleId = id`,
`node.textStyleId = id`, `frame.setGridStyleIdAsync()` / `frame.gridStyleId = id`.

## Variables (`figma.variables`)

| Method | Notes |
|--------|-------|
| `createVariableCollection(name)` | Create collection |
| `createVariable(name, collectionId, type)` | `COLOR` / `FLOAT` / `STRING` / `BOOLEAN` |
| `createVariableAlias` / `createVariableAliasByIdAsync` | Create alias |
| `variable.setValueForMode(modeId, value)` | Set value per mode |
| `node.setBoundVariable(field, variable)` | Bind node field to a variable |
| `getLocalVariables` / `getLocalVariablesAsync` | List local variables |
| `getLocalVariableCollections` / `getLocalVariableCollectionsAsync` | List local collections |
| `getVariableById` / `getVariableByIdAsync` | Lookup variable |
| `getVariableCollectionById` / `getVariableCollectionByIdAsync` | Lookup collection |
| `importVariableByKeyAsync(key)` | Import from library |
| `extendLibraryCollectionByKeyAsync(key)` | Extend library collection |
| `getSubscribedVariables()` | Subscribed variables |
| `setBoundVariableForPaint` / `setBoundVariableForEffect` / `setBoundVariableForLayoutGrid` | Bind variable into a paint / effect / grid object |
| `collection.addMode(name)` / `removeMode(modeId)` / `renameMode(modeId, name)` | Mode lifecycle on a collection (+ `collection.modes`, `defaultModeId`) † |
| `node.setExplicitVariableModeForCollection(collection, mode)` | Pin a node/frame to render a collection in a chosen mode. **Prefer the `VariableCollection` OBJECT overload.** A deprecated `(collectionId: string, modeId: string)` string overload also exists but is `@deprecated` and **throws under `documentAccess:'dynamic-page'`** — do not use it. Present since 1.123.0 ‡ |
| `node.explicitVariableModes` | `{[collectionId: string]: modeId}` (read) — the node's OWN explicit mode pins as a MAP keyed by collection id. Distinct from the inheritance-resolved read-only `resolvedVariableModes` below. Present since 1.123.0 ‡ |
| `node.clearExplicitVariableModeForCollection(collection)` | Unpin — clear the node's explicit mode for a collection (prefer the `VariableCollection` OBJECT overload, as above). Present since 1.123.0 ‡ |
| `variable.scopes` | `Array<VariableScope>` read-write (GAP, CORNER_RADIUS, WIDTH_HEIGHT, …) † |
| `variable.codeSyntax` / `setVariableCodeSyntax(platform, value)` / `removeVariableCodeSyntax(platform)` | Per-platform code-syntax (WEB / ANDROID / iOS); read-write † |
| `variable.hiddenFromPublishing` | Boolean read-write — hide a variable when publishing the file as a library † |

> † Confirmed in the official Plugin API (developers.figma.com, 2026-06-24) but
> **absent from the 2026-03-22 runtime introspection** that built this table (it
> under-captured `Variable` / `VariableCollection` instance members). These are
> long-stable APIs, so present in our sandbox; flagged for an introspection
> re-capture to reach 100% runtime-verified.
>
> ‡ Confirmed present in `@figma/plugin-typings` since **1.123.0** (the version the
> plugin currently pins) — directly buildable, no version bump needed. The read shape
> `explicitVariableModes` is a `{collectionId: modeId}` **map** while the write verbs act
> on **one collection per call**: this read/write shape asymmetry is deliberate and must
> be handled explicitly (a mode-write verb accepts the map, or the N-call asymmetry is
> documented), not silently.

## Read / Query

| Method / Property | Notes |
|-------------------|-------|
| `figma.getNodeByIdAsync(id)` | Node lookup (async; `getNodeById` is the sync legacy form). **⚠️ Does NOT resolve compound instance-child ids (`I<inst>;<child>`, e.g. a SLOT inside an instance) — it hangs. Traverse the instance instead: `(instance as InstanceNode).findOne(n => n.id === compoundId)`. (live-verified 2026-07-17)** |
| `figma.currentPage` | Current page (settable) |
| `figma.currentPage.selection` | Current selection |
| `figma.root` | DocumentNode; `figma.root.children` = all pages |
| `node.findAll(cb)` / `findOne(cb)` / `findChild(cb)` / `findChildren(cb)` | Traverse descendants (container nodes) |
| `node.exportAsync(settings)` | Export image |
| `node.getCSSAsync()` | CSS for the node |
| `figma.getSelectionColors()` | Selection color analysis |
| `figma.util.rgb(hex)` / `rgba(hex)` / `solidPaint(hex)` | Hex → color / paint helpers |
| `figma.util.normalizeMarkdown(str)` | Markdown normalization |
| `figma.loadFontAsync(fontName)` | Load a font before text edits |
| `figma.listAvailableFontsAsync()` | Available fonts — fork/runtime-confirmed |
| `figma.annotations.*` | `addAnnotationCategoryAsync`, `getAnnotationCategoriesAsync`, `getAnnotationCategoryByIdAsync`. Plus `node.annotations` (read/write) for per-node annotations — fork/runtime-confirmed (the working fork implements it). **⚠️ Dev Mode only:** annotations require `editorType==='dev'` — unavailable in the default Design editor, so `get_annotations`/`set_annotations` feature-detect (`'annotations' in node`) and **degrade with a warning** (T7). A Figma editor gate, not a tool gap. |

Other global properties: `figma.currentUser`, `figma.activeUsers`, `figma.editorType`
(`'figma' | 'figjam' | 'dev' | 'slides'`), `figma.apiVersion`, `figma.fileKey`,
`figma.mixed` (symbol), `figma.hasMissingFont`, `figma.viewport` (bounds/center/zoom/
`scrollAndZoomIntoView`), `figma.ui`, `figma.clientStorage`, `figma.payments`,
`figma.teamLibrary`, `figma.widget`.

## Prototyping

| Method / Property | Notes |
|-------------------|-------|
| `node.reactions` | Read reactions |
| `node.setReactionsAsync(reactions)` | Set interactions |

## Ordering Constraints

These are sequencing rules — not separate capabilities. Violating them silently corrupts
state, so the tool layer must enforce order.

| Constraint | Rule |
|------------|------|
| FILL sizing | Set `layoutSizing*` to FILL **after** `appendChild` to an auto-layout parent |
| `layoutPositioning: ABSOLUTE` | Set **after** `appendChild` |
| `loadFontAsync()` | Must resolve **before** setting any text property |
| `component.createSlot()` | Takes **no argument**; creates a new empty SLOT node and **returns** it (auto-named "Slot"). Name the slot via the returned node's `.name`. No pre-existing child required. (live-verified 2026-07-17) |
| FILL sizing inside a SLOT | A SLOT is an appendable frame-container but is **created without auto-layout**, so its **DIRECT** child cannot take `layoutSizing* = FILL` until the slot itself is given auto-layout — Figma refuses with *"FILL can only be set on children of auto-layout frames"*. **Deeper descendants are unaffected**: a child of that child fills normally, because its own parent is an ordinary frame. Give the slot auto-layout first and the direct child fills like any other. ⚠️ **Two different refusal messages, both genuine** — a bare (non-auto-layout) **plain FRAME** parent throws *"node must be an auto-layout frame or a child of an auto-layout frame"* for the same write, while a **SLOT** parent throws the FILL wording above; they differ by parent context, not by version. (both live-captured 2026-08-11) The tool layer degrades rather than throws (T7) and surfaces either one wrapped as `sizing not applicable on this node (<TYPE>): <original error>`. |
| `textAutoResize` | Set **before** `resize()` on TEXT nodes |

---

## Node Properties by Type

Property counts are prototype-property totals observed at runtime (2026-03-22), with the
count of properties unique to that node type.

### Shared (all node types)

**Read-write:** `name`, `visible`, `locked`, `x`, `y`, `rotation`, `opacity`, `blendMode`,
`fills`, `fillStyleId`, `strokes`, `strokeStyleId`, `strokeWeight`, `strokeAlign`,
`strokeJoin`, `strokeCap`, `strokeMiterLimit`, `dashPattern`, `effects`, `effectStyleId`,
`isMask`, `maskType`, `constraints`, `layoutAlign`, `layoutGrow`, `layoutPositioning`,
`layoutSizingHorizontal`, `layoutSizingVertical`, `minWidth`, `maxWidth`, `minHeight`,
`maxHeight`, `exportSettings`, `componentPropertyReferences`, `reactions`, `annotations`,
`gridRowSpan`, `gridColumnSpan`, `gridChildHorizontalAlign`, `gridChildVerticalAlign`,
`variableWidthStrokeProperties`, `complexStrokeProperties`, `constrainProportions`,
`playbackSettings`.

**Read-only:** `id`, `type`, `parent`, `removed`, `width`, `height` (use `resize()`),
`absoluteTransform`, `absoluteBoundingBox`, `absoluteRenderBounds`, `fillGeometry`,
`strokeGeometry`, `boundVariables`, `resolvedVariableModes` (inheritance-resolved; the
node's OWN explicit pins are the read-write `explicitVariableModes` map — see
[Variables](#variables-figmavariables)), `inferredVariables`,
`stuckNodes`, `attachedConnectors`, `isAsset`, `detachedInfo`.

**Methods:** `clone()`, `remove()`, `resize(w,h)`, `resizeWithoutConstraints(w,h)`,
`rescale(scale)`, `setBoundVariable(field, variable)`, `setFillStyleIdAsync()`,
`setStrokeStyleIdAsync()`, `setEffectStyleIdAsync()`, `setFillsAsync()`, `setStrokesAsync()`,
`exportAsync(settings)`, `setReactionsAsync(reactions)`, `getCSSAsync()`,
`lockAspectRatio()`, `unlockAspectRatio()`, `outlineStroke()`.

### FRAME — 170 props

**Read-write:**
- Auto-layout: `layoutMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `primaryAxisSizingMode`, `counterAxisSizingMode`
- Padding: `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`, `horizontalPadding`, `verticalPadding`
- Spacing: `itemSpacing`, `counterAxisSpacing`
- Wrap: `layoutWrap`, `counterAxisAlignContent`
- Grid layout: `gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`, `gridRowSizes`, `gridColumnSizes`
- Corner radius: `cornerRadius`, `cornerSmoothing`, `topLeftRadius`, `topRightRadius`, `bottomLeftRadius`, `bottomRightRadius`
- Per-side stroke: `strokeTopWeight`, `strokeBottomWeight`, `strokeLeftWeight`, `strokeRightWeight`
- Clip/overflow: `clipsContent`, `overflowDirection`, `numberOfFixedChildren`
- Other: `expanded`, `guides`, `layoutGrids`, `gridStyleId`, `backgrounds`, `backgroundStyleId`, `itemReverseZIndex`, `strokesIncludedInLayout`, `devStatus`

**Methods:** `appendChild(node)`, `insertChild(index, node)`, `appendChildAt(row, col, node)`,
`findAll()`, `findOne()`, `findChild()`, `findChildren()`, `setGridStyleIdAsync()`.

### RECTANGLE — 113 props (0 unique)

`cornerRadius`, `cornerSmoothing`, per-corner radii (`topLeftRadius` …), per-side stroke
weights. No properties beyond shared + corner/stroke.

### ELLIPSE — 113 props (1 unique)

| Property | Type | Notes |
|----------|------|-------|
| `arcData` | `{startingAngle, endingAngle, innerRadius}` (read-write) | Pie charts, donut rings, progress arcs. Default = full circle (0 → 2π, innerRadius 0) |
| `cornerRadius`, `cornerSmoothing` | number (read-write) | |

### TEXT — 192 props (80+ unique)

**Read-write:** `characters`, `fontName` (`{family, style}`, needs `loadFontAsync`),
`fontSize`, `textAlignHorizontal` (`LEFT`/`CENTER`/`RIGHT`/`JUSTIFIED`), `textAlignVertical`
(`TOP`/`CENTER`/`BOTTOM`), `lineHeight` (`{value, unit}`, unit `PIXELS`/`PERCENT`/`AUTO`),
`letterSpacing` (`{value, unit}`, unit `PIXELS`/`PERCENT`), `textDecoration`
(`NONE`/`UNDERLINE`/`STRIKETHROUGH`), `textDecorationStyle`, `textDecorationSkipInk`,
`textDecorationOffset`, `textDecorationThickness`, `textDecorationColor`, `textCase`
(`ORIGINAL`/`UPPER`/`LOWER`/`TITLE`/`SMALL_CAPS`/`SMALL_CAPS_FORCED`), `paragraphSpacing`,
`paragraphIndent`, `listSpacing`, `textAutoResize`
(`NONE`/`WIDTH_AND_HEIGHT`/`HEIGHT`/`TRUNCATE`), `textTruncation` (`DISABLED`/`ENDING`),
`maxLines`, `hyperlink`, `textStyleId`, `autoRename`, `hangingPunctuation`, `hangingList`,
`leadingTrim`.

**Read-only:** `fontWeight`, `hasMissingFont`, `openTypeFeatures`.

**Range methods (mixed styling across character ranges):** `get/setRangeFontSize`,
`get/setRangeFontName` (fork/runtime-confirmed), `getRangeAllFontNames`, `get/setRangeTextDecoration`,
`get/setRangeTextCase`, `get/setRangeLineHeight`, `get/setRangeLetterSpacing`,
`get/setRangeParagraphSpacing`, `get/setRangeFills`,
`getRangeTextStyleId`/`setRangeTextStyleId`/`setRangeTextStyleIdAsync`,
`getRangeFillStyleId`/`setRangeFillStyleId`/`setRangeFillStyleIdAsync`,
`get/setRangeHyperlink`, `get/setRangeListOptions`, `get/setRangeListSpacing`,
`get/setRangeIndentation`, `get/setRangeParagraphIndent`, `get/setRangeBoundVariable`,
`getRangeOpenTypeFeatures`, `getRangeFontWeight`, the `RangeTextDecoration*` family
(`Style`/`SkipInk`/`Offset`/`Thickness`/`Color`), `getStyledTextSegments`,
`insertCharacters(start, chars, useStyle?)`, `deleteCharacters(start, end)`.

### LINE — 107 props (0 unique)

No unique properties — uses shared stroke/fill properties.

### VECTOR — 116 props (4 unique)

| Property / Method | Type | Notes |
|-------------------|------|-------|
| `vectorPaths` | VectorPath[] (read-write) | SVG path data `{windingRule, data}` |
| `vectorNetwork` | VectorNetwork (read-write) | Full bezier network |
| `handleMirroring` | HandleMirroring (read-write) | Handle mirror mode |
| `setVectorNetworkAsync(network)` | method | Async vector-network setter |
| `cornerRadius`, `cornerSmoothing` | number (read-write) | |

### POLYGON — 113 props (1 unique)

| Property | Type | Notes |
|----------|------|-------|
| `pointCount` | number (read-write) | Number of sides (default 3 = triangle) |
| `cornerRadius`, `cornerSmoothing` | number (read-write) | |

### STAR — 114 props (2 unique)

| Property | Type | Notes |
|----------|------|-------|
| `pointCount` | number (read-write) | Number of points |
| `innerRadius` | number (read-write) | Inner radius ratio (0–1) |
| `cornerRadius`, `cornerSmoothing` | number (read-write) | |

### COMPONENT — 185 props (15 unique)

See [Components](#components) for the full method/property list and the property-type table.

### INSTANCE — 184 props (13 unique)

See [Components](#components) for `mainComponent`, `setProperties`, `swapComponent`,
`detachInstance`, overrides, etc.

### SECTION — 73 props (1 unique)

| Property | Type | Notes |
|----------|------|-------|
| `sectionContentsHidden` | boolean (read-write) | Hide section contents |

> SECTION nodes lack most geometry properties; guard before accessing shared geometry
> fields on them.

---

## Paint Types

### SolidPaint
```
{ type: 'SOLID', color: {r, g, b}, opacity?: number, visible?: boolean, blendMode?: BlendMode }
```

### GradientPaint
```
{ type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND',
  gradientTransform: Transform, gradientStops: ColorStop[], opacity?: number }
```
`ColorStop`: `{ position: number (0-1), color: {r, g, b, a} }`

### ImagePaint
```
{ type: 'IMAGE', imageHash: string, scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE',
  imageTransform?: Transform, scalingFactor?: number, rotation?: number, filters?: ImageFilters }
```

### VideoPaint
```
{ type: 'VIDEO', videoHash: string, scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE' }
```

---

## Effect Types

### DropShadow / InnerShadow
```
{ type: 'DROP_SHADOW' | 'INNER_SHADOW', color: {r,g,b,a}, offset: {x, y},
  radius: number, spread?: number, visible?: boolean, blendMode?: BlendMode }
```

### LayerBlur / BackgroundBlur
```
{ type: 'LAYER_BLUR' | 'BACKGROUND_BLUR', radius: number, visible?: boolean }
```

---

## Runtime Verification Summary

Captured 2026-03-22 from the live plugin sandbox.

- **Total `figma.*` keys:** 109 (107 relevant; 2 irrelevant: `devResources`, `relatedLinks`). `getHTMLString` is relevant but untested — it exists, untested, so it counts toward the 107 relevant keys.
- **Prototype property counts:** FrameNode 170 · TextNode 192 (80+ unique) · ComponentNode 185 (15 unique) · InstanceNode 184 (13 unique) · EllipseNode 113 (1: `arcData`) · LineNode 107 (0 unique) · VectorNode 116 (4: `vectorPaths`, `vectorNetwork`, `handleMirroring`, `setVectorNetworkAsync`) · PolygonNode 113 (1: `pointCount`) · StarNode 114 (2: `pointCount`, `innerRadius`) · SectionNode 73 (1: `sectionContentsHidden`).
- **Undocumented APIs confirmed at runtime:** the `SLOT` component-property type — works but absent from Figma's public docs; feature-detect and degrade per [[figma-bridge/docs/principles#T7 — Honest capability|T7]]. `component.createSlot()` / `SlotNode` are **new in 1.130.0** (typed there; absent from the pinned 1.123.0 typings but runtime-available) — feature-detect + cast, or bump the typings.
