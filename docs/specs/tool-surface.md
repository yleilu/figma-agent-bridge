---
title: figma-agent-bridge MCP Tool Surface — Design (M4 harvest)
created: 2026-06-22T15:30:00+08:00
tags: [figma-bridge, mcp, tool-surface, m4, design, autoresearch-harvest]
type: spec
---

# figma-agent-bridge — MCP Tool Surface (Recommended / Unified)

The implementation-ready tool surface for figma-agent-bridge: the trimmed + feasibility-fixed harvest of the autoresearch R36 spec (94 tools → **45 tools**). This unifies the three lens proposals: **coherence** as the base (round-trip symmetry as the organizing law, aggressive field-name standardization, the granular setters kept as aliases), with two grafts from **coverage** (annotations included; text ranges as a dedicated tool) and the naming discipline of **ergonomics**.

**Final tool count: 45** (15 shipped → ~30 net-new, incl. one generic `batch` tool — see Finalized decisions F-A). Within the brief's 35–46 envelope.

---

## Resolved decisions (design review — 2026-06-22)

Six questions surfaced by the design panel were resolved at review. They are **binding** for implementation:

1. **`bind_variable` paint binding** — Ship **scalar binding** this phase (opacity, strokeWeight, itemSpacing, padding, cornerRadius, …) via `node.setBoundVariable(field, variable)`. Paint binding for fills/strokes (`figma.variables.setBoundVariableForPaint`) has **no in-repo precedent** → gate it behind a runtime feature-detect that warns if unavailable; do not depend on it until smoke-tested in-sandbox.
2. **`set_text_ranges` property scope** — Ship **font ranging** (`setRangeFontName`, fork-verified) as proven. The other range props (`setRangeFills` / `setRangeTextDecoration` / `setRangeTextCase` / `setRangeLetterSpacing` / `setRangeLineHeight`) are real but unverified in-repo → each behind a **per-property feature-detect-and-warn**.
3. **`get_node` INSTANCE `component.key`** — **In scope.** Add `component.key` to the INSTANCE read shape (plugin `get_node` serializer + `ParsedNode` type in `shared`) so INSTANCE round-trip works. Required by the round-trip law.
4. **`constraints` write-side** — **Add now.** `constraints` is already read by `ParsedNode` but not accepted by write-side `NodeSpec`; add it to restore round-trip symmetry.
5. **Style text-value grammar** — **Extend `docs/specs/expression-formats.md`** to canonically document the style-creation font-value variant (`/LineHeight` and `?ls=` suffixes), rather than a separate mini-grammar.
6. **Immutable API reference** — **Extend `docs/reference/figma-plugin-api.md`** to itemize the verified-real APIs (`listAvailableFontsAsync`, `setRangeFontName`, `figma.annotations.*`) with verification notes, so future work treats them as part of the capability ceiling.

### Suggested implementation phasing (for the plan)

1. **Mutation core** — `update_node` + the 6 setter aliases, `delete_node`, `clone_node`, `reparent_node`, `reorder_children`, `set_selection`, `set_current_page`, `create_page`. Closes the biggest gap (no edit capability today).
2. **Design system** — `get_local_styles` / `get_local_variables` (refit), `create_styles` / `update_styles` / `apply_style`, `create_variables` / `update_variables` / `bind_variable` (scalar).
3. **Components & instances** — `update_component`, `combine_variants`, `swap_component` (remote-fixed), `detach_instance`, `reset_instance`, `set_instance_properties`; plus the `get_node` `component.key` read-side fix.
4. **Handoff & text** — `list_fonts`, `set_text_ranges`, `get_annotations` / `set_annotation`; plus the two doc extensions (decisions 5 & 6).

Read/query refits (`get_node`/`get_nodes`/`search`/etc. async fixes) land alongside whichever phase first needs them.

## Finalized decisions — semantics, contract & scope (review round 2, 2026-06-22)

A second design-review pass (lenses: runtime semantics, schema/contract, scope) surfaced ~24 further decisions not covered by the six Resolved decisions above. All are now resolved and **binding**. Four were product/architecture forks decided with the user; the rest take the recommended default.

### Product forks (user-decided)

- **F-A · Multi-node editing → ADD one generic `batch` tool.** All single-target setters and `update_node` stay single-node. A new `batch` tool applies one operation across many targets — `{ op: 'update_node'|'delete_node'|'set_fills'|…, entries: [{ nodeId, …params }] }` → `{ results, errors[] }` (partial success). This is the **only** multi-target mutation path (no per-tool `batch_*` twins). **Surface becomes 45 tools.**
- **F-B · Errors → server-side typed `{ error, code }`.** The server maps connection state + known plugin error strings to the `ErrorCode` enum and emits the envelope as one JSON `text` block. **The plugin is unchanged this phase** (it keeps returning `{ error: string }`; the server adds the code). No plugin churn.
- **F-C · Variable binding → `bind_variable` only; `var()` read-only this phase.** `bind_variable` is the sole field-binding path, limited to verified scalar fields (opacity/strokeWeight/spacing/padding/radius). `var()` appears in read output but resolves to a **literal** on write. `expression-formats.md` is updated to scope `var()` to reads for now. The unverified `setBoundVariableForPaint` is **not** used this phase.
- **F-D · Release → ship all 45 atomically.** The 4 build phases are an internal build/test order only; tools are exposed to agents together, one minor version bump, so the round-trip guarantee always holds.

### Contract defaults (recommended, decided)

- **`update_node` schema:** hand-author `updateNodeSpecSchema` — every field optional, **no `type`**, excludes create-only fields (`pointCount`, `vectorPaths`, `booleanOperation`, …). Not `nodeSpecSchema.partial()`.
- **Merge vs replace → REPLACE-only.** Every array (`fills`/`effects`/`strokes`) and nested object (`text`/`layout`) is wholesale-assigned. Partial edits = read-whole, modify, write-whole (matches the plugin + round-trip law). Documented in each tool description.
- **`layout` is partial-editable:** in `updateNodeSpecSchema` the `layout` sub-fields are optional and `mode` accepts `NONE` (turn auto-layout off). Create-side `layout` keeps its required fields.
- **`create_styles` font value:** new `parseStyleFontValue()` — strip `?ls=<v>` first, then `Family/Style/Size[/LineHeight]`. Does **not** touch the load-bearing 3-part `parseFontExpression`. Documented in `expression-formats.md` (Resolved decision #5).
- **`set_text_ranges`:** range font split into `font` (`Family/Style`, 2-part) + optional `fontSize`. `setRangeFontName` proven; the other `setRange*` props each feature-detect-and-warn.
- **Text enums → Figma raw superset everywhere** (node text + ranges): `decoration: NONE|UNDERLINE|STRIKETHROUGH`, `case: ORIGINAL|UPPER|LOWER|TITLE|SMALL_CAPS|SMALL_CAPS_FORCED`. Lets `update_node` reset decoration/case too.
- **Component ref:** add `key` to the write schema (`createComponentRefSchema`) with strip-unknown-keys; `get_node` emits the richer `{ key, name, id, variant, overrides }`; write consumes only `key` + `properties`.
- **`constraints` write-side:** enum tuple `[MIN|MAX|CENTER|STRETCH|SCALE, …]`; plugin skips + warns when the node is an auto-layout child.
- **Depth contract:** declare defaults in each zod schema — `get_node`/`get_nodes`/`inspect` = 3, `find_children` = -1, page overviews = 0. Canonical stub (depth 0) = `{ id, name, type, size, position, childCount }`, children omitted.
- **Variable modes:** `modes[]` (first = default) defines modes on collection creation; an unknown mode name on update = per-row `INVALID_PARAM` in `errors[]`; adding modes to an existing collection is deferred.
- **`search`/`find_children`:** one shared `filterFieldsSchema` (`name`/`type`/`componentKey`/`styleId`, AND-combined); `search` adds `pageId`/`selection`/`limit`, `find_children` adds `nodeId`/`depth`/`limit`. `componentKey` matches INSTANCEs whose `mainComponent.key` equals the value.
- **`create_component` un-overloaded:** single-node promote only; `combine_variants` is the sole variant-combining tool (migrate the shipped multi-mode schema).
- **Return shape:** every node-write returns at minimum `{ id, name, type }` plus operation-salient fields; an optional `warning?: string` on success is the canonical channel for non-fatal notes (createSlot-unavailable, auto-layout no-ops).

### Semantics defaults (recommended, decided)

- **`clone_node`:** raw `clone()` (no auto-offset); returns the N new nodes only, in creation order. Reposition via `set_position`/`reparent_node`.
- **`delete_node` on a page:** auto-switch off `currentPage` to a sibling before removal; deleting the **last** page → `INVALID_PARAM`.
- **`reorder_children`:** requires the **full** child set; validate set-equality (missing/extra/duplicate ids → `INVALID_PARAM`).
- **`reparent_node`:** `index` = child-list index (= layout order in auto-layout, z-order otherwise); Figma derives geometry. Documented.
- **Mixed fonts on write:** non-text updates skip font loading (recolor a mixed-font node freely); a whole-node text-content write on a mixed-font node → `FONT_LOAD_FAILED`, use `set_text_ranges`.
- **`update_node` apply order / atomicity:** fixed order (structure/size → `textAutoResize` → `resize` → positioning); all expressions validated/converted server-side first; **best-effort, not transactional** (Figma has no rollback) — documented.
- **`set_position`/`resize_node` no-ops:** emit `warning?` when ignored (auto-layout-managed position; HUG/FILL axis on resize); never error.
- **Timeouts:** 30s standard; 120s for `export` and `create_tree`; optional override param on `export`.

### Scope defaults (recommended, decided)

- **Variable aliasing → supported both directions.** A variable value may reference another variable: read emits `var(Coll/Name)`, write uses `setValueForMode` with a `VariableAlias` (real API, smoke-tested before ship). Required so design systems don't flatten on round-trip. *(Distinct from F-C, which is about binding a node field.)*
- **`update_component.editProperties`** expanded to `{ name, newName?, defaultValue?, options?, preferredValues? }` (covers rename/default/INSTANCE_SWAP edits, not just variants).
- **`node.locked`** added to both read and write (mirrors `visible`).
- **`grid` (layout grids on a node)** → read-only this phase; added to DEFER explicitly (documented asymmetry, like `set_text_ranges`).
- **Remote/library styles & variables** → LOCAL only this phase; remote import (`importStyleByKeyAsync`/`importVariableByKeyAsync`) added to DEFER (stated asymmetry vs components).
- **Boolean/group ops on existing nodes** remain DEFERRED but are flagged the **#1 next-phase candidate** — the "covered by `create_tree`" rationale is acknowledged as lossy for already-positioned nodes.

### Acceptance gate (for the plan)

- Per-handler zod + cross-validation tests (TDD), reusing existing expression-parser tests.
- **In-sandbox smoke-test** is the go/defer gate for the flagged-unverified write paths: non-font `setRange*`, the `VariableAlias` write, `swap_component` remote import. (`createSlot` already degrades via warning.)
- Update downstream: the `figma-mcp` skill tool list, the Notion M3 API-coverage checklist, `docs/specs/expression-formats.md` (replace semantics, style-font grammar, `var()` read-scope), and `docs/reference/figma-plugin-api.md` (itemize verified APIs) per Resolved decisions #5/#6.

---

## Design principles

1. **Round-trip symmetry is the organizing law.** `get_node` output (`ParsedNode`) is structurally identical to `create_node`/`update_node` input (`CreateNodeSpec`). Mirrored for the design system: `get_local_styles.value` → `create_styles`/`update_styles`; `get_local_variables.valuesByMode` → `create_variables`/`update_variables`; `get_selection` → `set_selection`.
2. **One concept, one canonical name, everywhere.** A component identifier is `key` on read AND write (never `componentKey` as an identifier). Variable mode maps are `valuesByMode` keyed by mode *name* (never raw modeId). Node identity is `id` in output, `nodeId`/`parentId` in input; styles `styleId`/`id`; variables `variableId`/`id`. The sole documented exception is the `search`/`find_children` filter predicate `componentKey` ("instances whose backing component has this key"), which is a predicate, not an identifier.
3. **One mutation vocabulary.** `update_node(Partial<NodeSpec>)` is the canonical single-target mutation. The six granular setters (`set_fills`/`set_strokes`/`set_effects`/`set_text_content`/`set_position`/`resize_node`) are KEPT per the brief but defined as **thin pre-validated aliases** sharing update_node's exact field semantics and the same server expression parser — convenience entry points, not a divergent API.
4. **One path per operation.** One reparent path (`reparent_node`), one reorder path (`reorder_children`), one instance-override path (`set_instance_properties`), one machine reader + one human reader per primitive. `move_node` is cut. `update_node` drops the nested instance-override branch.
5. **Expression grammar is the backbone — reused, never reinvented.** Colors `#RRGGBB`/`#RRGGBBAA` (6/8-char uppercase, no shorthand — commit 8d9a299); `style(Name)`/`var(Coll/Name)` prefixes; gradients linear|radial|angular|diamond; effects shadow/inner-shadow/blur/bg-blur; fonts `Family/Style/Size`; layout YAML. Server parses expressions → Figma objects BEFORE `sendCommand`; the plugin only assigns.
6. **Async everywhere.** All node resolution is `await figma.getNodeByIdAsync(id)`; all style/variable/component reads use the Async forms. No sync `getNodeById` exists in this sandbox.
7. **Uniform result envelope** with a typed error code. See "Result and error shape".

---

## Cross-cutting feasibility fixes (applied to every relevant tool)

- **F1 Node resolution:** `await figma.getNodeByIdAsync(id)` — never sync.
- **F2 Component-by-key:** `await figma.importComponentByKeyAsync(key)` (remote-capable; already shipped, code.ts:593). Local enumeration via `figma.root.findAllWithCriteria({ types: ['COMPONENT'] })` / `['COMPONENT_SET']` (code.ts:984-987). `getLocalComponents()` does **not** exist and is never used.
- **F3 swap_component is REMOTE-capable** via importComponentByKeyAsync. The R36 "local-only" limitation is false and removed.
- **F4 createSlot feature-detected:** `if (component.createSlot) {...} else warn` (code.ts:1292). Component properties added BEFORE slots.
- **F5 Styles Async forms:** `getLocalPaintStylesAsync`/`getLocalTextStylesAsync`/`getLocalEffectStylesAsync`/`getLocalGridStylesAsync`/`getStyleByIdAsync`; apply via `node.setFillStyleIdAsync`/`setStrokeStyleIdAsync`/`setTextStyleIdAsync`/`setEffectStyleIdAsync`.
- **F6 Variables Async forms:** `getLocalVariablesAsync`/`getLocalVariableCollectionsAsync`/`getVariableByIdAsync`/`getVariableCollectionByIdAsync`.
- **F7 bind_variable split paths:** scalar fields (opacity/strokeWeight/itemSpacing/padding*/*Radius) → `node.setBoundVariable(field, variable)` (in reference + SDK). Paint fields (fills/strokes) → `figma.variables.setBoundVariableForPaint(paint, 'color', variable)` then assign the bound paint — **CAVEAT: this paint API has no in-repo precedent (not in the shipped plugin or the working fork); smoke-test before shipping the paint branch (see Resolved decisions).**
- **F8 Text writes load fonts first:** `await figma.loadFontAsync(fontName)` BEFORE characters/font. On read of an existing TEXT node, load the current `fontName` (reject or load-all when `figma.mixed`). Set `textAutoResize` BEFORE `resize()`.
- **F9 Guard `figma.mixed`:** any reader touching `fontName`/`fontSize`/`*StyleId`/`cornerRadius`/`fills` must guard `figma.mixed` and emit a sentinel rather than crash.
- **F10 editorType gating:** components/styles/variables/slots/annotations guard non-Figma editors → `WRONG_EDITOR`.
- **F11 Geometry guards:** feature-detect every property write (`'resize' in node`, `'layoutMode' in node`, `'cornerRadius' in node`) — SECTION/GROUP/PAGE lack many geometry props (commit a7faf58).

---

## Result and error shape

Transport returns the MCP `ToolResult` = `{ content: ({ type:'text'; text:string } | { type:'image'; data:string; mimeType:string })[] }`.

- **Success (writes):** `JSON.stringify(result, null, 2)` of a plain serializable object (`{ id, name, type, ... }` or an array). Never node references.
- **Success (reads):** machine readers (`get_*`) emit JSON `ParsedNode`/arrays; human readers (`inspect`, `inspect_page_layout`, `list_pages`) emit YAML.
- **`export`** returns an `image` block (PNG/JPG/PDF) or a `text` block (SVG).
- **Error (uniform):** `{ error: string, code: ErrorCode }`.
  - `ErrorCode = 'NODE_NOT_FOUND' | 'INVALID_PARAM' | 'FONT_LOAD_FAILED' | 'DISCONNECTED' | 'TIMEOUT' | 'UNSUPPORTED_NODE_TYPE' | 'API_UNAVAILABLE' | 'WRONG_EDITOR'`.
  - `DISCONNECTED` replaces today's free-text "Not connected" string. `API_UNAVAILABLE` is the feature-detect degrade (e.g. createSlot). `WRONG_EDITOR` guards design-only APIs.
  - **The server owns this mapping** (connection state + known plugin error strings → code) and emits `{ error, code }` as one JSON `text` block; the plugin is unchanged this phase (fork F-B).
- **Partial success** (the generic `batch` tool + the legitimate array-envelope tools: `create_tree` sibling-array form, `create_styles`, `create_variables`, `update_styles`, `update_variables`, and `get_nodes`): payload includes `results` and `errors[]` (`{ index, error, code }`). Other single-target tools never partially succeed.

Handler order (per brief + commit 39832e0): input cross-validation → `if (!client.isConnected())` → convert expressions server-side → `await client.sendCommand('<command>', {...})` → `result === null` → `result.error !== undefined` → success. Cross-field validation lives in the **handler**, not the zod schema. Plugin command strings may differ from tool names (tool `inspect` → command `get_node`; setters → command `update_node` with field-scoped payloads). Pass a larger `timeoutMs` for `export` and large `create_tree`.

---

## Tool catalogue

45 tools across 12 categories (the generic `batch` tool from fork F-A is specified under Finalized decisions). `[shipped]` = exists today; `[fix]` = exists but needs a feasibility fix; `[new]` = net-new.

### 1. Connection / session (2)

#### `connect` [shipped]
Pair the MCP server with the Figma plugin over a WebSocket channel.
- `channel: z.string().min(1)`
- → `{ status, channel }` · **API:** WebSocket pairing (no figma.*) · *Round-trip: `channel` is reusable as input.*

#### `status` [shipped]
Report connection state.
- (no params) → `{ connected: boolean, channel: string | null }` · **API:** socket state · *`channel` feeds `connect`.*

### 2. Read / query — machine + human (10)

> One machine `get_*` (JSON, round-trippable) and one human `inspect*` (YAML, lossy) per primitive. `get_nodes` is the multi-id read primitive (a legitimate array envelope, NOT a batch twin). Cut readers `inspect_styles`/`inspect_components`/`inspect_variables`/`get_style_by_id`/`get_variable_by_id` are absorbed into the machine readers.

#### `inspect` [shipped, fix F1]
Human YAML of a node, or current selection if `nodeId` omitted.
- `nodeId?: string` → YAML tree · **API:** command `get_node` (+`get_selection` fallback) → `getNodeByIdAsync` → `parseNode` → `toInspectTree` · *Human companion to `get_node`.*

#### `inspect_page_layout` [shipped]
Overview of all top-level frames on the current page.
- (no params) → YAML `[{ name, id, x, y, width, height }]` · **API:** command `get_page_layout` → `figma.currentPage.children`.

#### `get_node` [shipped, fix F1/F9 + INSTANCE key]
Machine `ParsedNode` JSON — the round-trip anchor.
- `nodeId: string`; `depth?: number` (0=stubs, 3=default, -1=unlimited) → `ParsedNode`.
- **API:** `await figma.getNodeByIdAsync(nodeId)` → recursive property read. **FIX:** async; guard `figma.mixed` on `styleId`/`fontName`; **emit `component.key` for INSTANCE nodes** (the read shape currently lacks it — required for INSTANCE round-trip; see NodeSpec note + Resolved decisions #3). · *Output === `create_node`/`update_node` input.*

#### `get_nodes` [shipped, fix F1/F9]
Multi-id read primitive.
- `nodeIds: string[]`; `depth?: number` → `{ results: ParsedNode[], errors: { index, error, code }[] }` · **API:** per-id `getNodeByIdAsync` · *Each element feeds `create_node`/`update_node`.*

#### `get_page_nodes` [fix F1]
Top-level children of ANY page by id, without switching the current page.
- `pageId: string`; `depth?: number` (default 0) → `[{ id, name, type, x, y, width, height }]` · **API:** `(await getNodeByIdAsync(pageId)).children`. **FIX:** async; reject non-PAGE (`INVALID_PARAM`). New plugin command `get_page_nodes`. · *Each `id` → `parentId`/`nodeId`.*

#### `list_pages` [shipped]
Enumerate all pages.
- (no params) → YAML `[{ id, name, isCurrent, childCount }]` · **API:** `figma.root.children` · *`id` → `pageId`/`parentId`.*

#### `get_document_info` [shipped, fix]
Document metadata + page list + current page.
- (no params) → `{ name, pageCount, currentPage: { id, name }, pages: [{ id, name }] }` · **API:** `figma.root.name`/`figma.root.children`/`figma.currentPage`. **FIX:** promote the shipped command to also return the page list. · *`pages[].id` → `pageId`.*

#### `get_selection` [shipped]
Read the current selection.
- (no params) → `[{ id, name, type }]` · **API:** `figma.currentPage.selection` · *Output `id[]` feeds `set_selection`.*

#### `search` [shipped, fix F9]
Document-wide node finder.
- `name?: string` (`*` wildcards); `type?: string`; `componentKey?: string` (**filter predicate — kept long deliberately**); `styleId?: string`; `pageId?: string`; `selection?: boolean` (default false); `limit?: number` (default 50) → `{ results: [{ id, name, type, page, parent, width, height }], truncated }` · **API:** per-page `node.findAll(cb)`. **FIX:** guard `figma.mixed` on style slots before compare. · *Each `id` → any NodeRef tool; `componentKey` matches `get_local_components.key`.*

#### `find_children` [fix F1/F9]
Subtree-scoped finder (same filters as `search`, rooted at one node).
- `nodeId: string`; `name?`/`type?`/`componentKey?`/`styleId?`; `depth?: number` (default -1); `limit?: number` (default 50) → `{ results: [{ id, name, type, parentId }], truncated }` · **API:** `(await getNodeByIdAsync(nodeId)).findAll(cb)`. **FIX:** async root; same mixed guard. New plugin command `find_children`. · *Pairs with `search` (doc-wide vs subtree).*

### 3. Design-system readers — single machine reader per kind (3)

#### `get_local_components` [shipped, fix F2/F10]
Machine component reader; the source of component `key`s.
- `query?: string`; `id?: string` (direct lookup; absorbs `get_*_by_id`) → `[{ id, name, key, description, variantProperties: Record<string,string> }]` · **API:** `figma.root.findAllWithCriteria({ types: ['COMPONENT'] })` + `['COMPONENT_SET']`. **FIX:** hallucinated `getLocalComponents()` removed; `WRONG_EDITOR` guard. Absorbs `inspect_components`. · *`key` → `create_node` INSTANCE / `swap_component` / `search.componentKey`; `id` → `update_component`.*

#### `get_local_styles` [fix F5/F9]
Single machine style reader with resolved expression values.
- `id?: string`; `type?: 'paint'|'text'|'effect'|'grid'` → `[{ id, name, type, value }]` (`value` in `create_styles` expression format) · **API:** `getLocal*StylesAsync` (filtered) / `getStyleByIdAsync(id)`. **FIX:** Async forms; `WRONG_EDITOR`. New resolved-value plugin command (the shipped `get_styles` returns an unresolved shape). Absorbs `inspect_styles` + `get_style_by_id`. · *`value` → `create_styles`/`update_styles`; `name` → `style(Name)`.*

#### `get_local_variables` [fix F6]
Single machine variable reader, collection-grouped, mode-resolved.
- `id?: string`; `collectionId?: string`; `type?: 'COLOR'|'FLOAT'|'STRING'|'BOOLEAN'` → `[{ id, name, type, collectionId, collectionName, valuesByMode: Record<modeName, value> }]` (COLOR as `#RRGGBBAA`) · **API:** `getLocalVariablesAsync`/`getLocalVariableCollectionsAsync` (+ `getVariableByIdAsync`/`getVariableCollectionByIdAsync` when filtered); modeIds → mode names. **FIX:** Async; `WRONG_EDITOR`. Absorbs `inspect_variables` + `get_variable_by_id`. · *`valuesByMode` (mode-name keyed) → `create_variables`/`update_variables`; `name` → `var(Collection/Name)`.*

### 4. Pages / navigation (2)

#### `create_page` [new]
- `name: string`; `isCurrent?: boolean` (default false) → `{ id, name }` · **API:** `figma.createPage()` → `.name` (+ `figma.currentPage = page` if `isCurrent`). New plugin command `create_page`. · *`id` → `parentId`/`pageId`.*

#### `set_current_page` [fix F1]
- `pageId?: string` XOR `name?: string` (handler validates exactly one) → `{ id, name }` · **API:** `figma.currentPage = await getNodeByIdAsync(pageId)` or `root.children.find(name)`. **FIX:** async; reject non-PAGE. New plugin command `set_current_page`.

### 5. Create (3)

#### `create_node` [shipped, fix F2/F8]
Create a single node of any type.
- `parentId: string`; `node: NodeSpec` (same structure as `get_node` output) → `{ id, name, type }` (INSTANCE also returns `key`) · **API:** `figma.create*()`; INSTANCE via `await importComponentByKeyAsync(node.component.key)` → `createInstance()` (code.ts:593); TEXT → `await loadFontAsync(...)` before characters/font. **FIX:** async parent; remote-capable INSTANCE. · *`node` === `get_node` output.*

#### `create_tree` [shipped, fix F2/F8]
Recursive hierarchy + sibling-array form (legitimate built-in batch-create envelope). Supports clone refs `{ id }`.
- Single-root: `parentId`, `node: TreeNodeSpec` (recursive `children[]`). Sibling: `parentId`, `nodes: TreeNodeSpec[]` → single `{ id, name, type }` or `{ results, errors }`; INSTANCE entries include `key`.
- **API:** 4-phase per node (create → set props except FILL-sizing/`layoutPositioning:ABSOLUTE` → `appendChild` → set deferred sizing/positioning). Clone ref → `node.clone()`; component ref → `importComponentByKeyAsync` + `createInstance()`. **FIX:** async; keep 4-phase ordering (code.ts:1198). · *A `get_node(depth:-1)` subtree feeds straight back.*

#### `create_from_svg` [shipped, fix F1]
- `parentId: string`; `svg: string`; `name?: string` (default "SVG"); `size?: [number, number]` → `{ id, name, type, childCount }` · **API:** `figma.createNodeFromSvg(svg)` → name/resize → `appendChild`. **FIX:** async parent.

### 6. Mutation / update (9)

> `update_node(Partial<NodeSpec>)` is the canonical single-target mutation. The six setters are KEPT (brief mandate) as **thin pre-validated aliases** sharing update_node's exact field semantics and parser — one mutation vocabulary, convenience entry points. All route to a single new plugin command `update_node` with a field-scoped payload (≈6 zod schemas + thin server shells, not 6 plugin cases).

#### `update_node` [new, fix F1/F8/F9]
Central single-target mutation; accepts any subset of NodeSpec.
- `nodeId: string`; `props: Partial<NodeSpec>` — `fills`, `strokes`, `strokeWeight`, `strokeAlign`, `strokeDash`, `radius`, `opacity`, `effects`, `blendMode`, `rotation`, `visible`, `clipsContent`, `size`, `position`, `layout`, `sizing`, `layoutPositioning`, `min/maxWidth/Height`, `constraints` (now in scope — see Resolved decisions #4), `text`, `textAutoResize`, `name`. → `{ id, name, type }` · **API:** new plugin command `update_node` — `getNodeByIdAsync`, server converts expressions, then per-field assignment; TEXT → `loadFontAsync` (handle `figma.mixed`) before text props, `textAutoResize` before `resize`. **FIX:** async; mixed/styleId guards; **DROP the nested instance-override branch** (route via `set_instance_properties`). · *`props` is `Partial<get_node output>` — full read-modify-write.*

#### `set_fills` [new] *(alias of update_node)*
- `nodeId: string`; `fills: string[]` (hex/gradient/`style()`/`var()`/`image()`) → `{ id, name, type }` · **API:** server `parseFillExpressions` → `update_node` `{ fills }`. · *`fills` === `ParsedNode.fills`.*

#### `set_strokes` [new] *(alias)*
- `nodeId: string`; `strokes: string[]` → `{ id, name, type }` · **API:** `parseFillExpressions` → `update_node` `{ strokes }`.

#### `set_effects` [new] *(alias)*
- `nodeId: string`; `effects: string[]` (`shadow()`/`inner-shadow()`/`blur()`/`bg-blur()`/`style()`) → `{ id, name, type }` · **API:** `parseEffectExpressions` → `update_node` `{ effects }`.

#### `set_text_content` [new, fix F8] *(alias; whole-node text only)*
- `nodeId: string` (must be TEXT); `content: string` → `{ id, name, type }` · **API:** plugin loads current `fontName` (`loadFontAsync`, reject `figma.mixed` → `FONT_LOAD_FAILED`) then `node.characters = content`. `update_node` text-content payload. · *Per-substring styling is `set_text_ranges` (§11), not here.*

#### `set_position` [new] *(alias)*
- `nodeId: string`; `x: number`; `y: number` → `{ id, name, type, x, y }` · **API:** `node.x`/`node.y` → `update_node` `{ position: [x, y] }`. No-op caveat under auto-layout (surfaced as `warning`).

#### `resize_node` [new, fix F8] *(alias)*
- `nodeId: string`; `width: number`; `height: number` → `{ id, name, type, width, height }` · **API:** `node.resize(w, h)` → `update_node` `{ size: [w, h] }`; TEXT sets `textAutoResize` first. Guard `'resize' in node`.

#### `delete_node` [new, fix F1]
- `nodeId: string` → `{ id, name, type }` (captured before removal) · **API:** `(await getNodeByIdAsync(nodeId)).remove()` (works on pages; Figma keeps ≥1). New plugin command `delete_node`.

#### `clone_node` [new, fix F1]
- `nodeId: string`; `parentId?: string` (defaults to same parent); `count?: number` (default 1) → `[{ id, name, type }]` (always an array) · **API:** `node.clone()` ×count (+ `parent.appendChild` if reparenting). New plugin command `clone_node`.

### 7. Structure (3)

> One reparent path + one reorder path. `move_node` CUT (parentId branch == `reparent_node`; index branch == `reorder_children`).

#### `reparent_node` [new, fix F1]
- `nodeId: string`; `parentId: string`; `index?: number` (omit to append) → `{ id, name, type, parentId }` · **API:** `parent.insertChild(index, node)` / `parent.appendChild(node)`. **FIX:** async both; guard `'appendChild' in parent`. New plugin command `reparent_node`.

#### `reorder_children` [new, fix F1]
- `parentId: string`; `nodeIds: string[]` (desired order) → `{ parentId, childCount, order: string[] }` · **API:** sequential `parent.insertChild(i, node)` for i=0..N-1 (each insert shifts indices). New plugin command `reorder_children`.

#### `set_selection` [new, fix F1]
- `nodeIds: string[]` → `{ selectedCount, nodeIds }` · **API:** `figma.currentPage.selection = [resolved]`. New plugin command `set_selection`. · *Consumes `get_selection` output directly.*

### 8. Components & instances (7)

> One instance-override path: `set_instance_properties` (flat).

#### `create_component` [shipped, fix F4/F10]
Promote a node to a Component; add properties (before slots); slots feature-detected.
- `nodeId: string`; `componentProperties?: [{ name, type: 'BOOLEAN'|'TEXT'|'INSTANCE_SWAP'|'SLOT', default? }]`; `slots?: string[]` → `{ id, name, type, key }` (+ `warning` if `createSlot` unavailable) · **API:** `createComponentFromNode`; `addComponentProperty`; then `createSlot(child)` feature-detected (code.ts:1292). **FIX:** async; properties before slots; `WRONG_EDITOR`. Handler validation per commit 39832e0. · *`key` → INSTANCE creation / `swap_component`.*

#### `update_component` [new, fix F1/F10]
Edit/delete/add component properties (round-trips `create_component`).
- `nodeId: string`; `addProperties?: [...]` (same shape as `create_component.componentProperties`); `editProperties?: [{ name, options }]`; `deleteProperties?: string[]` → `{ id, name, type, key }` · **API:** `editComponentProperty`/`deleteComponentProperty`/`addComponentProperty`. New plugin command `update_component`.

#### `combine_variants` [new, fix F1]
- `nodeIds: string[]` (≥2; handler validates → `INVALID_PARAM`) → `{ id, name, type, key }` · **API:** `combineAsVariants(nodes, firstParent)`. New plugin command `combine_variants`.

#### `swap_component` [new, fix F1/F3]
Swap an instance's backing component — **remote/library capable**.
- `nodeId: string` (the INSTANCE); `key: string` (**identifier — standardized from R36 `componentKey`**) → `{ id, name, type, key }` · **API:** `instance.swapComponent(await importComponentByKeyAsync(key))`. **FIX:** false local-only limitation removed. · *`key` === `get_local_components.key`.*

#### `detach_instance` [new, fix F1]
- `nodeId: string` → `{ id, name, type }` (resulting FrameNode) · **API:** `instance.detachInstance()`. **FIX:** reject non-INSTANCE (`UNSUPPORTED_NODE_TYPE`).

#### `reset_instance` [new, fix F1]
- `nodeId: string` → `{ id, name, type }` · **API:** `instance.resetOverrides()`. Reject non-INSTANCE.

#### `set_instance_properties` [new, fix F1]
The single instance-override path.
- `nodeId: string` (must be INSTANCE); `properties: Record<string, string | boolean>` → `{ id, name, type }` · **API:** `instance.setProperties(properties)` (pass-through). New plugin command. · *`update_node` deliberately does NOT carry nested overrides.*

### 9. Styles — authoring (3)

#### `create_styles` [new, fix F5/F10]
Batch-create paint/text/effect/grid styles (array envelope, not a twin).
- `styles: [{ type: 'paint'|'text'|'effect'|'grid', name, value }]` — `value` uses canonical grammar (paint hex/gradient; text `Family/Style/Size`, with optional `/LineHeight`+`?ls=` style-value extension — see Resolved decisions; effect `shadow()`/`blur()`; grid `columns()/rows()/grid()`) → `{ results: [{ type, name, id }], errors }` · **API:** `createPaintStyle`/`createTextStyle`/`createEffectStyle`/`createGridStyle` + set value. **FIX:** `WRONG_EDITOR`. New plugin command `create_styles`. · *`name` → `style(Name)`; `id` → `update_styles`/`apply_style`.*

#### `update_styles` [new, fix F5]
- `styles: [{ id?, type?, name?, value, newName? }]` (handler enforces `id` XOR `name`+`type`) → `{ results: [{ type, name, id }], errors }` · **API:** `getStyleByIdAsync(id)` / `getLocal*StylesAsync().find(name)` → set value + optional `.name`. New plugin command `update_styles`. · *`value` round-trips from `get_local_styles`.*

#### `apply_style` [new, fix F5]
- `nodeId: string`; `styleId: string`; `field: 'fill'|'stroke'|'text'|'effect'` → `{ id, name, type }` · **API:** `node.setFillStyleIdAsync`/`setStrokeStyleIdAsync`/`setTextStyleIdAsync`/`setEffectStyleIdAsync`. New plugin command `apply_style`.

### 10. Variables — authoring (3)

#### `create_variables` [new, fix F6/F10]
Create a collection + variables + per-mode values (array envelope), or add to an existing collection.
- `collection?: string` (required if no `collectionId`); `modes?: string[]` (required if no `collectionId`); `collectionId?: string`; `variables: [{ name, type: 'COLOR'|'FLOAT'|'STRING'|'BOOLEAN', valuesByMode: Record<modeName, value> }]` → `{ collectionId, modeIds: Record<modeName, modeId>, variables: [{ id, name, type }] }` · **API:** `createVariableCollection` (unless `collectionId`) → `createVariable` → `setValueForMode` (modeName→modeId). **FIX:** `WRONG_EDITOR`; handler enforces `collectionId` XOR (`collection`+`modes`). New plugin command. · *`valuesByMode` (mode-name keyed) round-trips with `get_local_variables`/`update_variables`.*

#### `update_variables` [new, fix F6]
- `variables: [{ id, valuesByMode: Record<modeName, value> }]` (only listed modes change) → `{ results: [{ id, name, type }], errors }` · **API:** `getVariableByIdAsync(id)` + `getVariableCollectionByIdAsync` (modeName→modeId) → `setValueForMode`. New plugin command.

#### `bind_variable` [new, fix F6/F7]
Bind a variable to a node field (paint vs scalar paths).
- `nodeId: string`; `variableId: string`; `field: 'fills'|'strokes'|'opacity'|'strokeWeight'|'itemSpacing'|'paddingTop'|'paddingRight'|'paddingBottom'|'paddingLeft'|'topLeftRadius'|'topRightRadius'|'bottomLeftRadius'|'bottomRightRadius'` → `{ id, name, type }` · **API:** `getVariableByIdAsync(variableId)`; **scalar fields** → `node.setBoundVariable(field, variable)` (in reference + SDK); **fills/strokes** → `figma.variables.setBoundVariableForPaint(paint, 'color', variable)` then assign — **paint path has no in-repo precedent; smoke-test or defer (see Resolved decisions).** New plugin command `bind_variable`. · *`variableId` from `get_local_variables`/`create_variables`.*

### 11. Text-range styling + Fonts + Export (3)

#### `set_text_ranges` [new] *(dedicated — keeps whole-node text writes round-trippable)*
Style substrings of a TEXT node — the one realistic editing need `set_text_content`/`update_node` (whole-node only) cannot express.
- `nodeId: string` (must be TEXT); `ranges: [{ start: number (inclusive), end: number (exclusive), font?: string (Family/Style/Size), fills?: string[], textStyleId?: string, decoration?: 'UNDERLINE'|'STRIKETHROUGH'|'NONE', case?: 'UPPER'|'LOWER'|'TITLE'|'SMALL_CAPS'|'ORIGINAL', letterSpacing?: string, lineHeight?: string }]` → `{ id, name, type, rangeCount }`
- **API:** per range, after `loadFontAsync(font)` — `node.setRangeFontName(start, end, {family,style})` (+ `setRangeFontSize`), `setRangeFills`, `setRangeTextStyleIdAsync`, `setRangeTextDecoration`, `setRangeTextCase`, `setRangeLetterSpacing`, `setRangeLineHeight`. Server parses font/fill/spacing via existing parsers. New plugin command `set_text_ranges`.
- **VERIFICATION:** `setRangeFontName` is confirmed in the working fork (code.js:1592/2376/2482). The other `setRange*` properties are real Figma APIs but appear NOWHERE in the fork or reference — ship font ranging as proven, others behind a per-property feature-detect-and-warn (see Resolved decisions).
- *Decision: a dedicated tool, NOT a folded `ranges[]` field — `getStyledTextSegments` is absent from the fork, so `get_node` cannot read styled runs back; folding would create a non-round-trippable write-only field. Range styling is write-only this phase (documented asymmetry).*

#### `list_fonts` [new]
Enumerate available font families/styles so agents stop guessing names that fail at write time.
- `query?: string` (case-insensitive family filter, server-side) → `[{ family, styles: string[] }]` · **API:** `await figma.listAvailableFontsAsync()` → group `{ fontName: { family, style } }` by family. **VERIFIED real** (working fork code.js:1625). New plugin command `list_fonts`. · *`family`/`style` compose every `Family/Style/Size` expression in `create_node`/`update_node`/`create_styles`/`set_text_ranges`.*

#### `export` [shipped, fix F1]
Export a node as PNG/SVG/PDF/JPG.
- `nodeId: string`; `format?: 'PNG'|'SVG'|'PDF'|'JPG'` (default PNG); `scale?: number` (default 1) → `image` block (raster/PDF) or `text` block (SVG) · **API:** `node.exportAsync({ format, scale })`. **FIX:** async; larger `sendCommand` timeout for big exports.

### 12. Annotations — dev-handoff (2)

> INCLUDED (grafted from the coverage lens). **VERIFICATION:** the working fork (the implementation reference) fully implements these — `figma.annotations.getAnnotationCategoriesAsync()` (code.js:3228) and read/write of `node.annotations` (code.js:3284-3404, write shape `node.annotations = [{ labelMarkdown, categoryId?, properties? }]`). The capability ceiling doc omits them, but it is a curated subset that also omits `getNodeByIdAsync`/`importComponentByKeyAsync`/`findAllWithCriteria` the shipped plugin uses — so its silence is not disqualifying. Both tools are isolated (own commands, `editorType`-gated) and add no risk to the core surface.

#### `get_annotations` [new, fix F10]
- `nodeId?: string` (omit → scan current page) → `{ categories: [{ id, label, color }], annotations: [{ nodeId, name, annotations: [{ labelMarkdown, categoryId?, properties? }] }] }` · **API:** `figma.annotations.getAnnotationCategoriesAsync()` + read `node.annotations`. New plugin command `get_annotations`. · *Round-trips with `set_annotation` (read shape == write shape).*

#### `set_annotation` [new, fix F10]
- `nodeId: string`; `labelMarkdown: string`; `categoryId?: string`; `properties?: [{ type: string }]` → `{ id, name, type, annotations }` · **API:** `node.annotations = [{ labelMarkdown, categoryId?, properties? }]` (overwrite). New plugin command `set_annotation`.

---

## NodeSpec / ParsedNode (the shared vocabulary)

`create_node`/`create_tree` input, `update_node.props` (as `Partial`), and `get_node` output all use one schema (`packages/shared/src/create-schemas.ts` `nodeSpecSchema`, mirrored in `create-types.ts`). The shipped schema is reused verbatim. **Two read-side adjustments are required for true round-trip** (both in scope — see Resolved decisions #3 and #4):

1. **`get_node` must emit `component.key` for INSTANCE nodes.** The read shape is currently `component: { name, id, variant?, overrides? }` (expression-formats.md:320-325) with NO `key`, while the write side (`createComponentRefSchema`, create-schemas.ts:92) requires `{ key, properties? }`. Without this, INSTANCE round-trip is impossible. Touches the plugin's `get_node` serializer + the `ParsedNode` type.
2. **`constraints` should be added to the write-side NodeSpec.** `ParsedNode` already emits `constraints` (expression-formats.md:289) but `nodeSpecSchema` does not accept it — so constraints currently read but cannot be written back. Adding it restores symmetry. (This corrects the coverage proposal's inverted rationale.)

No `ranges[]` field is added to `NodeSpec.text` — range styling lives in the dedicated `set_text_ranges` tool (write-only this phase). No other new NodeSpec fields are added (`layoutGrids`/`exportSettings`/per-side stroke weights deferred until `get_node` emits them).

## Expression grammar

Reused verbatim from `docs/specs/expression-formats.md` + `expression-parser.ts`. Colors `#RRGGBB`/`#RRGGBBAA` (6/8-char uppercase, no shorthand — commit 8d9a299); `style(Name)`/`var(Coll/Name)` prefixes; gradients linear|radial|angular|diamond; effects shadow/inner-shadow/blur/bg-blur; font `Family/Style/Size`; layout YAML. Server parses → Figma objects BEFORE `sendCommand`; the plugin only assigns. (One open extension: the `create_styles` text-value `/LineHeight`+`?ls=` suffix — see Resolved decisions.)

---

## Explicitly cut / deferred

### CUT (do not build)
- **All 32 `batch_*` twins** (`batch_create_page`, `batch_export`, `batch_update_node`, `batch_set_fills`, `batch_set_strokes`, `batch_set_effects`, `batch_set_position`, `batch_resize_nodes`, `batch_set_text_content`, `batch_reparent_nodes`, `batch_reorder_children`, `batch_clone_nodes`, `batch_delete_nodes`, `batch_apply_style`, `batch_bind_variable`, `batch_create_component`, `batch_update_component`, `batch_combine_variants`, `batch_swap_component`, `batch_detach_instance`, `batch_reset_instance`, `batch_set_instance_properties`, `batch_group_nodes`, `batch_ungroup_node`, `batch_flatten_node`, `batch_create_from_svg`, `batch_create_slice`, `batch_create_text_path`, `batch_transform_group`, `batch_read_reactions`, `batch_set_reactions`, `batch_create_variables`). One generic `batch` tool (fork F-A) **replaces** all of them — it applies a single operation across many targets. Legitimate non-twin array envelopes also survive: `create_tree`, `create_styles`, `create_variables`, `get_nodes`.
- **Redundant readers:** `inspect_styles`, `inspect_components`, `inspect_variables`, `get_style_by_id`, `get_variable_by_id` — absorbed into the three `get_local_*` readers (id/type filters).
- **`move_node`** — parentId branch == `reparent_node`; index branch == `reorder_children`.
- **`create_image`** — image fills already work via the `image(url)` expression.

### DEFER (later phase — listed, not built)
- **Prototyping** (`read_reactions`/`set_reactions`) — `node.setReactionsAsync` exists in the reference, but the `Reaction` input shape (trigger/action/transition) must be validated against the real SDK first (brief fix #9). Read shape must equal write shape for round-trip.
- **`group_nodes`/`ungroup_node`/`flatten_node`** — vector/structure niche (creation-side GROUP/BOOLEAN_OPERATION already covered by `create_tree`).
- **`create_slice`, `create_text_path`, `transform_group`** — `transform_group` needs a validated `modifiers` schema; the others are export/path niche.
- **`duplicate_styles`** — achievable via `get_local_styles` → `create_styles`.
- **NodeSpec field expansion** beyond the in-scope fixes (`exportSettings`, per-side stroke weights) — defer until `get_node` emits them.
- **`grid` (layout grids on a node)** — read-only this phase (already emitted on read; write deferred — documented asymmetry, see Finalized decisions).
- **Remote/library styles & variables** — LOCAL only this phase; `importStyleByKeyAsync`/`importVariableByKeyAsync` deferred (stated asymmetry vs components, which support remote).
- **Boolean / group ops on existing nodes** — deferred, but flagged the #1 next-phase candidate (recreating positioned nodes via `create_tree` is lossy).

## Coverage summary
- **45 tools** = 15 shipped (KEEP/FIX) + ~30 net-new/refit (incl. the generic `batch` tool). Within the brief's 35–46 target.
- Every read has a symmetric write; every write maps to a real `figma.*` API confirmed in the plugin code or working fork. Verified-real-but-not-in-the-reference-doc: `listAvailableFontsAsync`, `setRangeFontName`, `figma.annotations.getAnnotationCategoriesAsync` + `node.annotations`. Real-but-unverified-in-repo (flagged): `setBoundVariableForPaint`, the non-font `setRange*` family.
- Round-trip pairs: `get_node`↔`create_node`/`update_node` (requires INSTANCE `component.key` read-side fix); `get_nodes`↔`create_tree`; `get_local_styles`↔`create_styles`/`update_styles`; `get_local_variables`↔`create_variables`/`update_variables`; `get_local_components`↔`create_component`/`update_component`; `get_selection`↔`set_selection`; `get_annotations`↔`set_annotation`. Write-only this phase (documented asymmetry): `set_text_ranges` (no `getStyledTextSegments` for read-back).