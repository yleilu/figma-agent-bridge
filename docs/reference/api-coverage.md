---
title: Figma Plugin API Coverage
created: 2026-06-22T17:00:00+08:00
tags:
  - reference
  - figma-bridge
  - api-coverage
type: reference
related:
  - "[[figma-bridge/docs/reference/figma-plugin-api]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/milestones/README]]"
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
---

# Figma Plugin API Coverage Checklist

> Governed by [[figma-bridge/docs/principles|the principles]].

> **STATUS — M3-era inventory, SUPERSEDED for tool mapping.** This is the M3-era
> API-capability inventory. For the **current tool ↔ capability mapping and milestone
> status** it is SUPERSEDED by [[figma-bridge/docs/specs/tool-surface]] (M4) and
> [[figma-bridge/docs/milestones/README]]. The canonical **raw Figma API capability reference**
> (with property counts) is [[figma-bridge/docs/reference/figma-plugin-api]]. This doc is
> retained for the M3 capability inventory + runtime-introspection findings.

Comprehensive mapping of Figma Plugin API capabilities to our MCP tool surface.
Based on official Figma Plugin API docs at developers.figma.com PLUS runtime introspection (2026-03-22).

Legend: ✅ Covered | 🔧 M3 (must add) | 📌 M5 (modify milestone) | ⏳ Later | ➖ N/A (FigJam/Slides only)

---

## 1. Node Types in `create_tree` / `create_node`

All Figma Design node types that can appear in `get_node` output must be supported in `create_node` for full round-trip.
Total: 18 types for Figma Design + 1 asset pipeline.

| Node Type | Figma API | Status | Notes |
|-----------|-----------|--------|-------|
| FRAME | `figma.createFrame()` | 🔧 M3 | Primary container, auto-layout |
| RECTANGLE | `figma.createRectangle()` | 🔧 M3 | Basic shape, per-corner radius |
| TEXT | `figma.createText()` | 🔧 M3 | Text node, 80+ props |
| ELLIPSE | `figma.createEllipse()` | 🔧 M3 | `arcData: {startingAngle, endingAngle, innerRadius}` for arcs/donuts/pies |
| LINE | `figma.createLine()` | 🔧 M3 | No unique props, trivial |
| POLYGON | `figma.createPolygon()` | 🔧 M3 | Unique: `pointCount` |
| STAR | `figma.createStar()` | 🔧 M3 | Unique: `pointCount`, `innerRadius` |
| VECTOR | `figma.createVector()` | 🔧 M3 | Unique: `vectorPaths`, `vectorNetwork`, `handleMirroring` |
| INSTANCE | `component.createInstance()` | 🔧 M3 | Via `componentKey` + `setProperties()` for overrides. Note: INSTANCE round-trip is currently blocked until `get_node` emits `component.key` (per tool-surface Resolved decision #3) |
| COMPONENT | `figma.createComponentFromNode()` | 🔧 M3 | Via `create_component` tool — supports SLOT, BOOLEAN, TEXT, INSTANCE_SWAP properties |
| COMPONENT_SET | `figma.combineAsVariants()` | 🔧 M3 | Groups components into variant set |
| GROUP | `figma.group(nodes, parent)` | 🔧 M3 | Create children first, then group — transparent to agent in `create_tree` |
| BOOLEAN_OPERATION | `figma.union/subtract/intersect/exclude()` | 🔧 M3 | Create children first, then combine — agent specifies UNION/SUBTRACT/INTERSECT/EXCLUDE |
| SECTION | `figma.createSection()` | 🔧 M3 | Canvas organization, unique: `sectionContentsHidden` |
| SLICE | `figma.createSlice()` | 🔧 M3 | Export regions |
| TEXT_PATH | `figma.createTextPath(node, seg, pos)` | ⏳ | **Deferred / not creatable** (issue #3) — real API but `vectorNodeId`/`startSegment`/`startPosition` were never specced/wired; removed from `CREATABLE_TYPES`, so `create_node`/`create_tree` honest-reject it. See `docs/deferred-capabilities.md` |
| TRANSFORM_GROUP | `figma.transformGroup(nodes, parent, idx, modifiers)` | 🔧 M3 | Transform wrapper for existing nodes |
| SLOT | `component.createSlot(childName)` | 🔧 M3 | **Undocumented** — real node type found via runtime introspection. Created inside components via `create_component` |
| SVG → FrameNode | `figma.createNodeFromSvg(svgString)` | 🔧 M3 | Icons, decorative shapes — `create_from_svg` tool |
| Image Pipeline | `figma.createImage() / createImageAsync()` | 🔧 M3 | Not a node type — produces Image object for ImagePaint fills |
| PAGE | `figma.createPage()` | ⏳ | Page management (structural, not design creation) |
| ➖ FigJam | STICKY, CONNECTOR, SHAPE_WITH_TEXT, CODE_BLOCK, TABLE, TABLE_CELL, STAMP, HIGHLIGHT, WASHI_TAPE, MEDIA, EMBED, LINK_UNFURL | ➖ | FigJam only — not applicable |
| ➖ Slides | SLIDE, SLIDE_ROW, SLIDE_GRID, INTERACTIVE_SLIDE_ELEMENT | ➖ | Slides only — not applicable |
| ➖ Other | WIDGET, DOCUMENT, JSX → Node | ➖ | Not creatable / singleton / alternative path |

---

## 2. Fill / Paint Types

| Paint Type | Status | Notes |
|------------|--------|-------|
| `SOLID` | ✅ | `{r,g,b,a}` — works but needs hex expression support |
| `GRADIENT_LINEAR` | 🔧 M3 | `linear-gradient()` expression already in our spec |
| `GRADIENT_RADIAL` | 🔧 M3 | `radial-gradient()` expression already in our spec |
| `GRADIENT_ANGULAR` | 🔧 M3 | `angular-gradient()` expression already in our spec |
| `GRADIENT_DIAMOND` | 🔧 M3 | `diamond-gradient()` expression already in our spec |
| `IMAGE` | 🔧 M3 | `imageHash` + `scaleMode` — needs image pipeline |
| `VIDEO` | ⏳ | Rare in static designs |
| `PATTERN` (beta) | ⏳ | Beta feature |

---

## 3. Frame / Container Properties

### Auto-Layout Core

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `layoutMode` | `'NONE' \| 'HORIZONTAL' \| 'VERTICAL'` | ✅ | H/V mapping |
| `layoutMode` GRID | `'GRID'` | ⏳ | CSS Grid layout — rare, complex |
| `primaryAxisAlignItems` | `'MIN' \| 'MAX' \| 'CENTER' \| 'SPACE_BETWEEN'` | ✅ | |
| `counterAxisAlignItems` | `'MIN' \| 'MAX' \| 'CENTER' \| 'BASELINE'` | ✅ | |
| `counterAxisAlignContent` | `'AUTO' \| 'SPACE_BETWEEN'` | 🔧 M3 | Wrap track alignment (needed since layoutWrap is M3) |
| `paddingTop/Right/Bottom/Left` | number | ✅ | Via padding array |
| `itemSpacing` | number | ✅ | Via spacing |
| `counterAxisSpacing` | number \| null | 🔧 M3 | Gap between wrapped rows (needed since layoutWrap is M3) |
| `primaryAxisSizingMode` | `'FIXED' \| 'AUTO'` | 🔧 M3 | Primary axis sizing mode |
| `counterAxisSizingMode` | `'FIXED' \| 'AUTO'` | 🔧 M3 | Counter axis sizing mode |
| `layoutWrap` | `'NO_WRAP' \| 'WRAP'` | ✅ | Wrap mode |
| `itemReverseZIndex` | boolean | ⏳ | Reverse z-order |
| `strokesIncludedInLayout` | boolean | ⏳ | Layout calculation |

### Child Sizing & Positioning

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `layoutSizingHorizontal` | `'FIXED' \| 'HUG' \| 'FILL'` | ✅ | |
| `layoutSizingVertical` | `'FIXED' \| 'HUG' \| 'FILL'` | ✅ | |
| `layoutPositioning` | `'AUTO' \| 'ABSOLUTE'` | 🔧 M3 | Badges, overlays, floating elements |
| `layoutAlign` | `'MIN' \| 'CENTER' \| 'MAX' \| 'STRETCH' \| 'INHERIT'` | ⏳ | Individual child override |
| `layoutGrow` | 0 \| 1 | ⏳ | Stretch factor |

### Sizing Constraints

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `width` / `height` | number | ✅ | Via `resize()` |
| `minWidth` | number \| null | 🔧 M3 | Responsive sizing |
| `maxWidth` | number \| null | 🔧 M3 | Responsive sizing |
| `minHeight` | number \| null | 🔧 M3 | Responsive sizing |
| `maxHeight` | number \| null | 🔧 M3 | Responsive sizing |
| `constraints` | `{horizontal, vertical}` | ✅ | Non-auto-layout positioning |

---

## 4. Visual Properties

### Stroke Properties

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `strokeWeight` | number | ✅ | Uniform weight |
| `strokeTopWeight` | number | ⏳ | Per-side stroke weight |
| `strokeBottomWeight` | number | ⏳ | Per-side stroke weight |
| `strokeLeftWeight` | number | ⏳ | Per-side stroke weight |
| `strokeRightWeight` | number | ⏳ | Per-side stroke weight |
| `strokeAlign` | `'CENTER' \| 'INSIDE' \| 'OUTSIDE'` | 🔧 M3 | Common in input fields |
| `strokeCap` | StrokeCap | ⏳ | Line endings |
| `strokeJoin` | StrokeJoin | ⏳ | Corner join style |
| `dashPattern` | number[] | 🔧 M3 | Dashed borders |
| `strokeMiterLimit` | number | ⏳ | Miter limit |
| `variableWidthStrokeProperties` | object | ⏳ | Variable width stroke |
| `complexStrokeProperties` | object | ⏳ | Complex stroke patterns |

### Corner Radius

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `cornerRadius` | number | ✅ | Uniform radius |
| `topLeftRadius` | number | 🔧 M3 | Per-corner radius |
| `topRightRadius` | number | 🔧 M3 | Per-corner radius |
| `bottomLeftRadius` | number | 🔧 M3 | Per-corner radius |
| `bottomRightRadius` | number | 🔧 M3 | Per-corner radius |
| `cornerSmoothing` | number (0-1) | ⏳ | iOS-style smooth corners |

### Blend & Effects

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `opacity` | number (0-1) | ✅ | |
| `blendMode` | BlendMode | ✅ | |
| `effects` | Effect[] | ✅ | shadow, inner-shadow, blur, bg-blur |
| `effectStyleId` | string | 🔧 M3 | Link to effect style |
| `isMask` | boolean | ⏳ | Mask layer |
| `exportSettings` | ExportSettings[] | ⏳ | Export slices/settings |
| `constrainProportions` | boolean | ⏳ | Lock aspect ratio |
| `annotations` | Annotation[] | ⏳ | Node-level annotations |
| `playbackSettings` | object | ⏳ | Video playback settings |
| `maskType` | `'ALPHA' \| 'VECTOR'` | ⏳ | Mask type |
| `visible` | boolean | ✅ | |
| `locked` | boolean | ⏳ | Layer locking |
| `rotation` | number | ✅ | |
| `clipsContent` | boolean | ✅ | |

### Overflow & Scroll

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `overflowDirection` | `'NONE' \| 'HORIZONTAL' \| 'VERTICAL' \| 'BOTH'` | 📌 M5 | Scroll behavior |
| `numberOfFixedChildren` | number | 📌 M5 | Sticky headers/footers |
| `expanded` | boolean | ⏳ | Layer panel expand state |
| `guides` | Guide[] | ⏳ | Frame guides |
| `backgrounds` / `backgroundStyleId` | Paint[] / string | ⏳ | Frame background |
| `devStatus` | DevStatus \| null | ⏳ | Dev mode status |
| `gridRowSpan` / `gridColumnSpan` | number | ⏳ | Grid child span (GRID layout) |
| `gridChildHAlign` / `gridChildVAlign` | string | ⏳ | Grid child alignment (GRID layout) |

---

## 5. Text Properties

| Property | Figma API | Status | Notes |
|----------|-----------|--------|-------|
| `characters` | string | ✅ | Text content |
| `fontName` | `{family, style}` | ✅ | Font family + style |
| `fontSize` | number | ✅ | Size in px |
| `textAlignHorizontal` | `'LEFT' \| 'CENTER' \| 'RIGHT' \| 'JUSTIFIED'` | ✅ | |
| `textAlignVertical` | `'TOP' \| 'CENTER' \| 'BOTTOM'` | ✅ | |
| `lineHeight` | `{value, unit}` | 🔧 M3 | Currently missing — `24px` / `150%` / `auto` |
| `letterSpacing` | `{value, unit}` | 🔧 M3 | Currently missing — `0.5px` / `2%` |
| `textDecoration` | `'NONE' \| 'UNDERLINE' \| 'STRIKETHROUGH'` | 🔧 M3 | In expression-formats spec |
| `textCase` | `'ORIGINAL' \| 'UPPER' \| 'LOWER' \| 'TITLE' \| 'SMALL_CAPS' \| 'SMALL_CAPS_FORCED'` | 🔧 M3 | In expression-formats spec |
| `paragraphSpacing` | number | 🔧 M3 | In expression-formats spec |
| `paragraphIndent` | number | ⏳ | Rare |
| `listSpacing` | number | ⏳ | List items |
| `textAutoResize` | `'NONE' \| 'WIDTH_AND_HEIGHT' \| 'HEIGHT' \| 'TRUNCATE'` | 🔧 M3 | Text box behavior |
| `textTruncation` | `'DISABLED' \| 'ENDING'` | ⏳ | Truncation mode |
| `maxLines` | number \| null | ⏳ | Line limit |
| `hyperlink` | HyperlinkTarget \| null | ⏳ | Link on text |
| `textStyleId` | string | 🔧 M3 | Link to text style |
| `openTypeFeatures` | object | ⏳ | OTF features |
| `leadingTrim` | LeadingTrim | ⏳ | Leading trim |
| `textDecorationStyle` | TextDecorationStyle | ⏳ | Decoration variant |
| `autoRename` | boolean | ⏳ | Auto-rename from content |
| `hangingPunctuation` | boolean | ⏳ | Hanging punctuation |
| `hangingList` | boolean | ⏳ | Hanging list markers |
| `textDecorationSkipInk` | TextDecorationSkipInk | ⏳ | Skip ink on decorations |
| `textDecorationOffset` | TextDecorationOffset | ⏳ | Decoration offset |
| `textDecorationThickness` | TextDecorationThickness | ⏳ | Decoration thickness |
| `textDecorationColor` | TextDecorationColor | ⏳ | Decoration color |
| Range methods (~30) | `getRangeFontName`, `setRangeFontSize`, etc. | ⏳ | Mixed text styling on ranges |
| `insertCharacters` / `deleteCharacters` | text mutation methods | 📌 M5 | Character-level text editing |

---

## 6. Component Properties

| Feature | Figma API | Status | Notes |
|---------|-----------|--------|-------|
| Promote frame to component | `figma.createComponent()` / `createComponentFromNode()` | ✅ | `create_component` tool |
| Component `key` | readonly string | ✅ | Returned by `create_component` |
| Component `description` | string | 📌 M5 | Documentation |
| Component `descriptionMarkdown` | string | ⏳ | Rich text docs |
| Component `documentationLinks` | DocumentationLink[] | 📌 M5 | External docs |
| `addComponentProperty` (BOOLEAN) | `addComponentProperty(name, 'BOOLEAN', default)` | 📌 M5 | Toggle visibility |
| `addComponentProperty` (TEXT) | `addComponentProperty(name, 'TEXT', default)` | 📌 M5 | Text overrides |
| `addComponentProperty` (INSTANCE_SWAP) | `addComponentProperty(name, 'INSTANCE_SWAP', default)` | 📌 M5 | Slot swapping — requires valid component key as default (empty string errors) |
| `addComponentProperty` (SLOT) | `addComponentProperty(name, 'SLOT', '')` | 📌 M5 | **Undocumented** — confirmed working via runtime introspection |
| `createSlot` | `component.createSlot(childName)` | 📌 M5 | **Undocumented** — creates slot from child frame |
| `editComponentProperty` | `editComponentProperty(name, options)` | 📌 M5 | Modify properties |
| `deleteComponentProperty` | `deleteComponentProperty(name)` | 📌 M5 | Remove properties |
| `componentPropertyDefinitions` | readonly object | ✅ M2 | Read via inspect |
| `createInstance()` | on ComponentNode | ✅ | Via INSTANCE in create_tree |
| `combineAsVariants()` | `figma.combineAsVariants(nodes, parent)` | 📌 M5 | Variant grouping |
| `componentPropertyReferences` | on child nodes | 📌 M5 | Wire child to property |
| `scaleFactor` | number (INSTANCE) | 📌 M5 | Instance scale factor |
| `isExposedInstance` | boolean (INSTANCE) | 📌 M5 | Exposed instance flag |
| `mainComponent` setter | ComponentNode (INSTANCE) | 📌 M5 | Change main component |
| `detachInstance()` | method (INSTANCE) | 📌 M5 | Detach instance to frame |
| `resetOverrides()` | method (INSTANCE) | 📌 M5 | Reset all overrides |
| `removeOverrides()` | method (INSTANCE) | 📌 M5 | Remove specific overrides |
| `sectionContentsHidden` | boolean (SECTION) | ⏳ | Hide section contents |

---

## 7. Style System

| Feature | Figma API | Status | Notes |
|---------|-----------|--------|-------|
| Apply paint style | `node.fillStyleId = id` | 🔧 M3 | Via `style(name)#hex` expression |
| Apply text style | `node.textStyleId = id` | 🔧 M3 | Via `style(name)Family/Style/Size` |
| Apply effect style | `node.effectStyleId = id` | 🔧 M3 | Via `style(name)shadow(...)` |
| Apply grid style | `node.gridStyleId = id` | ⏳ | Grid styles |
| Apply stroke style | `node.strokeStyleId = id` | 🔧 M3 | Via `style(name)` expression |
| Create paint style | `figma.createPaintStyle()` | ⏳ | Style authoring |
| Create text style | `figma.createTextStyle()` | ⏳ | Style authoring |
| Create effect style | `figma.createEffectStyle()` | ⏳ | Style authoring |
| Resolve style by name → ID | lookup in local styles | 🔧 M3 | Server-side resolver needed |
| `BaseStyle.remove()` | on any style | ✅ M4 | Via `delete_styles`; T7-gated |

---

## 8. Variable System

| Feature | Figma API | Status | Notes |
|---------|-----------|--------|-------|
| `setBoundVariable(field, variable)` | on any node | ⏳ M4 | Variable binding |
| `boundVariables` | readonly | ✅ M2 | Read via inspect |
| `figma.variables.*` | Variables API | ⏳ M4 | Full variable system |
| `Variable.remove()` | on Variable | ✅ M4 | Via `delete_variables`; T7-gated |
| `VariableCollection.remove()` | on VariableCollection | ✅ M4 | Via `delete_variables`; T7-gated; cascade-removes collection's variables |

---

## 9. Prototyping & Interactions

| Feature | Figma API | Status | Notes |
|---------|-----------|--------|-------|
| `reactions` | Reaction[] | ⏳ | Read reactions |
| `setReactionsAsync()` | set triggers + actions | ⏳ | Create interactions |
| Triggers: ON_CLICK, ON_HOVER, ON_DRAG, etc. | Trigger types | ⏳ | |
| Actions: NAVIGATE, BACK, OPEN_URL, etc. | Action types | ⏳ | |

---

## 10. Image Pipeline

| Feature | Figma API | Status | Notes |
|---------|-----------|--------|-------|
| `figma.createImage(bytes)` | Uint8Array → Image | 🔧 M3 | From raw bytes |
| `figma.createImageAsync(url)` | string → Promise<Image> | 🔧 M3 | From URL |
| `image.hash` | string | 🔧 M3 | For ImagePaint |
| ImagePaint on node fills | `{type:'IMAGE', imageHash, scaleMode}` | 🔧 M3 | Apply to fills array |

---

## 11. Transformation Methods

Methods that operate on existing nodes to create new node types. Used internally by `create_tree` when agent specifies GROUP/BOOLEAN_OPERATION/TRANSFORM_GROUP types.

| Method | Figma API | Status | Notes |
|--------|-----------|--------|-------|
| `figma.group(nodes, parent)` | → GroupNode | 🔧 M3 | Used by `create_tree` when `type: "GROUP"` — creates children first, then groups |
| `figma.union(nodes, parent)` | → BooleanOperationNode | 🔧 M3 | Used by `create_tree` when `type: "BOOLEAN_OPERATION"` with `booleanOperation: "UNION"` |
| `figma.subtract(nodes, parent)` | → BooleanOperationNode | 🔧 M3 | `booleanOperation: "SUBTRACT"` |
| `figma.intersect(nodes, parent)` | → BooleanOperationNode | 🔧 M3 | `booleanOperation: "INTERSECT"` |
| `figma.exclude(nodes, parent)` | → BooleanOperationNode | 🔧 M3 | `booleanOperation: "EXCLUDE"` |
| `figma.transformGroup(nodes, parent, idx, modifiers)` | → TransformGroupNode | 🔧 M3 | Transform wrapper |
| `figma.combineAsVariants(nodes, parent)` | → ComponentSetNode | 🔧 M3 | Used by `create_component` for variant grouping |
| `figma.flatten(nodes)` | → VectorNode | 📌 M5 | Flatten to vectors (destructive) |
| `figma.ungroup(node)` | → SceneNode[] | 📌 M5 | Ungroup (destructive) |

---

## 12. Node Mutation (M5 scope)

| Operation | Figma API | Status | Notes |
|-----------|-----------|--------|-------|
| Move node | `node.x = n; node.y = n` | 📌 M5 | |
| Resize node | `node.resize(w, h)` | 📌 M5 | |
| Reparent node | `parent.appendChild(node)` | 📌 M5 | |
| Delete node | `node.remove()` | 📌 M5 | |
| Clone node | `node.clone()` | 📌 M5 | |
| Reorder children | `parent.insertChild(index, node)` | 📌 M5 | |
| Update fills | `node.fills = [...]` | 📌 M5 | M5 is for post-creation mutation; setting fills at creation time is M3 (via create_node/create_tree) |
| Update strokes | `node.strokes = [...]` | 📌 M5 | |
| Update text | `node.characters = '...'` | 📌 M5 | |
| Swap component | `instance.swapComponent(component)` | 📌 M5 | |

---

## 13. Ordering Constraints

Operations that must happen in a specific order to work correctly in the Figma Plugin API.

| Constraint | Rule |
|------------|------|
| `FILL` sizing on auto-layout child | Must be set AFTER `appendChild` to the auto-layout parent — setting before append has no effect |
| `layoutPositioning: 'ABSOLUTE'` | Must be set AFTER `appendChild` to auto-layout parent |
| `minWidth`/`maxWidth`/`minHeight`/`maxHeight` | Only meaningful when node is inside an auto-layout parent |
| `loadFontAsync()` | Must complete before setting any text property (`characters`, `fontName`, `fontSize`, etc.) |
| `createSlot(childName)` | Requires the child frame to be already appended to the component |
| INSTANCE node sizing (`FILL`) | Instance must be appended to auto-layout parent before `FILL` sizing is applied |
| `textAutoResize` | Should be set before calling `resize()` on TEXT nodes to avoid resize fighting |

---

## 14. Known Expression Format Limitations (must fix for round-trip)

The expression grammar and its round-trip gaps are normative in one place: see
[[figma-bridge/docs/specs/expression-formats]] for the grammar and the round-trip section of
[[figma-bridge/docs/specs/tool-surface]] for round-trip fidelity rules.

---

## 15. Node Metadata (Plugin Data)

| Feature | Figma API | Status | Notes |
|---------|-----------|--------|-------|
| Read private plugin data | `node.getPluginData(key)` / `getPluginDataKeys()` | ✅ | `get_plugin_data` (no namespace) |
| Write private plugin data | `node.setPluginData(key, value)` | ✅ | `set_plugin_data` (no namespace); empty string clears |
| Read shared plugin data | `node.getSharedPluginData(ns, key)` / `getSharedPluginDataKeys(ns)` | ✅ | `get_plugin_data` with `namespace` |
| Write shared plugin data | `node.setSharedPluginData(ns, key, value)` | ✅ | `set_plugin_data` with `namespace`; REST-readable |
| Agent `context` convention | shared `pluginData` `figmabridge/context` | ⏳ | Planned (not yet implemented) — round-trippable `NodeSpec.context`, 2 KB cap; design of record in [[figma-bridge/docs/specs/self-describing-nodes]] |

---

## Summary: M3 Scope

### Core Principle

Round-trip fidelity (`create_node` input = `get_node` output) is normative in the round-trip
section of [[figma-bridge/docs/specs/tool-surface]].

### Tools

| Tool | Purpose |
|------|---------|
| `create_node` | The fundamental tool. Creates ANY single node of all 18 Figma Design types. Accepts same structure as `get_node` output. |
| `create_tree` | Recursive wrapper around `create_node`. Builds nested hierarchies with `children[]` in one call. Handles GROUP/BOOLEAN_OPERATION/TRANSFORM_GROUP transparently. |
| `create_component` | Promotes node to Component via `createComponentFromNode()`. Supports SLOT/BOOLEAN/TEXT/INSTANCE_SWAP properties, `createSlot()`, `combineAsVariants()`. |
| `create_from_svg` | Imports SVG string → Figma nodes via `createNodeFromSvg()`. |

### All 18 node types (full round-trip)

**Directly creatable:**
- [ ] FRAME — `createFrame()` — auto-layout, children
- [ ] RECTANGLE — `createRectangle()` — per-corner radius
- [ ] ELLIPSE — `createEllipse()` — `arcData`
- [ ] TEXT — `createText()` — 80+ text props, mixed text segments
- [ ] LINE — `createLine()` — trivial
- [ ] POLYGON — `createPolygon()` — `pointCount`
- [ ] STAR — `createStar()` — `pointCount`, `innerRadius`
- [ ] VECTOR — `createVector()` — `vectorPaths`, `vectorNetwork`, `handleMirroring`
- [ ] INSTANCE — `createInstance()` — `componentKey` + `setProperties()`
- [ ] SECTION — `createSection()` — `sectionContentsHidden`
- [ ] SLICE — `createSlice()` — export regions
- [~] TEXT_PATH — `createTextPath()` — **deferred / not creatable** (issue #3): honest-rejected, removed from `CREATABLE_TYPES`. See `docs/deferred-capabilities.md`
- [ ] SLOT — `component.createSlot()` — undocumented, via `create_component`

**Via create_component:**
- [ ] COMPONENT — `createComponentFromNode()` — SLOT/BOOLEAN/TEXT/INSTANCE_SWAP properties
- [ ] COMPONENT_SET — `combineAsVariants()` — variant grouping

**Inline in create_tree (create children, then transform):**
- [ ] GROUP — `figma.group(nodes, parent)`
- [ ] BOOLEAN_OPERATION — `figma.union/subtract/intersect/exclude()`
- [ ] TRANSFORM_GROUP — `figma.transformGroup()`

### Expression format fixes needed (for round-trip)

These are `get_node` output gaps that must be fixed so `create_node` receives complete data:
- [ ] Shadow `spread` — add to expression
- [ ] Per-paint `blendMode`/`visible` — extend format
- [ ] Gradient `gradientTransform` for non-linear — include transform data
- [ ] ImagePaint — return `imageHash`, `scaleMode` minimum
- [ ] Mixed text styling — return `styledTextSegments`
- [ ] `dashPattern` — support full `number[]`

### Ordering constraints (see Section 13)

- `FILL` sizing and `layoutPositioning: 'ABSOLUTE'` must be set AFTER `appendChild`
- `loadFontAsync()` must complete before setting any text property
- GROUP/BOOLEAN: create children first, then transform

---

## Runtime Introspection Findings

Verified by inspecting the live `figma` global object in the Figma plugin sandbox (2026-03-22).

### API surface coverage

- **`figma.*` methods:** 109 total keys, 107 documented in this checklist (98%)
- **Not in checklist (irrelevant to M3):** `devResources`, `relatedLinks`

### Node property counts (prototype chain)

| Node Type | Total Props | Unique Props (not on FrameNode) |
|-----------|-------------|--------------------------------|
| FRAME | 170 | — (baseline) |
| RECTANGLE | 120 | none |
| ELLIPSE | 113 | `arcData` |
| TEXT | 192 | 80+ text-specific (characters, font*, range*, textAlign*, etc.) |
| LINE | 107 | none |
| VECTOR | 116 | `vectorPaths`, `vectorNetwork`, `handleMirroring`, `setVectorNetworkAsync` |
| POLYGON | 113 | `pointCount` |
| STAR | 114 | `pointCount`, `innerRadius` |
| COMPONENT | 185 | `addComponentProperty`, `createSlot`, `deleteComponentProperty`, `editComponentProperty`, `componentPropertyDefinitions`, `createInstance`, `description`, `descriptionMarkdown`, `documentationLinks`, `getInstancesAsync`, `getPublishStatusAsync`, `instances`, `key`, `remote`, `variantProperties` |
| INSTANCE | 184 | `componentProperties`, `detachInstance`, `exposedInstances`, `getMainComponentAsync`, `isExposedInstance`, `mainComponent`, `overrides`, `removeOverrides`, `resetOverrides`, `scaleFactor`, `setProperties`, `swapComponent`, `variantProperties` |
| SECTION | 73 | `sectionContentsHidden` |

### Undocumented APIs confirmed working

| API | Type | Verified |
|-----|------|----------|
| `component.createSlot(childName)` | method | ✅ Creates slot from child frame |
| `addComponentProperty(name, 'SLOT', '')` | property type | ✅ Returns `name#id`, creates SLOT type property |
| `figma.getHTMLString()` | method | exists but untested |

### Component property types (verified)

| Type | `addComponentProperty` | Notes |
|------|----------------------|-------|
| `BOOLEAN` | ✅ works | `addComponentProperty('name', 'BOOLEAN', true)` |
| `TEXT` | ✅ works | `addComponentProperty('name', 'TEXT', 'default')` |
| `INSTANCE_SWAP` | ❌ needs valid default | Errors with empty string default — needs a valid component key |
| `VARIANT` | ❌ ComponentSet only | "Can only add variant property to a component set" |
| `SLOT` | ✅ works (undocumented) | `addComponentProperty('name', 'SLOT', '')` |
