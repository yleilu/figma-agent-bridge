---
title: Tool-Surface Harvest Brief (input to API design panel)
created: 2026-06-22T15:00:00+08:00
tags: [figma-bridge, mcp, tool-surface, autoresearch, harvest, m4]
type: reference
---

# Tool-Surface Harvest Brief

Input brief for authoring the new figma-agent-bridge MCP tool surface. This is the
**decision set** distilled from reviewing the autoresearch R36 spec (94 tools) down to
a lean, feasible "trimmed + fixed" surface. Authors MUST honor these dispositions and
fixes. For exact param shapes, authors should also read the source files listed at the end.

## Scope decision

- **Goal:** harvest the genuinely-useful subset of the R36 spec, drop the metric-gaming
  bloat, and bake in the feasibility fixes. Target a lean, coherent surface (~35–46 tools).
- The R36 spec over-built to game a quadratic cohesion score: ~32 `batch_*` twins +
  redundant readers. Those are CUT.
- Several endgame tools were built on a hallucinated API (`figma.getLocalComponents()`)
  or a false limitation (claiming `importComponentByKeyAsync` is unsupported when the
  project's own plugin uses it). Those are FIXED.

## Cross-cutting fixes (apply everywhere)

1. **Node resolution** → always `figma.getNodeByIdAsync(id)` (no sync `getNodeById` in this sandbox).
2. **Component-by-key resolution** → `await figma.importComponentByKeyAsync(key)` (remote-capable;
   already used in shipped plugin). For local enumeration use `figma.root.findAllWithCriteria({types:['COMPONENT']})`/`['COMPONENT_SET']`. The `getLocalComponents()` API does **not** exist.
3. **swap_component** supports REMOTE/library components (remove the false "local-only" limitation).
4. **createSlot** is feature-detected: `if (component.createSlot) {...} else surface a warning` (shipped degrade behavior). Add component properties BEFORE slots.
5. **Styles read/write** → use Async forms (`getLocalPaintStylesAsync`, `getStyleByIdAsync`, `node.setFillStyleIdAsync`) so remote/library styles resolve.
6. **Variables** → `figma.variables.getLocalVariablesAsync`/`getLocalVariableCollectionsAsync`/`getVariableByIdAsync`/`getVariableCollectionByIdAsync`.
7. **bind_variable** → fills/strokes use `figma.variables.setBoundVariableForPaint`; scalar fields (opacity/strokeWeight/spacing/padding/radius) use `node.setBoundVariable(field, variable)`.
8. **Text writes** → `await figma.loadFontAsync(fontName)` BEFORE setting characters/font; handle `figma.mixed` fontName (load all range fonts or reject). Set `textAutoResize` before `resize`.
9. **set_reactions / transform_group** → input shapes must be VALIDATED against the real SDK before shipping (deferred for now).
10. **editorType gating**: design-only APIs (components/styles/variables/slots) guard for non-Figma editors.

## IMPLEMENT (KEEP + FIX) — the build set (~46 tools; 15 already shipped → ~31 net-new)

Connection / session:
- **connect** (shipped, KEEP) — WebSocket pairing.
- **status** (shipped, KEEP) — connection state.

Read / query (one machine `get_*` + one human `inspect` per primitive):
- **inspect** (shipped, KEEP·fix async) — human YAML of a node/selection.
- **inspect_page_layout** (shipped, KEEP) — current-page frame overview.
- **get_node** (shipped, FIX async) — machine NodeSpec read (round-trip with create_node).
- **get_nodes** (shipped, FIX async) — multi-id read primitive (NOT a batch twin).
- **get_page_nodes** (FIX) — top-level children of any page by id (no page switch).
- **list_pages** (shipped, KEEP) — enumerate pages.
- **get_document_info** (shipped, KEEP) — doc metadata + pages + current page.
- **get_selection** (shipped, KEEP) — read current selection.
- **search** (shipped, FIX) — document-wide node finder (guard `figma.mixed` styleId).
- **find_children** (FIX) — subtree-scoped finder (node.findAll on resolved root).
- **get_local_components** (shipped, FIX) — machine component reader; supplies keys; use `root.findAllWithCriteria`. (Absorbs inspect_components.)
- **get_local_styles** (FIX) — single machine style reader with optional `id` + `type` filter and resolved expression values. (Absorbs inspect_styles + get_style_by_id.)
- **get_local_variables** (FIX) — single machine variable reader, collection-grouped, mode-resolved, optional `collectionId`/`type`/`id` filters. (Absorbs inspect_variables + get_variable_by_id.)

Pages / navigation:
- **create_page** (KEEP) — `figma.createPage()` + optional set current.
- **set_current_page** (FIX) — navigate by pageId or name.

Create:
- **create_node** (shipped, FIX) — single node any type; INSTANCE via importComponentByKeyAsync.
- **create_tree** (shipped, FIX) — recursive hierarchy + sibling-array form (legitimate built-in batch-create envelope); same INSTANCE fix; keep 4-phase FILL/appendChild ordering.
- **create_from_svg** (shipped, FIX) — `createNodeFromSvg`.

Mutation / update (the biggest current gap — surface has ZERO of these today):
- **update_node** (FIX) — central single-target mutation; accepts Partial<NodeSpec>; loadFont before TEXT; DROP nested instance-override branch (route via set_instance_properties); guard mixed/styleId.
- **set_fills** (FIX) — node.fills via color expressions.
- **set_strokes** (FIX) — node.strokes via color expressions.
- **set_effects** (FIX) — node.effects via effect expressions.
- **set_text_content** (FIX) — loadFont then node.characters; handle mixed fonts.
- **set_position** (FIX) — node.x/y (document auto-layout no-op caveat).
- **resize_node** (FIX) — node.resize(w,h); textAutoResize-before-resize for TEXT.
- **delete_node** (FIX) — node.remove() (works on pages too).
- **clone_node** (FIX) — node.clone() with optional reparent + count.

Structure (ONE reparent path + ONE reorder path; move_node CUT):
- **reparent_node** (FIX) — appendChild/insertChild to a new parent.
- **reorder_children** (FIX) — sequential insertChild within a parent.
- **set_selection** (FIX) — set currentPage.selection.

Components & instances (ONE instance-override path):
- **create_component** (shipped, FIX) — promote node + properties + slots (slot fallback).
- **update_component** (FIX) — edit/delete/add component properties (round-trips create_component).
- **combine_variants** (FIX) — combineAsVariants (≥2 components rule).
- **swap_component** (FIX) — instance.swapComponent via importComponentByKeyAsync (remote-capable).
- **detach_instance** (FIX) — instance.detachInstance().
- **reset_instance** (FIX) — instance.resetOverrides().
- **set_instance_properties** (FIX) — instance.setProperties() (the single override path).

Styles (authoring):
- **create_styles** (KEEP) — create paint/text/effect/grid styles (array envelope, not a twin).
- **update_styles** (FIX) — update by id or name+type.
- **apply_style** (FIX) — apply style id to a node slot (prefer setXStyleIdAsync).

Variables (authoring):
- **create_variables** (KEEP) — collection + variables + per-mode values (array envelope).
- **update_variables** (FIX) — update per-mode values.
- **bind_variable** (FIX) — bind variable to a node field (paint vs scalar paths).

Export:
- **export** (shipped, FIX) — node.exportAsync PNG/SVG/PDF/JPG; pass larger timeout for big exports.

## ADD (gap tools surfaced by critique — include in the proposal)

- **list_fonts** — `figma.listAvailableFontsAsync()` → families/styles. Agents currently guess font names and fail at write time. High value, low cost.
- **Text range styling** — either a `ranges[]` field on text writes or a dedicated `set_text_ranges` tool (setRange* APIs) so substrings can be styled. Decide which.
- **(Optional) annotations** — `get_annotations`/`set_annotation` if dev-handoff is in scope; otherwise explicitly note the omission.

## DEFER (later phase — list as deferred, do not build now)

prototyping (`read_reactions`/`set_reactions` — needs Reaction shape validation),
`group_nodes`/`ungroup_node`/`flatten_node` (vector/structure niche),
`create_image` (image fills already work via `image(url)` expression),
`create_slice`, `create_text_path`, `transform_group` (needs modifiers schema),
`duplicate_styles` (achievable via get_local_styles → create_styles).

## CUT (do NOT build)

- All 32 `batch_*` twins. A future single generic batch envelope can wrap `update_node` etc. if real usage demands it. Legitimate non-twin array envelopes survive: create_tree, create_styles, create_variables, get_nodes.
- Redundant readers: inspect_styles, inspect_components, inspect_variables, get_style_by_id, get_variable_by_id.
- move_node (parentId branch == reparent_node; index branch == reorder_children).

## Redundancy collapses (rationale)

- Styles read: inspect_styles + get_local_styles + get_style_by_id → **get_local_styles** (id+type filters).
- Variables read: inspect_variables + get_local_variables + get_variable_by_id → **get_local_variables**.
- Components read: inspect_components + get_local_components → **get_local_components**.
- Node read: keep BOTH get_node (machine) + inspect (human); get_nodes is the multi-id primitive.
- Reparent/reorder/move: → **reparent_node** + **reorder_children** (move_node cut).
- Instance override: set_instance_properties (flat) over update_node nested props.

## Codebase conventions (a new tool spans 3 layers — all must be touched)

1. **Shared schema** (`packages/shared/src/schemas.ts` read / `create-schemas.ts` create):
   export `<name>ParamsSchema = z.object({...})`; every field `.describe('...')`;
   `.optional()`/`.default()`; `z.enum([...])`; numeric pairs `z.tuple([z.number(),z.number()])`;
   recursive via `z.lazy`. Cross-field validation lives in the HANDLER, not the schema
   (commit 39832e0). Hand-written matching TS type in `create-types.ts`. Re-export via
   `packages/shared/src/index.ts`.
2. **Server handler** (`packages/server/src/tools/<group>.ts`):
   `export const handleX = async (params, client: FigmaClient): Promise<ToolResult>`
   where `type ToolResult = { content: { type:'text'; text:string }[] }` (re-declared locally).
   Order: input cross-validation → `if (!client.isConnected()) return notConnectedText` →
   convert expressions server-side → `const result = await client.sendCommand('<plugin_command>', {...}) ` →
   `if (result === null) failure` → `if (result.error !== undefined) errorText` → success
   (`JSON.stringify(result,null,2)` for writes; parser/YAML formatter for reads).
   Register in `index.ts`: `server.tool(name, schema.shape, async (p) => handleX(p, client))`.
   Note: plugin command string may differ from tool name (tool `inspect` → command `get_node`).
3. **Plugin case** (`packages/figma-plugin/src/code.ts` — `handleCommand` switch):
   add `case '<command>': { ... }`; resolve nodes via `await figma.getNodeByIdAsync`;
   return `{ error }` on bad input (or throw — it's wrapped to `{error}`); return plain
   serializable objects only (`{id,name,type,...}`, never node refs); feature-detect with
   `'<prop>' in node`; `applyCommonProperties` BEFORE appendChild, `applyPostAppendProperties`
   (sizing/layoutPositioning) AFTER. Do not modify the `figma.ui.onmessage` bridge.

**Transport:** `client.sendCommand(command, params?, timeoutMs=30000)` — UUID-keyed promise,
rejects if not connected/in channel; pass larger timeout for long ops.

**Expression formats are the backbone — REUSE, never reinvent** (`expression-parser.ts`,
`docs/expression-formats.md`): colors `#RRGGBB`/`#RRGGBBAA` (6/8 char uppercase, no shorthand —
commit 8d9a299), `style(name)`/`var(name)` prefixes, gradients linear|radial|angular|diamond,
effects shadow/inner-shadow/blur/bg-blur, font `Family/Style/Size`, layout YAML. The server
parses expressions → Figma objects BEFORE sendCommand; the plugin just assigns.

**Round-trip contract:** create_node/create_tree input spec is structurally identical to
get_node output (ParsedNode == CreateNodeSpec). Preserve this symmetry for any new read/write pair.

## Source files to consult for exact shapes

- `/Users/lei/wip/figma-bridge/.claude/worktrees/tool-surface-autoresearch/docs/tool-surface.md` (R36 spec — mine its param shapes, ignore the bloat/hallucinations)
- `/Users/lei/wip/figma-bridge/docs/expression-formats.md` (canonical expression grammar + ParsedNode type)
- `/Users/lei/wip/figma-bridge/packages/shared/src/create-schemas.ts`, `create-types.ts`, `schemas.ts`
- `/Users/lei/wip/figma-bridge/packages/server/src/tools/*` (handler patterns)
- `/Users/lei/wip/figma-bridge/packages/figma-plugin/src/code.ts` (plugin command patterns)
- `/Users/lei/wip/figma-bridge/docs/figma-plugin-api-reference.md` (capability ceiling)
