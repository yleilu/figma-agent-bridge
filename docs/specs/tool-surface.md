---
title: figma-agent-bridge — Tool Surface Spec
created: 2026-06-26T19:00:00+08:00
tags:
  - spec
  - figma-bridge
  - tool-surface
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
  - "[[figma-bridge/docs/milestones/README]]"
---

# figma-agent-bridge — Tool Surface

> **Status — spec of record.** This is the shipped **47-tool** surface (M1–M3, on
> `dev`) — the contract of record for the MCP tool layer. The implementation matches
> it: server handlers in `packages/server/src/tools/*`, param schemas in
> `packages/shared/src/tool-params.ts`, plugin commands in
> `packages/figma-plugin/src/code.ts`. Governed by `docs/principles.md` (T1–T10, B1,
> P1).

> The tool layer only — opinions (design-system-first, audit verdicts, layout
> inference) are skill-layer (P1) and deliberately absent.

## Overview

The surface is **47 tools**: read/write pairs over five concept groups (session, nodes,
structure, design-system, handoff) **+ one generic `batch`**. It is the lean facade base plus
the capabilities the coverage verify pass proved were over-deferred — reactions,
boolean/flatten, image fill, plugin-data, page tools, variable-mode lifecycle, viewport focus.
Not the 56-tool dump: every tool maps to one distinct `figma.*` capability, no convenience
aliases.

How it embodies the six principles:

1. **Agent-first** — one value grammar learned once (T8); reads default to the compact lossy view so a whole tree fits the context budget (T4); ids returned by every read feed straight into writes.
2. **Symmetric & round-trippable** — one canonical name per concept; every *editable* concept has a read+write path, and the few read-only tools are **deliberate, documented** asymmetries (T2 — see *Deliberate read-only tools*). The **edit** read (`get_node`) writes straight back through `create_node`/`update_node` losslessly (T1, T2).
3. **Inspect ≠ edit** — **two separate node readers**: `inspect` (compact view, lossy, scan many) and `get_node` (faithful edit form, round-trips, one node to change). No mode flag — the split is in the principle (T3), so it is in the surface.
4. **Reading is bounded by default — one rule per output shape, learned once** — every list/scan read is **bounded** (T10): **list reads** all share one shape (`{results, truncated, cursor?}` — a default `limit`, a `truncated` flag, and an **opaque cursor** to continue when cut); **tree reads** all share **depth + budget + truncation-receipt** drill-by-id (with `get_node` the fidelity-first exception below); `fields`/`profile` projection + `match` filter apply where the shape allows. The same contract holds across *every* API of that shape — never per-API (T1, T4, T10).
5. **Figma-native composition effortless** — components (props/variants/slots), auto-layout (the `layout` struct of every node spec), and design-system (styles/variables/binding) are first-class and no harder than the naive literal path (T9). Tool makes it easy; skill prefers it (P1).
6. **Writes composable & honest** — `create_tree` nests, `clone_node` clones, ref-pool reuses; one generic `batch` (agent's choice); feature-detect + degrade (slots, paint-binding, annotations, reactions, expose); warn on silent no-ops (e.g. x/y on an auto-layout child).

## Read model

### Inspect vs edit (two tools, T3)

| Tool | Format | Lossy? | Round-trips? | Use |
|---|---|---|---|---|
| `inspect` | view (compact YAML, atoms+structs) | yes | no | understand large trees within the context budget |
| `get_node` | edit (faithful `NodeSpec`) | no | yes → `create_node`/`update_node` | fetch a node to change it |

Separate tools, not one tool with a `format` flag — different jobs, different defaults, and a
separate name makes intent explicit and the round-trip contract auditable. A view stub at a
depth boundary keeps its `id`, so drilling deep = re-`inspect` that id.

### The two reading rules (D1 — one rule per output shape, applied to every API of that shape)

**Rule A — every list-returning read is bounded (T10) → one uniform `{results, truncated, cursor?}`
shape.** Any read returning a **flat list** (`search`, `list_pages`, `get_styles`,
`get_variables`, `get_components`, `list_fonts`, `get_reactions`, `get_annotations`) is **bounded
by default**: a default **`limit`** caps how many results one call returns, a **`truncated`** flag
says whether more remain, and an **opaque `cursor`** continues from where it left off. The contract
is **uniform** so the agent learns one list shape everywhere — and *no* list read can flood the
agent's context or run an O(document) scan to completion in one call (T10).

Pagination is carried by **the same opaque, self-contained cursor token on every list read**: the
agent passes the token back verbatim to continue the *same* query; the token encodes the resume
position + a tree-version hash, so if the data changed under it the server says **re-query** rather
than returning garbage (T7). No offset, no client-tracked position. A read returns `cursor` (and
`truncated: true`) only when results exceeded `limit`; otherwise `{ truncated: false }` and no
cursor. `search` — the finder most likely to outgrow a response — has always carried cursor+limit;
under T10 the design-system and metadata list reads
(`get_styles`/`get_variables`/`get_components`/`list_fonts`/`get_reactions`/`get_annotations`,
plus `list_pages`) now carry the **same** cursor+limit contract.

> **Re-alignment, not a new divergence.** Re-introducing the cursor on the bounded list reads
> restores the **original Rule-A** contract (every list read bounded with a continuation handle).
> An earlier reconciliation had dropped the cursor from the naturally-bounded readers as an
> "improvement" (treating them as small-by-construction, `{ truncated: false }`, no cursor); T10
> reverses that — "small by construction" is an assumption, not a bound, and the one read it failed
> on was caught live (see `get_components` below). The cursor is back on every list read, which is
> exactly what Rule-A specified.

**Rule B — tree reads → depth + budget + receipt (already bounded, T10).** Any read returning a
**node tree** (`inspect`, page reads) is **already bounded** by its own mechanism — depth caps the
levels, an always-on budget caps response size, and the truncation receipt names what was cut — so
it satisfies T10 **without a cursor** (the continuation handle is drill-by-id, not a page token).
Tree reads are shaped by:
- **`depth`** — level cap; `-1` = all. At the boundary a node collapses to an **id-stub**
  `{id, name, type, size, childCount}` — the agent **drills by re-reading the stub's id**.
- **`budget`** — always-on hard cap on response size (token estimate). Even a wide level at
  shallow depth can't blow context.
- **truncation receipt** — `truncated: [{id, childCount}]` names exactly which subtrees were
  cut and how big, so "continue" = "drill into id X" (the drill-by-id replacement for a cursor).
- **wide nodes narrow, don't paginate** — a node with hundreds of children returns a capped
  chunk + `childCount`; the agent gets the specific ones via `search` (`match`),
  not a page scan.

**`get_node`/`get_nodes` are the fidelity exception (T2).** As the edit readers they are
**never silently budget-truncated** — they return the node's complete faithful spec at the
requested `depth` (default 0 = just that node; deeper children are id-stubs that themselves
round-trip via drill-by-id). They take only the **reduced** read params (`depth`, `fields`,
`profile`) — **no `budget`, no `match`** (a budget-capped edit read would break round-trip; the
edit reader returns the faithful spec, it does not filter at the source). For a large subtree
the agent raises `depth` deliberately; the read never drops a field behind the agent's back. They
still satisfy T10: the default `depth=0` bounds the call to a single node, deeper children are
id-stubs, and breadth is the agent's explicit choice — no unbounded scan, so no cursor.

**Projection (D2), on any node-returning read** — `fields: [...]` allow-list (precise
token-saver) **+ presets** `profile: "minimal"|"layout"|"style"|"text"|"full"` for common
scans. No deny-list (it grows silently as the grammar grows, a T4 regression).

**`match` filter, on list/tree node reads (`inspect`/`search`)** — `{name?, regex?, type?(value|array), componentKey?, styleId?, variableId?, instancesOf?}` filters at the source. `type` accepts an array (multi-type in one pass). The fidelity readers (`get_node`/`get_nodes`) carry no `match`.

### Defaults by job (D4)

- **`get_node`/`get_nodes`** → `depth=0` (the node you'll edit; children as id-stubs). `depth=-1` for a full subtree to round-trip; fidelity-first (no budget truncation).
- **`inspect`** →
  - **`budget` given** → fill **level-by-level** (breadth-first) until the budget is hit, then stub the rest + receipt. Budget drives depth adaptively.
  - **no budget, no depth** → `depth=0` (minimal: node + child stubs).
  - **`depth=-1`** → print all (explicit "dangerous" opt-in).
  - explicit `depth=n` → exactly n levels (still budget-capped).

### Deliberate read-only tools (documented asymmetry, T2)

Not every read has a same-named write twin — and that is deliberate, not silent:
- `inspect` / `get_node` / `get_nodes` / `search` — query/projection reads; their write side is `create_node`/`update_node` (round-trip by **content**, not a same-named twin).
- `list_fonts` — fonts are host-provided, not agent-created.
- `status` / `connect` — session/transport (B1), not design data.
- `export` — render/asset output (image/SVG), not a writable design field; read-only by nature.
- Viewport is read via `status` and written via `set_focus`.
- Twinned reads (do have a writer): `get_selection`↔`set_selection`, `get_styles`↔`create/update_styles`, `get_variables`↔`create/update_variables`, `get_components`↔`create/update_component`, `get_annotations`↔`set_annotations`, `get_reactions`↔`set_reactions`, `get_plugin_data`↔`set_plugin_data`, `list_pages`↔`create_page`/`set_current_page`.

### Read tools at a glance

`inspect` · `get_node` · `get_nodes` · `export` · `search` · `list_pages` · `get_selection`
· `get_styles` · `get_variables` · `get_components` · `list_fonts` · `get_reactions` ·
`get_plugin_data`. Trees follow Rule B (depth/budget/receipt); lists follow Rule A (bounded by T10 — default `limit` + `truncated` + opaque `cursor`); node-returning reads honor `fields`/`profile` (+ `match` on `inspect`/`search`).

## Write model

### Create / update

- **`create_node(spec, {parentId?})`** — one node; `spec` === `get_node` output (round-trip anchor, T2). Appends under `parentId`, else the current page.
- **`create_tree(tree, {parentId?, refs?})`** — recursive + sibling-array create; the legitimate batch-create envelope (one round-trip for a subtree, T5). **ref-pool**: repeated instances/clones reference a shared spec by key; `{ id }` clone-by-id is also supported in the tree.
- **`create_from_svg(parentId, svg, {name?, size?})`** — vector import.
- **`create_image({url|bytes}) → {hash}`** — server-side `createImageAsync`/`createImage`; the hash flows into an `image(hash)` paint (image fill decision below). Supply EXACTLY ONE of `url` or `bytes` (the handler validates).
- **`update_node(nodeId, patch)`** — THE single-target mutation. `patch` is a **partial NodeSpec**: a **supplied** field is **replaced wholesale** (`fills=` overwrites the whole array, never appends); an **omitted** field is **left untouched** — reconciling lossless writes (T2) with partial/token-efficient input (T4). Absorbs every former setter (`set_fills`, `set_strokes`, `set_text_content`, `set_position`, `resize_node`, …) — T6: one mutation vocabulary, no twins.

### The one generic batch (D3 — both shapes, one tool, T5)

```
batch({ op?, ops: [ {op?, ...params}, ... ] }) -> { results, errors[] }
```
- **Homogeneous** (common, token-cheap): set `op` once at top level; entries omit it.
- **Heterogeneous**: each entry sets its own `op` (overrides the default).
- Executes **in array order**; **partial success** (each entry reports its own error);
  **best-effort, not transactional** (Figma has no multi-step rollback — only `commitUndo`).
- Returns `{ results:[{index, op, ok, result|error}], errors:[{index, op, error}] }`.
- **Ordering scope:** the server's ordering guarantees (below) apply **within a single op's
  param set**; across batch entries, ops run in array order, so cross-entry dependencies
  (append before FILL) are the agent's to sequence. Each entry emits the same `warnings[]` as
  a single call (T7).
- **Scope is WRITE ops over EXISTING targets** (D3). New-node creation (`create_node`,
  `create_tree`, `create_from_svg`, `create_image`, `create_component`) is deliberately
  **excluded** — chaining new nodes stays `create_tree`'s job (ref-pool). The fan-out op set:
  `update_node`, `delete_node`, `set_selection`, `set_focus`, `reparent_node`,
  `reorder_children`, `clone_node`, `boolean_op`, `flatten`, `apply_style`,
  `update_component`, `combine_variants`, `swap_component`, `set_instance`, `bind_variable`,
  `create_styles`, `update_styles`, `create_variables`, `update_variables`, `set_plugin_data`,
  `set_reactions`, `set_annotations`, `create_page`, `set_current_page`, `duplicate_page`.

Family-specific array envelopes (`create_tree`, `get_nodes`, `create_styles`,
`create_variables`) create a coherent unit and stay distinct from the generic `batch`
(N ops over existing targets).

### Ordering constraints (load-bearing, enforced server-side within one op)

- Set `layoutSizing:FILL` / `layoutPositioning:ABSOLUTE` only **after** `appendChild` to an auto-layout parent → the server orders the property sets within one call.
- `loadFontAsync` resolves **before** any `text.content`/`font` write → the server loads first.
- `textAutoResize` set before `resize()`.

### Honesty / warn-on-no-op (T7)

- Feature-detected + degraded: slots (`create_component`), paint variable-binding (`bind_variable`), annotations (editorType-gated), reactions, expose-nested-prop, `swap_component` remote `key` import. Each **warns and continues** — emits a `warnings[]` entry naming what was skipped, never a silent no-op or a hallucinated success.
- **Warn on silent no-op**: x/y on an auto-layout child → `warnings[]` entry naming the dropped field; same for `reorder_children` set-equality and overrides surviving a `swap_component`.

## Expression integration

One grammar, two faces (T8, expression-formats.md):

- **Reads emit the view face.** `inspect` renders **structs as YAML** (`node`, `layout`, `text`, `css-grid`) and every leaf as **one atom** — `[style(N)|var(N)] value [{…}]` — so binding *and* appearance ride in one token-cheap string.
- **Writes consume the edit face.** `create_node`/`update_node`/`create_tree` take the same `NodeSpec` + atom grammar; the write parser also accepts friendlier notations (`rgb()`, `rgba()`) the view never emits. View is the lossy subset of edit.
- **Image fills (both — two capabilities not two paths):** a paint atom **`image(url|hash){scale?,rot?,…}`** sits in `fills[]` alongside `solid`/`linear`/…; on write `image(url)` makes the hash server-side (deduped by URL), `image(hash)` reuses one; reads emit `image(hash)` (round-trips). **`create_image`** is the *only* path for **raw bytes** and for **pre-creating a reusable hash**; `image(url)` is inline sugar for the URL case.
- **The one documented asymmetry (T2):** `var()` is read-only this phase — on write it resolves to a literal; binding is applied through **`bind_variable`**. Named here and in the grammar doc.
- **Styles vs variables routing:** `apply_style` binds a *style* id; `bind_variable` binds a *variable*. Both surface on reads as `style(...)`/`var(...)` so the route is visible on read-back.

## Tool catalogue

Format: `name(params) → returns` — purpose · principle/checklist need.

**Count = 47** (auditable per group): Session 2 · Read-nodes 4 · Read-query 3 · Read-DS 4 · Read-meta 2 · Write-nodes 5 · Write-structure 8 · Write-pages 3 · Write-components 5 · Write-DS 6 · Write-meta 2 · Handoff 2 · Batch 1 = **47**.

### Session (2)
- `connect(channel) → {channel, connected}` — pair MCP server to the Figma plugin · B1; §2 connect.
- `status() → {connected, channel, currentPage, selection[], viewport}` — connection + live context in one read (live context is best-effort; failures degrade, they don't throw) · B1, T4; §2 read-what-user-sees.

### Read — nodes (4)
- `inspect({nodeId?, pageId?, depth?, budget?, fields?, profile?, match?}) → {view, truncated[]}` — compact lossy view, drill-by-id (Rule B); omit both ids to inspect the current selection (multi-select returns a `SELECTION` forest) · **T3 inspect**, T4; §1 human view, §3 deep/large trees, §13 CSS-handoff data.
- `get_node(nodeId, {depth?=0, fields?, profile?}) → NodeSpec` — faithful edit form, round-trips; **fidelity-first, never budget-truncated**, **no budget/match** (children past `depth` are id-stubs that round-trip via drill-by-id). `NodeSpec` carries `layoutPositioning`, instance `componentProperties`/`variantProperties`/`overrides` — so override-reads (§6/§11) and the §7 absolute-positioning audit ride on this read · **T3 edit**, T2; §1 read-exact-to-write, §6 instance overrides.
- `get_nodes(nodeIds[], {depth?, fields?, profile?}) → {results, errors[]}` — multi-id read (faithful spec per id; same reduced params + fidelity-first contract as `get_node`) · T4, T5; §1 read-many.
- `export(nodeId, {format?, scale?}) → image|svg-text` — render-to-see + one-off asset export (`format`: PNG|JPG|SVG|PDF, default PNG; `scale` ignored for SVG/PDF) · T6; §1 visual-confirm, §13 export-assets. *(Persistent `exportSettings` is a `NodeSpec` field — round-trips via `get_node`/`update_node`.)*

### Read — query & document (3)
- `search({scope?, pageId?, nodeId?, depth?, match?, cursor?, limit?=100, fields?, profile?}) → {results, truncated, cursor?}` — the one finder (`scope`: document(default)|page|node|selection; `match` incl. `type` array, `instancesOf`, `styleId`/`variableId`); `depth` bounds the **scan scope** (how deep the plugin traverses each root: -1/omitted = whole subtree, 0 = roots only, N = N levels), results stay a flat list (Rule A, bounded by T10); `limit` defaults to **100**; `cursor` is the opaque pagination token (returned only when `truncated`); `fields` can project `characters` (text-copy inventory) · T1 (the one finder), T10; §4 all find + text inventory. 🟠 reverse-lookup returns only matching ids — any usage/orphan/audit interpretation is skill-layer (P1).
- `list_pages({cursor?, limit?=100}) → {docName, results:pages[{id,name,isCurrent,childCount}], truncated, cursor?}` — document + page enumeration (Rule A, bounded by T10; `limit` defaults to **100**, `cursor` continues when `truncated`) · T10; §2 list-pages.
- `get_selection() → [{id,name,type}]` — read selection; twin of `set_selection` · T2; §1 selection.

### Read — design system (4)
- `get_styles({type?, id?, cursor?, limit?=100}) → {results, truncated, cursor?}` — paint/text/effect/grid styles, resolved to grammar atoms (`results:[{id,name,type,value}]`); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated`) · T1, T10; §5 list-styles.
- `get_variables({collectionId?, cursor?, limit?=100}) → {results, truncated, cursor?}` — collection-grouped, mode-resolved, alias chains (`results:[{id,name,modes,variables[{id,name,type,valuesByMode,aliases,scopes,codeSyntax,hiddenFromPublishing}]}]`); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated`) · T10; §5 variables/tiers, §6 per-mode, §12 export-planning data.
- `get_components({query?, includeRemote?=false, cursor?, limit?=100}) → {results, truncated, cursor?}` — components/sets, keys, all 4 property types (unified `properties:[{id,name,type,defaultValue,variantOptions?}]` — same shape `update_component` writes), variant axes, defaults; Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated`); `query` is a case-insensitive name substring. **The expensive scan is gated, not paged (T10):** the O(document) **remote/library component discovery is opt-in** — `includeRemote` defaults to **false**, so by default only the cheap **local** component/set scan runs and `remote` is empty; set it `true` to also walk every instance's `mainComponent` to discover library/remote components. The `limit`/`cursor` pair then **pages the flattened (local ⧺ remote) list server-side** (same `paginateList` helper as every other bounded list read) so the agent context stays bounded; the cursor is best-effort over the session-stable list (version-stamped → STALE if the set changes under it). **Live-caught T10 violation:** the prior *always-on* remote discovery ran a document-wide all-instances scan (`findAllWithCriteria(['INSTANCE'])` resolving every remote main) that timed out on a real UI-kit document; making that scan opt-in (default off) is the fix — the local path no longer runs any instance scan. *(Future: a remote-component cache lets `includeRemote` answer without the O(document) scan.)* · T1, T10; §5 discover/variant-axes, §7 variant-count data (verdict skill).
- `list_fonts({query?, cursor?, limit?=100}) → {results, truncated, cursor?}` — loadable fonts so writes don't guess (`results:[{family,styles[]}]`); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated` — the host font list is large, so this read is genuinely paged); `query` filters family-name substring · T7, T10; §5 know-fonts.

### Read — node metadata & prototype (2 · restored)
- `get_plugin_data(nodeId, {namespace?}) → {nodeId, pluginData, sharedPluginData?, warnings?}` — agent metadata (plugin + shared namespaced); plain read (not a Rule-A list — it returns the data maps directly) · T2; §1 read agent-state.
- `get_reactions(nodeId, {cursor?, limit?=100}) → {results, truncated, cursor?, warnings?}` — prototype flow/wiring read; **Rule-A list envelope** (per D1 — uniform with every other list read, bounded by T10: `limit` defaults to **100**, `cursor` continues when `truncated`; `warnings` carry the T7 feature-detect degrade); twin of `set_reactions` · T2, T4, T7, T10; §13 read-prototype.

### Write — nodes (5)
- `create_node(spec, {parentId?}) → {id,name,type,…}` — create one node; `spec` === `get_node` output (round-trip anchor) · T2, T9; §8 build tasks.
- `create_tree(tree, {parentId?, refs?}) → {root, ids[]}` — recursive/sibling batch-create + ref-pool + `{id}` clone-by-id · T5, T9; §8 build screen/card/grid.
- `create_from_svg(parentId, svg, {name?, size?}) → {id,…}` — vector import · §8 add-icon.
- `create_image({url|bytes}) → {hash}` — the **only** path for raw bytes + pre-creating a reusable hash; its hash feeds an `image(hash)` paint (inline `image(url)` is sugar for the URL case); supply exactly one of `url`/`bytes` · T9; §8/§9 image fill.
- `update_node(nodeId, patch) → {id,…,warnings[]}` — the single mutation; `patch` is a partial NodeSpec (supplied field replaces wholesale, omitted untouched); warns on no-op · T1/T6, T7; §9 all restyle/bulk-edit, §8 ABSOLUTE/constraints, basic props (name/lock/visible/opacity/blend/rotation).

### Write — structure (8)
- `clone_node(nodeId, {parentId?, index?, count?}) → [{id,…}]` — raw duplication (one entry per clone) · T6; §10 duplicate, §8 grid.
- `delete_node(nodeId) → {id,name,type}` — page-aware remove (captures node info before removal) · §9 cleanup.
- `reparent_node(nodeId, parentId, {index?}) → {id,…,parentId}` — the one reparent path; re-flows under new parent · §10 move-into-frame.
- `reorder_children(parentId, nodeIds[]) → {parentId, order, warnings[]}` — set-equality validated; warns on mismatch (never throws) · T7; §10 reorder.
- `set_selection(nodeIds[]) → {selectedCount}` — twin of `get_selection`; **selection only** (does NOT scroll the canvas — pair with `set_focus`); empty array clears the selection · T2; §2.
- `set_focus(nodeIds[]) → {viewport}` — scroll + zoom the canvas to nodes (`figma.viewport.scrollAndZoomIntoView`); the viewport writer (`status` reads viewport); unresolvable ids are skipped · T7; §2 focus/scroll-to-node.
- `boolean_op(op, nodeIds[], {parentId?}) → {id,…}` — union/subtract/intersect/exclude → BooleanOperationNode (`op`: UNION|SUBTRACT|INTERSECT|EXCLUDE; ≥2 nodes; `parentId` defaults to the first node's parent) · T6; §10 combine-shapes (restored).
- `flatten(nodeIds[], {parentId?}) → {id,…}` — flatten to one vector (≥1 node; `parentId` defaults to the first node's parent) · T6; §10 flatten/icon-prep (restored).

### Write — pages (3 · restored)
- `create_page(name) → {id,name}` — new page; write twin of `list_pages` · §2 create-page.
- `set_current_page(pageId) → {currentPage}` — switch page (current-page write; naming exception to get_/set_, documented under D5) · T2; §2 switch-page.
- `duplicate_page(pageId, {name?}) → {id,name}` — `page.clone()` backup/variant · §2 backup-before-bulk-edit.

### Write — components & instances (5)
- `create_component(nodeId, {name?, description?}) → {id,key,…}` — **promote-only**: componentize an existing node via `createComponentFromNode()`, optionally rename / set description; slots/properties are added afterward via `update_component`. To build a node first, use `create_node`/`create_tree` then promote the returned id (no spec/parentId overload) · T7, T9; §11 componentize.
- `update_component(componentId, {add?, edit?, delete?, description?, expose?}) → {id, properties, warnings[]}` — add/edit/delete all 4 property types, set description, **expose nested-instance property (🟠: feature-detected; on unavailability emits a `warnings[]` entry naming the dropped expose, never a silent no-op, T7)**; returns `properties` in the unified `[{id,name,type,defaultValue,variantOptions?}]` shape (same as `get_components`); round-trips create_component · T2, T7; §11 add-properties/description/expose, slot lifecycle (gated).
- `combine_variants(componentIds[], {parentId?, name?}) → {id,key, warnings[]}` — combine ≥2 into a variant set; sole variant-combiner; warns if a variant name packs multiple axes into one property (e.g. `Style=PrimaryLarge`), nudging one-property-per-axis (T7/T9) · T6; §11 states/axes.
- `swap_component(instanceId, {mainComponentId?, key?}) → {id, warnings[]}` — point an instance at a different main; accepts EITHER a LOCAL `mainComponentId` (node id, resolved directly) OR a remote `key` (resolved via `importComponentByKeyAsync`, T7-gated — degrades with a warning if the import fails); if both are given the LOCAL `mainComponentId` wins; warns on dropped overrides · T7; §11 migrate/swap.
- `set_instance(instanceId, {properties?, overrides?}) → {id,…, warnings[]}` — the one instance-state path (set variant + BOOLEAN/TEXT/INSTANCE_SWAP via `setProperties`, plus per-node `overrides`); never auto-detaches; **read instance state via `get_node`** (NodeSpec `componentProperties`/`overrides` — the read twin); per-node `overrides` currently degrade with a warning (not yet applied) · T6, T9; §6/§11 configure + read-overrides.
- *(instance placement = `create_node`(INSTANCE) by key/id — no separate tool, T6.)*

### Write — design system (6)
- `create_styles([{type, name, value, description?}]) → {results, errors}` — array-create paint/text/effect/grid styles from grammar atom values; partial success (`results:[{id,key,name,type,index}]`, `errors:[{index,error}]`) · T5; §12.
- `update_styles([{id|name+type, value?, newName?, description?}]) → {results, errors}` — array-edit styles' parsed value/name/description; partial success (`results:[{id,index}]`, `errors:[{index,error}]`); round-trips get_styles · T2; §9 brand recolor.
- `apply_style(nodeId, styleId, field) → {id, warnings?}` — bind a style to a field (`field`: fill|stroke|text|effect|grid) · T9; §9/§12.
- `create_variables({collection, modes?, variables[]}) → {collectionId, modes, variables[{id,name}], warnings?}` — create a collection (+ optional extra modes) then its variables; each variable sets per-mode values + `aliases` + `scopes` + `codeSyntax` + `hiddenFromPublishing` on create (parity with update; each gated member feature-detect + T7-degrade) · T9; §12 3-tier/modes/scales/export.
- `update_variables({collectionId, addModes?, removeModes?, renameModes?:[{from,to}], variables?:[{id, valuesByMode?, scopes?, codeSyntax?, hiddenFromPublishing?}]}) → {collectionId, modes, warnings[]}` — **one collection**: full mode lifecycle (`addModes`/`removeModes`/`renameModes`) + per-variable value/scopes/codeSyntax/hiddenFromPublishing edits; round-trips get_variables. Returns `{…, warnings[]}` (T7 degrade), **not** `{results, errors}` — it's a single-collection op, not a heterogeneous batch · T2, T7; §9 recolor-by-token, §12 modes (restored: mode lifecycle).
- `bind_variable(nodeId, variableId, field) → {id,…,warnings[]}` — bind a variable to a field (scalar proven, paint feature-detected) + frame mode via `setExplicitVariableModeForCollection` · T7, T8; §9 token-fill, §12 bind + switch-frame-to-mode.

### Write — node metadata & prototype (2 · restored)
- `set_plugin_data(nodeId, key, value, {namespace?}) → {id,…}` — twin of `get_plugin_data`; empty-string value clears the key · T2; §1 persist agent-state.
- `set_reactions(nodeId, reactions[]) → {id, warnings?}` — `setReactionsAsync`; twin of `get_reactions`; feature-detected · T2, T7; §13 wire-prototype (restored).

### Handoff (2 — read/write twin) + Batch (1)
- `get_annotations({nodeId?, cursor?, limit?=100}) → {results, truncated, cursor?, warnings?}` / `set_annotations(nodeId, annotations[]) → {id, warnings?}` — read/overwrite spec notes; matched plural twin; read shape (Rule-A list, bounded by T10: `limit` defaults to **100**, `cursor` continues when `truncated`) == write shape; `get_annotations` omits `nodeId` to read the selection; editorType-gated · T2, T7, T10; §13 annotate.
- `batch({op?, ops:[{op?, …params}]}) → {results, errors[]}` — one or mixed WRITE ops over N existing targets, in order, partial success; the only multi-target mutation path (op set listed under *The one generic batch*) · T5; §9/§11 all "N-call loop" tasks.

## Resolved decisions

- **D1 — Reading bounded by default (T10), one rule per output shape.** List reads → uniform `{results, truncated, cursor?}`: **every** list read is bounded with a default **`limit` (100)**, a `truncated` flag, and an opaque self-contained cursor token returned when truncated — the agent continues by passing the token back verbatim. Tree reads → **depth + always-on budget + truncation receipt + drill-by-id stubs** (no cursor — already bounded, the continuation handle is drill-by-id). `get_node`/`get_nodes` are the **fidelity-first exception** (bounded by `depth=0`, never budget-truncated, no budget/match/cursor, T2). Uniform across every API of its shape — learned once. **`get_components` additionally gates its expensive scan**: remote/library discovery is opt-in (`includeRemote=false` by default skips the O(document) all-instances scan — the live timeout fix), and the resulting list is then paged server-side by `limit`/`cursor` like every other list read (a remote-component cache is the future fix). *(Re-alignment: an earlier reconciliation had dropped the cursor from the naturally-bounded readers as an "improvement"; T10 reverses that and restores the cursor on every list read — the original Rule-A contract, not a new divergence.)*
- **D2 — Projection.** `fields:[...]` allow-list **+ presets** (`minimal/layout/style/text/full`); no deny-list. Same param on every node-returning read.
- **D3 — Batch.** One `batch` tool, one shape `{op?, ops:[{op?,…}]}` — top-level `op` default (homogeneous, compact) or per-entry `op` (heterogeneous); in-order, partial-success, best-effort; ordering guarantees are within-op only (cross-entry deps are the agent's to sequence); entries warn like single calls. Scope is WRITE ops over existing targets (create-* excluded).
- **D4 — Defaults.** `get_node`/`get_nodes` depth=0 (fidelity-first); `inspect` budget-adaptive level-fill (no budget → depth=0; `depth=-1` → all). Same rule, job-tuned defaults.
- **D5 — Naming.** `get_X` / `create_X`+`update_X`; `set_X` only for whole-state writes; `inspect`/`get_node` the one deliberate two-name split (encodes T3). **Documented naming exceptions** (read-many vs write-one, or operation-shaped): `list_pages`↔`create_page`/`set_current_page` and `get_components`↔`create_component`/`update_component` (plural enumeration read vs singular promote/edit-one write); `set_focus` (viewport writer). Genuinely **operational** capabilities use verb names (`boolean_op`, `flatten`, `combine_variants`, `swap_component`, `clone_node`, `reparent_node`, `reorder_children`, `apply_style`, `bind_variable`, `create_from_svg`) — the get/create/update/set scheme governs CRUD-shaped tools, not every tool.
- **Image fills — both.** `image(url|hash){…}` grammar atom (one-step, server-creates-for-url, deduped) **and** `create_image({url|bytes})→{hash}` tool (the only raw-bytes / reuse path). Two capabilities, not two paths.
- **Coverage restorations (6 + review).** Added: `get_reactions`/`set_reactions`; `boolean_op`+`flatten`; image-fill (atom + `create_image`); `get_plugin_data`/`set_plugin_data`; `create_page`/`set_current_page`/`duplicate_page`; variable **mode lifecycle** on `update_variables`. Review pass added: `set_focus` (scroll-to-node), `search` `characters` projection (text inventory), `match.type` array, expose-nested-prop gated on `update_component` (🟠).

## Coverage (verified 89/89)

Verified against `figma-task-checklist.md` over multiple passes:
- The lean draft covered **81/89**; the six restorations + two review fixes (`set_focus` for
  scroll-to-node, `search` projecting `characters`) closed the ✅ gaps.
- A final **adversarial** pass caught that instance `overrides`/`componentProperties` and
  `layoutPositioning` were not surfaced on reads — sinking §6 "see overrides", §7
  absolute-positioning audit, and two §11 instance 🟡 tasks. Fixed by adding those fields to
  the `NodeSpec` node struct (read via `get_node`/`inspect`; written via `update_node`/`set_instance`).

**89/89** — every ✅ task has a tool, every 🟡 rides on an existing read (verdict is
skill-layer, P1), every 🟠 is gated+degrade.
