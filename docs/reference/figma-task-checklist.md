---
title: Figma Task Checklist (user/agent intents × Plugin-API feasibility)
created: 2026-06-23T15:30:00+08:00
tags:
  - reference
  - figma-bridge
  - task-checklist
  - api-design
type: reference
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/reference/figma-professional-practice]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/reference/figma-plugin-api]]"
---

# Figma Task Checklist

> Governed by [[figma-bridge/docs/principles|the principles]]. The requirements input for the
> tool-surface design: what a user/agent tries to do, the **noob** vs **pro** way of doing it
> (per [[figma-bridge/docs/reference/figma-professional-practice|professional practice]]), and
> how it maps to the **Figma Plugin API** (T7 honesty). Every task here is achievable — if the
> Plugin API can't do it, the bridge can't, so it is excluded.
>
> Coverage-tested by composing real end-to-end jobs (dashboard with a design system, a
> publishable component library, audit-and-normalize): the core is composable; the higher-order
> orchestration (planning, audit deltas, reports) is correctly the **skill** layer's job (P1).

## How to read it

- ✅ **full** — a real `figma.*` API does it → **tool layer**. (Name→id / alias resolution layered on top is still ✅.)
- 🟡 **partial** — the API exposes the *data* but the agent/skill computes the verdict (audits, contrast, layout inference, orchestration) → **skill layer** (P1).
- 🟠 **fallback** — only via an undocumented / feature-detected / awkward path → expose gated + degrade.

## Summary

**89 tasks**: 65 ✅ full · 21 🟡 partial · 3 🟠 fallback. (Counts + the lists below are derived from the per-task badges.) The honest tool surface ≈ the ✅ set + one generic `batch` (many ✅ tasks are N-call loops); the 🟡 set is skill-layer reasoning over read tools.

## 🟠 Fallback-only — expose gated / feature-detected
- Find all nodes using a given style or variable (reverse lookup) — `no index API; full-doc findAll checking node.fillStyleId/effectStyleId/textStyleId or node.boundVariables == id` *(_needs-agent-logic (no reverse-consumer query; brute-force scan)_)*
- Give a component an open slot for arbitrary content — `component.createSlot(childName); addComponentProperty(..., SLOT)` *(_feature-detect_)*
- Expose a nested component's property on the parent — `instance.isExposedInstance / instance.exposedInstances (state only; no clean forward-property call)` *(_needs-agent-logic_)*

## 🟡 Skill-layer (partial) — API gives data, the skill computes (P1)
- See everything about a node (human view) — needs-agent-logic (shape/compact YAML + bound-vs-literal)
- Read a node's exact values to modify and write back — needs-agent-logic (expression grammar round-trip; figma.mixed for ranges)
- Understand a big frame without blowing context — needs-agent-logic (no native depth cap; agent walks levels & paginates)
- Map the layout rules of a screen (how it flows) — needs-agent-logic (assemble per-child sizing narrative)
- Find nodes by name (e.g. all 'Avatar') — needs-agent-logic (regex/match-mode in callback)
- Find hard-coded values that should be tokens — needs-agent-logic (enumerate fields, judge unbound)
- Find off-system / off-palette colors — needs-agent-logic (aggregate distinct + match against tokens)
- Find detached instances (drift from the system) — needs-agent-logic (no first-class detached-mimic flag; heuristic)
- Audit absolute-positioning anti-pattern — needs-agent-logic (judge anti-pattern)
- Check text/background contrast for accessibility — needs-agent-logic (compute WCAG contrast ratio; pair fg/bg)
- Spot variant explosion in a component set — needs-agent-logic (count permutations, flag blowup)
- Group several nodes into an auto-layout container — needs-agent-logic to infer gap/padding/sizing from positions
- Convert an absolutely-positioned layout to auto-layout — needs-agent-logic to infer gap/padding/order
- Promote a repeated pattern into a component and swap duplicates — needs-agent-logic
- Migrate all instances of ComponentA to ComponentB — needs-agent-logic
- Switch a variant while keeping text/color overrides — needs-agent-logic
- Copy one instance's overrides onto many siblings — needs-agent-logic
- Stand up a 3-tier token architecture (primitive->semantic) — agent orchestrates tiers/aliases; hide-primitives is a real property
- Plan tokens for code export (DTCG / Tokens Studio) — agent maps names / emits DTCG; instance member — verify in-sandbox
- Extract repeated ad-hoc literals into tokens and re-bind in bulk — needs-agent-logic
- Hand off CSS/specs + token names that match auto-layout — agent maps CSS to token names

## The checklist

### 1. Read & Inspect a Node

- ✅ **See what is currently selected on the canvas** — `figma.currentPage.selection (id/name/type per node)`
  - noob: ask user to describe / export a picture · pro: get_selection returning ids + names + types · need: get_selection: compact ids/names/types
- ✅ **Read what the user is currently looking at (page + selection + context)** — `figma.currentPage + figma.currentPage.selection + figma.viewport`
  - noob: ask the user to explain the screen · pro: read_my_design / inspect of current page + selection in one call · need: current-page + selection context read
- 🟡 **See everything about a node (human view)** — `getNodeByIdAsync + node props + boundVariables + fillStyleId/effectStyleId` *(_needs-agent-logic (shape/compact YAML + bound-vs-literal)_)*
  - noob: dump full node JSON with every property · pro: compact inspect of key props + token-bound vs literal · need: inspect (human YAML), compact, binding-aware
- 🟡 **Read a node's exact values to modify and write back** — `getNodeByIdAsync + full node property reads; boundVariables/styleId for bindings` *(_needs-agent-logic (expression grammar round-trip; figma.mixed for ranges)_)*
  - noob: screenshot it, eyeball values, retype literals · pro: get_node in lossless edit format, round-trip the expression grammar · need: get_node edit format, round-trip fidelity, single expression grammar
- ✅ **Read many nodes at once efficiently** — `getNodeByIdAsync per id (batch in agent); findAll for subtree` *(_async (per-id lookups)_)*
  - noob: loop one get_node per id · pro: get_nodes batch read in view format · need: get_nodes: id-list primitive, compact output
- ✅ **Visually confirm what a node looks like** — `node.exportAsync({format,constraint scale})` *(_async_)*
  - noob: describe from properties, guess appearance · pro: export_node_as_image at low scale for a quick visual check · need: export as render-to-see read path, scale-controlled
- ✅ **Read/write agent metadata on a node** — `node.setPluginData/getPluginData + setSharedPluginData/getSharedPluginData` *(_shared needs a namespace_)*
  - noob: track state in its own memory only · pro: persist markers on the node via plugin data · need: get/set plugin data + shared namespaced plugin data

### 2. Navigate Document, Pages & Selection

- ✅ **Get high-level document info** — `figma.root.name + figma.root.children + figma.currentPage.selection`
  - noob: read root node fully · pro: get_document_info: name, pages, current selection summary · need: get_document_info cheap orientation read
- ✅ **List all pages in the document** — `figma.root.children (id/name) + compare to figma.currentPage.id`
  - noob: ask user which pages exist · pro: list_pages returning names + ids + current-page marker · need: list_pages with current-page marker
- ✅ **Get an overview of a whole page (top-level frames)** — `page.children (top-level only) or page.findChildren(); other pages via figma.root.children[n].children` *(_async (may need loadAllPagesAsync for non-current page deep reads)_)*
  - noob: read every node on the page · pro: list page frames, then drill selectively · need: get_page_frames / top-level-only listing; get_page_nodes by page id (no switch)
- ✅ **Focus/scroll canvas to a node and/or set selection** — `figma.viewport.scrollAndZoomIntoView([node]) + figma.currentPage.selection = [...]`
  - noob: describe location in words · pro: set_focus / set_selection to drive viewport + selection · need: set_focus + set_selection navigation
- ✅ **Switch to / create another page** — `figma.currentPage = page (settable) + figma.createPage()`
  - noob: ask user to click the page tab · pro: set_current_page by id/name; create_page · need: set_current_page, create_page
- ✅ **Connect to the Figma session / confirm a live channel** — `connect / status (MCP session)` *(_the prerequisite for every read/write_)*
  - noob: start issuing commands blind · pro: connect + status to confirm a paired live session first · need: connect/join-channel + status handshake
- ✅ **Duplicate a page (backup or variant)** — `page.clone()`
  - noob: edit destructively in place · pro: clone the page as a backup before bulk edits · need: duplicate a page tree

### 3. Comprehend Large / Deep Trees

- 🟡 **Understand a big frame without blowing context** — `node.children / findChildren(cb) with custom predicate` *(_needs-agent-logic (no native depth cap; agent walks levels & paginates)_)*
  - noob: get full subtree JSON, overflow context · pro: shallow-first view: top levels/types/names, drill on demand · need: depth-limited / progressive inspect, per-call breadth control
- 🟡 **Map the layout rules of a screen (how it flows)** — `frame.layoutMode/primaryAxis*/counterAxis*/padding*/itemSpacing + child layoutAlign/layoutGrow/layoutSizing*` *(_needs-agent-logic (assemble per-child sizing narrative)_)*
  - noob: infer flow from x/y of children · pro: read layoutMode, sizing (hug/fill/fixed), padding, gap, align per frame · need: inspect_page_layout: auto-layout props + per-child sizing + alignment in one read

### 4. Find / Search Nodes

- ✅ **Find all text nodes / inventory copy in a screen** — `node.findAll(n => n.type==='TEXT') -> id + characters` *(_async (loadFontAsync not needed for read)_)*
  - noob: walk the whole tree manually filtering by type · pro: scoped scan_text_nodes returning id + characters compactly · need: scan_text_nodes: strings + ids, scoped, no full payloads
- 🟡 **Find nodes by name (e.g. all 'Avatar')** — `node.findAll(cb) / findChildren(cb) with agent-supplied name/regex predicate` *(_needs-agent-logic (regex/match-mode in callback)_)*
  - noob: fetch tree, grep names client-side · pro: search by name/regex scoped to a subtree, ids only · need: search/find_children by name with scope + match mode
- ✅ **Find nodes of several types in one pass** — `node.findAll(n => typeSet.has(n.type))`
  - noob: multiple full-tree passes per type · pro: scan_nodes_by_types with a type set, scoped · need: type-set finder, scoped, batched
- ✅ **Find every instance of a given component** — `component.getInstancesAsync() (or instance.mainComponent match in findAll)` *(_async_)*
  - noob: scan all INSTANCE nodes then compare names · pro: search by mainComponent id / component key · need: query instances by mainComponent id / component key
- 🟠 **Find all nodes using a given style or variable (reverse lookup)** — `no index API; full-doc findAll checking node.fillStyleId/effectStyleId/textStyleId or node.boundVariables == id` *(_needs-agent-logic (no reverse-consumer query; brute-force scan)_)*
  - noob: read every node and compare ids by hand · pro: query consumers of a styleId / variableId · need: reverse lookup: nodes bound to a given style/variable id

### 5. Read the Design System (Components, Styles, Tokens)

- ✅ **Discover existing components before building** — `figma.getLocalComponentsAsync / findAll COMPONENT/COMPONENT_SET + componentPropertyDefinitions` *(_async_)*
  - noob: build fresh shapes, ignore the library · pro: get_local_components to reuse instead of redraw · need: get_local_components: components/sets with keys, names, variant props
- ✅ **See all local paint/text/effect styles** — `figma.getLocalPaintStylesAsync / getLocalTextStylesAsync / getLocalEffectStylesAsync / getLocalGridStylesAsync` *(_async_)*
  - noob: read a styled node and reverse-engineer the style · pro: get_local_styles listing styles by category with ids + resolved values · need: get_local_styles: id + type filter, resolved expression values
- ✅ **See all variable collections, modes, and tokens** — `figma.variables.getLocalVariableCollectionsAsync + getLocalVariablesAsync; collection.modes; variable.valuesByMode` *(_async (alias chains resolved via getVariableByIdAsync)_)*
  - noob: guess token names from hardcoded values · pro: enumerate collections, modes, variables with tiers/aliases · need: get_local_variables: collection-grouped, mode-resolved, alias chains, scopes
- ✅ **Understand a component's variant axes and property types** — `component.componentPropertyDefinitions (VARIANT/BOOLEAN/TEXT/INSTANCE_SWAP + defaultValue + preferredValues) + variantProperties`
  - noob: open each variant and diff them visually · pro: get_component_properties: variant/boolean/text/instance-swap + defaults · need: read all 4 property types + defaults + preferred values
- ✅ **Map token tier architecture (primitive->semantic->component)** — `variable.valuesByMode (VariableAlias{id}) + getVariableByIdAsync to follow chain + variableCollectionId for source` *(_async + needs-agent-logic (walk alias chain)_)*
  - noob: treat all variables as flat names · pro: follow alias chains across collections to see tiering · need: variable read exposing alias resolution + source collection
- ✅ **Know which fonts are available before editing text** — `figma.listAvailableFontsAsync()` *(_async_)*
  - noob: set a font name and hope it loads · pro: list_fonts to validate before binding · need: list_fonts: loadable families/styles

### 6. Check Binding (Token vs Literal) & Overrides

- ✅ **Check if a value is token-bound or a hardcoded literal** — `node.boundVariables + node.fillStyleId/effectStyleId/textStyleId alongside resolved fills/effects`
  - noob: read the resolved value, assume it's fine · pro: inspect bound-vs-hardcoded, report token name + tier · need: reads report boundVariables + styleId alongside resolved value
- ✅ **Check what a padding/gap/radius/stroke number is bound to** — `node.boundVariables (keys for paddingLeft, itemSpacing, topLeftRadius, strokeWeight, etc.)`
  - noob: read the px number only · pro: see if layout numbers bind to a spacing-scale variable · need: reads surface boundVariables for layout numbers, not just color
- ✅ **See current overrides on an instance** — `instance.overrides + instance.componentProperties`
  - noob: compare instance against main component manually · pro: get_instance_overrides + current component-property values · need: read instance overrides + component-property values
- ✅ **Resolve a variable's value in a specific mode** — `variable.valuesByMode[modeId] + getVariableByIdAsync to resolve aliases` *(_async + needs-agent-logic (alias resolution)_)*
  - noob: read whatever value the current frame shows · pro: query a variable's per-mode values + resolved alias · need: variable values across modes with alias resolution

### 7. Audit / QA

- 🟡 **Find hard-coded values that should be tokens** — `findAll + node.boundVariables / styleId checks per fill/number field` *(_needs-agent-logic (enumerate fields, judge unbound)_)*
  - noob: spot-check a few nodes visually · pro: scan subtree for fills/numbers with no variable/style binding · need: audit read enumerating unbound (literal) color/spacing values
- 🟡 **Find off-system / off-palette colors** — `findAll fills + figma.getSelectionColors; cross-ref against getLocalVariablesAsync palette` *(_needs-agent-logic (aggregate distinct + match against tokens)_)*
  - noob: trust the colors look on-brand · pro: list distinct fill values, flag ones not matching any token · need: aggregate distinct colors + cross-ref against variable palette
- 🟡 **Find detached instances (drift from the system)** — `node.type==='INSTANCE' vs FRAME look-alikes; node.detachedInfo when present` *(_needs-agent-logic (no first-class detached-mimic flag; heuristic)_)*
  - noob: eyeball which cards look slightly different · pro: scan for frames that mimic components but aren't instances · need: reads distinguishing INSTANCE vs detached look-alike
- 🟡 **Audit absolute-positioning anti-pattern** — `node.layoutPositioning (AUTO/ABSOLUTE) + parent.layoutMode` *(_needs-agent-logic (judge anti-pattern)_)*
  - noob: doesn't notice everything is x/y pinned · pro: detect auto-layout children with manual x/y or non-auto containers · need: reads expose layoutPositioning (AUTO vs ABSOLUTE) + parent layoutMode
- 🟡 **Check text/background contrast for accessibility** — `resolved fills on text + background node fills (read raw RGB); figma.getSelectionColors aids` *(_needs-agent-logic (compute WCAG contrast ratio; pair fg/bg)_)*
  - noob: assume contrast is fine · pro: read resolved fg + bg colors, compute contrast ratio · need: reads yield pairable resolved foreground/background colors
- 🟡 **Spot variant explosion in a component set** — `componentSet.componentPropertyDefinitions (VARIANT options) / children count` *(_needs-agent-logic (count permutations, flag blowup)_)*
  - noob: doesn't count permutations · pro: read variant axes, flag size×type×state blowup · need: component reads surface variant-permutation counts

### 8. Create & Build Nodes

- ✅ **Add a new node inside an existing frame** — `figma.createFrame()/createRectangle()/createText() etc. + parent.insertChild(index, node) / appendChild(node)` *(_auto-layout reflows automatically on append_)*
  - noob: create at canvas coords then drag into frame · pro: create_node with parentId + index, appended into auto-layout flow · need: create_node accepts parentId + index, respects parent layoutMode
- ✅ **Build a content section / form with stacked children evenly spaced** — `createFrame + frame.layoutMode='VERTICAL' + itemSpacing + paddingTop/Right/Bottom/Left + counterAxisSizingMode/primaryAxisSizingMode='AUTO'; gap bindable via setBoundVariable('itemSpacing', var)` *(_multiple property sets, not one API call_)*
  - noob: absolutely place nodes with manual y-gaps · pro: vertical auto-layout frame, gap from spacing token, hug height · need: set layoutMode + itemSpacing + padding in one call; gap bindable
- ✅ **Build a full screen or nested section tree in one shot** — `per-node create* + appendChild + per-frame layoutMode/sizing + layoutSizingHorizontal='FILL'` *(_N calls + ordering: set FILL after appendChild_)*
  - noob: one big frame, child frames pinned at absolute x/y/w/h · pro: nested auto-layout tree, fill-width sections, fixed header/footer hug · need: create_tree: nested auto-layout in one call, per-section layoutMode + sizing
- ✅ **Build a button that hugs its label with padding** — `createFrame + layoutMode + counterAxisSizingMode='AUTO'/layoutSizingHorizontal='HUG' + paddingLeft/Right/Top/Bottom + primaryAxisAlignItems/counterAxisAlignItems='CENTER'`
  - noob: fixed-width rect + centered text overlay at absolute coords · pro: auto-layout frame, width=Hug, per-side padding, centered align · need: layoutMode + padding + axis-align in one call; Hug default
- ✅ **Build a card (image, title, price, button)** — `createFrame tree + ImagePaint (createImageAsync) + setBoundVariable for fills/cornerRadius/padding (or literal fills/cornerRadius)` *(_image fill is async; token binding optional_)*
  - noob: frame with each element pinned, hard-coded colors/sizes · pro: auto-layout card, fill-width children, token fills/radius/padding · need: auto-layout tree + variable-bound fills/radius/padding
- ✅ **Build a list/grid of N rows or cards** — `createFrame + layoutWrap='WRAP' + itemSpacing + counterAxisSpacing + node.clone()/createInstance per item; grid via gridRowCount/gridColumnCount/appendChildAt` *(_per-item loop, no batch clone API_)*
  - noob: copy-paste a row N times, bump each y · pro: auto-layout list/grid (wrap), gap tokens, Fill/Fixed children · need: batch instance/clone into auto-layout; wrap layoutMode + per-axis gap
- ✅ **Add a vector icon** — `figma.createNodeFromSvg` *(_or instance-swap for an icon slot_)*
  - noob: draw rects/lines approximating the glyph · pro: import SVG as vector, place as instance-swap slot · need: create_from_svg; instance-swap for icon slot
- ✅ **Add a floating badge/overlay over a card corner** — `node.layoutPositioning='ABSOLUTE' + node.constraints` *(_set layoutPositioning AFTER appendChild_)*
  - noob: absolute child in auto-layout parent so it shifts flow · pro: child set ABSOLUTE with constraints, ignores layout · need: per-child ABSOLUTE opt-out + constraints

### 9. Edit, Restyle & Bulk-Edit Existing Nodes

- ✅ **Change a single label's text** — `figma.loadFontAsync(node.fontName) then node.characters='...'; textAutoResize='WIDTH_AND_HEIGHT' for hug` *(_loadFontAsync must resolve first_)*
  - noob: retype string, then resize the box to fit · pro: set_text_content; box hugs via auto-layout · need: set_text_content (loadFont first); Hug so no manual resize
- ✅ **Update many labels across a screen** — `node.findAll(n=>n.type==='TEXT') then per-node loadFontAsync + characters=` *(_no batch text API; per-node loop_)*
  - noob: edit each text node individually · pro: scan_text_nodes then set_multiple_text_contents (id-keyed map) · need: scoped scan + batch text set
- ✅ **Change a node's fill to a semantic color token** — `figma.variables.getLocalVariablesAsync (resolve by name) + node.setBoundVariable('fills'/paint, variable) / setBoundVariableForPaint; literal via node.fills` *(_name->id resolution is agent logic; async_)*
  - noob: set a hard-coded hex literal · pro: bind fill to a semantic color variable by name · need: set_fills / bind_variable; var(name) binding, literal as exception
- ✅ **Set stroke/border and corner radius (token-bound)** — `node.strokes + strokeWeight + strokeAlign; cornerRadius/topLeftRadius...; setBoundVariable for strokeWeight/cornerRadius + setBoundVariableForPaint for stroke color`
  - noob: hard-coded stroke color/weight + literal radius · pro: stroke color + weight + radius bound to Number/color tokens · need: set_strokes + set_corner_radius, variable-bindable
- ✅ **Apply a shared effect (shadow/blur) to many nodes** — `node.setEffectStyleIdAsync(id) (or effectStyleId=id) per node; resolve via getLocalEffectStylesAsync` *(_per-node loop; async setter_)*
  - noob: set the same effect literals per node · pro: apply a named effect style by id across nodes · need: set_effects / apply_style by effectStyleId, batched
- ✅ **Make an element fill width / resize an icon** — `node.layoutSizingHorizontal/Vertical='FILL'|'HUG'|'FIXED' + minWidth/maxWidth/minHeight/maxHeight; node.resize(w,h)` *(_set FILL after appendChild to AL parent_)*
  - noob: set explicit width to parent inner width; drag handles · pro: set_layout_sizing per axis; resize_node or size bound to token · need: set_layout_sizing HUG|FILL|FIXED + min/max; resize_node
- ✅ **Make a layout adapt to a wider screen** — `layoutSizing FILL + min/maxWidth/Height + layoutWrap (parent resize cascades)` *(_agent picks the responsive values_)*
  - noob: manually widen every frame and child · pro: Fill children + min/max clamps + wrap; one parent resize cascades · need: per-axis sizing with min/max; parent resize re-solves children
- ✅ **Recolor / re-space everything to a new brand** — `variable.setValueForMode(modeId,value) (one edit cascades to all consumers); or per-node setBoundVariable re-bind loop` *(_single-token edit is clean; bulk re-bind is N calls_)*
  - noob: set hex/px on each node across the page · pro: change the semantic token value once, or batch re-bind to token · need: update_variables value per mode; bulk re-bind read+write
- ✅ **Clean up / delete many stray nodes** — `node.findAll(by type) then node.remove() per node` *(_no batch delete API; per-node loop_)*
  - noob: select and delete one at a time · pro: scan by type then delete_multiple_nodes · need: scan_nodes_by_types + delete batch
- ✅ **Set basic node properties (name, lock, visible, opacity, blend, rotation)** — `node.name / locked / visible / opacity / blendMode / rotation`
  - noob: fake them (lighter hex, delete to hide, redraw rotated) or leave 'Frame 42' · pro: set the real properties; name semantically; opacity/blend token-bindable · need: set name/locked/visible/opacity/blendMode/rotation
- ✅ **Fill a node with an image (URL or bytes)** — `figma.createImageAsync(url) / createImage(bytes) -> ImagePaint` *(_async; URL needs network_)*
  - noob: place a colored rect as placeholder · pro: create an Image and set an ImagePaint · need: image fill from url/bytes

### 10. Restructure (Reparent, Reorder, Group, Convert)

- ✅ **Move a node into a different frame** — `parent.insertChild(index, node) / appendChild(node)` *(_auto-layout parent re-flows automatically_)*
  - noob: cut and paste, re-set absolute coords · pro: reparent_node into target's auto-layout at an index · need: reparent_node(parentId,index); re-flows under new parent
- ✅ **Reorder children of a stack** — `parent.insertChild(index, node)` *(_x/y on auto-layout child no-ops_)*
  - noob: drag layers / re-nudge positions · pro: reorder_children by index · need: reorder_children with explicit ordering; x/y on AL child no-ops + warns
- 🟡 **Group several nodes into an auto-layout container** — `figma.group(nodes,parent) or createFrame+appendChild, then frame.layoutMode='VERTICAL'/'HORIZONTAL'` *(_needs-agent-logic to infer gap/padding/sizing from positions_)*
  - noob: plain group, keeps absolute positions · pro: wrap in auto-layout frame so they flow with rules · need: wrap-in-auto-layout op preserving children + applying layoutMode
- 🟡 **Convert an absolutely-positioned layout to auto-layout** — `frame.layoutMode='VERTICAL'/'HORIZONTAL' (adopts existing children) + itemSpacing/padding*/layoutSizing* follow-ups computed from child x/y/width/height` *(_needs-agent-logic to infer gap/padding/order_)*
  - noob: leave as-is; keep nudging on every change · pro: set parent layoutMode, infer gap/padding from positions, set child sizing · need: set_layout_mode that adopts existing children; sizing+padding+gap follow-ups
- ✅ **Duplicate a card/element to make several similar ones** — `node.clone() + insertChild; or component.createInstance() + instance.setProperties() (override without detach)` *(_per-copy loop; no count param in API_)*
  - noob: copy-paste, then hand-edit each copy · pro: clone (or instance) into auto-layout, override only what differs · need: clone_node with parent/index + count; instance overrides without detach
- ✅ **Combine shapes with a boolean op** — `figma.union/subtract/intersect/exclude`
  - noob: erase/overlap by hand · pro: union/subtract/intersect/exclude into a boolean node · need: boolean op on existing nodes
- ✅ **Flatten a selection to a single vector** — `figma.flatten(nodes, parent?)`
  - noob: leave overlapping shapes · pro: flatten to one vector (icon prep) · need: flatten nodes

### 11. Componentize & Use Instances

- ✅ **Turn a designed frame into a reusable component** — `figma.createComponentFromNode(node); component.name; component.description/descriptionMarkdown`
  - noob: leave it as a frame, copy-paste it everywhere · pro: create_component, slash-named (Button/Primary), single source of truth · need: create_component from node: name + description
- 🟡 **Promote a repeated pattern into a component and swap duplicates** — `figma.createComponentFromNode + node.findAll (find similar) + instance.swapComponent` *(_needs-agent-logic_)*
  - noob: keep duplicating the raw shapes · pro: componentize once, swap_component duplicates to instances · need: create_component + find similar + swap_component to instances
- ✅ **Make states (default/hover/pressed/disabled) one component** — `figma.combineAsVariants(nodes, parent); slash-named State property` *(_needs-agent-logic_)*
  - noob: draw separate frames side by side · pro: combine_variants with a single State property axis · need: combine_variants in one call; derive variant prop from node names
- ✅ **Encode orthogonal axes (Type, Size, State) as separate properties** — `figma.combineAsVariants with multi-key 'Type=,Size=,State=' names; component.variantProperties` *(_needs-agent-logic_)*
  - noob: one combined value like PrimaryLargeHover · pro: three independent named variant properties that mix-and-match · need: define multiple named variant props; warn on combined-axis naming
- ✅ **Add boolean / text / instance-swap component properties** — `component.addComponentProperty(name, BOOLEAN|TEXT|INSTANCE_SWAP, default); editComponentProperty; deleteComponentProperty`
  - noob: separate variant per icon; tell consumer to detach + retype · pro: boolean->layer visible, text->characters, instance-swap with preferred set · need: update_component: add property types with defaults + preferred values
- ✅ **Place a configured instance without breaking inheritance** — `component.createInstance(); instance.setProperties(props); importComponentByKeyAsync(key)` *(_async_)*
  - noob: copy-paste a styled frame, or detach then hand-edit · pro: create_component_instance then set_instance_properties (all 4 types) · need: create instance by key/id; set_instance_properties one call, never auto-detach
- 🟡 **Migrate all instances of ComponentA to ComponentB** — `component.getInstancesAsync() + instance.swapComponent(component) per instance` *(_needs-agent-logic_)*
  - noob: delete and redraw each instance · pro: swap_component across page preserving compatible overrides · need: swap_component (remote-capable), batch, report mismatches
- 🟡 **Switch a variant while keeping text/color overrides** — `instance.setProperties({variantProp}); instance.overrides (read) to verify survival` *(_needs-agent-logic_)*
  - noob: rebuild the instance from the new variant · pro: change variant property; compatible overrides survive · need: variant switch that preserves + reports surviving overrides
- 🟡 **Copy one instance's overrides onto many siblings** — `instance.overrides (read-only) + replay via instance.setProperties / swapComponent on targets` *(_needs-agent-logic_)*
  - noob: re-type the same overrides on each · pro: get_instance_overrides then set on multiple targets atomically · need: extract overrides from source, apply to many targets
- 🟠 **Give a component an open slot for arbitrary content** — `component.createSlot(childName); addComponentProperty(..., SLOT)` *(_feature-detect_)*
  - noob: leave an empty frame, hope consumers fill it · pro: make_slot with min/max + restrictions, graceful fallback · need: make_slot lifecycle; add component properties BEFORE slots; degrade if API absent
- 🟠 **Expose a nested component's property on the parent** — `instance.isExposedInstance / instance.exposedInstances (state only; no clean forward-property call)` *(_needs-agent-logic_)*
  - noob: consumer drills into nested instance to configure · pro: expose/forward nested property to the parent instance · need: expose nested instance properties to parent
- ✅ **Detach a single instance deliberately** — `instance.detachInstance(); instance.resetOverrides()/removeOverrides()`
  - noob: detach everything to be safe · pro: detach_instance only that one, as last resort · need: detach_instance / reset_instance as explicit opt-out, warn
- ✅ **Set/edit a component (or set) description** — `component.description / descriptionMarkdown`
  - noob: leave it blank · pro: write a description so the asset-panel catalog documents usage · need: set description on an existing component(-set)

### 12. Tokens, Variables & Styles Authoring

- ✅ **Bind a fill / padding / gap / radius to a token** — `node.setBoundVariable(field, variable) for scalar layout numbers; figma.variables.setBoundVariableForPaint for color` *(_feature-detect_)*
  - noob: set raw hex or px · pro: bind to semantic color or Number variable by name · need: bind_variable: paint path for color, scalar path for layout numbers
- 🟡 **Stand up a 3-tier token architecture (primitive->semantic)** — `createVariableCollection + createVariableAlias + variable.hiddenFromPublishing` *(_agent orchestrates tiers/aliases; hide-primitives is a real property_)*
  - noob: one flat list of named colors, or hex literals · pro: separate collections; semantic aliases primitive; hide primitives · need: create_variables: collections + variables + aliasing; per-collection publish/hide scope
- ✅ **Add light/dark (and density/brand) modes** — `collection.addMode(name) + variable.setValueForMode(modeId,value) + node.setExplicitVariableModeForCollection` *(_async; instance member_)*
  - noob: duplicate the whole file per mode · pro: parallel mode value sets on the same token names; set frame mode · need: create modes; set per-mode values atomically; frame mode binding
- ✅ **Build a spacing/number scale with scopes** — `createVariable(...,FLOAT) + variable.scopes=[GAP,CORNER_RADIUS,...]` *(_scopes is a real read-write property_)*
  - noob: hard-code 8/12/16 px everywhere; token offered everywhere · pro: Number variables on a scale; set scopes (GAP, CORNER_RADIUS...) · need: create Number variables; set variable scopes on create
- 🟡 **Plan tokens for code export (DTCG / Tokens Studio)** — `variable.codeSyntax + setVariableCodeSyntax(platform,value)` *(_agent maps names / emits DTCG; instance member — verify in-sandbox_)*
  - noob: no code-syntax, names diverge from engineering · pro: set code-syntax / export name fields so eng shares names · need: per-variable code-syntax / export name fields
- 🟡 **Extract repeated ad-hoc literals into tokens and re-bind in bulk** — `node.findAll/boundVariables (audit) + createVariable + setBoundVariable/setBoundVariableForPaint per node` *(_needs-agent-logic_)*
  - noob: leave literals, fix by hand one by one · pro: scan for literals, create tokens, bulk re-bind · need: audit read of literals + create_variables + bulk bind_variable
- ✅ **Create + apply paint/text/effect/grid styles (type ramp, gradient, shadow)** — `createPaintStyle/createTextStyle/createEffectStyle/createGridStyle + setFillStyleIdAsync/setEffectStyleIdAsync/textStyleId/setGridStyleIdAsync` *(_async_)*
  - noob: set raw font/color/effect values per node · pro: create style, apply by id; styles for what variables can't reach · need: create_styles + apply_style by id; clear variable-vs-style routing
- ✅ **Switch a frame/page to a variable mode (e.g. dark)** — `node.setExplicitVariableModeForCollection(collection, modeId)`
  - noob: duplicate the screen for a dark version · pro: set the frame's explicit mode so every descendant cascades · need: apply a collection mode to a node/frame

### 13. Prototyping & Dev Handoff

- ✅ **Read prototype flow / reactions on a node** — `node.reactions`
  - noob: ignore interactions entirely · pro: get_reactions to read triggers, actions, destinations · need: get_reactions reading interaction wiring
- ✅ **Wire a button to navigate, and copy interactions to many nodes** — `node.setReactionsAsync(reactions); node.reactions to read+replay on siblings` *(_async_)*
  - noob: no interaction, or re-wire each node manually · pro: set reaction on node; read reactions, apply to siblings in batch · need: set_reactions (validated Reaction shape), round-trip clean
- ✅ **Annotate a node with spec notes for engineers** — `node.annotations (read/write); figma.annotations.* (categories)` *(_feature-detect_)*
  - noob: leave a text label floating near it · pro: set_annotation attached to the node; batch set_multiple_annotations · need: get/set annotations on nodes, batched
- ✅ **Export assets at 1x/2x PNG + SVG with persistent presets** — `node.exportSettings (read-write, persistent) + node.exportAsync(settings)` *(_async_)*
  - noob: one-off manual export, inconsistent scales · pro: persistent export settings per node + export · need: set persistent export settings (format+scale list); export
- 🟡 **Hand off CSS/specs + token names that match auto-layout** — `node.getCSSAsync() + variable.codeSyntax` *(_agent maps CSS to token names_)*
  - noob: absolute frames -> wrong flex/grid CSS; deliver raw hex/px · pro: auto-layout structure + bound token names + code-syntax surfaced · need: reads exposing layoutMode/sizing/padding/gap + bound token name + code-syntax

## Notes

- Many ✅ build/edit tasks are N-call loops (batch text, bulk delete, multi-restyle) — feasible but no batch API, so the surface needs a generic multi-target `batch` wrapper.
- Ordering constraints are load-bearing: set `FILL`/`ABSOLUTE` only AFTER appendChild to an auto-layout parent; `loadFontAsync` must resolve before any text write.
- **Reference gap (pending):** `variable.codeSyntax`/`setVariableCodeSyntax`, `collection.addMode`/`removeMode`/`renameMode`, `variable.scopes`, `variable.hiddenFromPublishing` are confirmed in the official Plugin API (2026-06-23) but absent from `figma-plugin-api.md` (the 2026-03-22 introspection under-captured instance members); add them there.
- **Excluded (Plugin API can't — out of scope):** Diagram a flow with connectors between frames, Leave a file comment, Draw measurement / redline overlays; plus library publish (UI/REST only), real chart-from-data (no charting API), and programmatic undo/rollback (only `commitUndo` checkpoints, no multi-step rollback).
