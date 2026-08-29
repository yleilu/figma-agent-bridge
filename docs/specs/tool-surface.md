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
  - "[[figma-bridge/docs/specs/self-describing-nodes]]"
  - "[[figma-bridge/docs/specs/component-index]]"
  - "[[figma-bridge/docs/specs/change-feed]]"
---

# figma-agent-bridge — Tool Surface

> **Spec of record.** This is the **51-tool** facade surface — the contract of record
> for the MCP tool layer. Governed by `docs/principles.md` (T1–T10, B1, P1).
>
> The **component index** feature layers two further MCP tools —
> `search_components` and `reindex` — specified in
> `docs/specs/component-index.md` (not re-catalogued here). These are **non-facade
> meta-tools** (outside the `figma.*` facade count), like `record_feedback`.
>
> **Count is a formula, not a hand-summed aggregate (stops silent rot).** The one
> hand-maintained number is the **facade group-sum = 51** (the full MCP registration count is larger — facades plus the non-facade meta-tools; a schema-level audit counts every registration, which is why "61 schemas" and "51 facades" both appear in project records) (the Tool catalogue below is the one
> place it is summed). The exposed MCP surface is then **`51 facade + K non-facade meta-tools`**,
> where **K counts the meta-tools the server registers** — a *registration*, not a mention in a
> spec, is what puts a tool on the surface, so the formula is checkable against
> `packages/server/src/index.ts`, whose `registerFileTool` + `registerSessionTool` +
> `registerBufferTool` calls **are** the exposed surface. **K = 10**: `search_components` and
> `reindex` (component-index.md), `report_status` (status-monitor.md), `pull_changes`
> (change-feed.md), `record_feedback` and the five send-flow tools `list_feedback` /
> `send_feedback` / `discard_feedback` / `github_auth_start` / `github_auth_poll`
> (feedback-system.md). So the exposed surface is
> **`51 + 10` = 61**, which the code splits as **52 file-addressed + 8 session-addressed +
> 1 buffer-addressed** (49 facade + 3 meta take a `fileKey`; the facade's `connect`/`status` and
> the six machine-global feedback tools do not; `pull_changes` takes a `fileKey` but reaches
> `server.tool` through its own gate).
> A meta-tool a feature spec designs but the server does not register — the registry trio
> `register_library` / `unregister_library` / `list_libraries` (team-library-registry.md) — is in
> neither K nor the exposed total; registering it is what adds it. Do not restate a hardcoded
> total (a bare "51" already wrongly omits `record_feedback`).
>
> The **change feed** (docs/specs/change-feed.md) specifies one non-facade meta-tool
> `pull_changes({fileKey, limit?, detail?}) → {changes, truncated, remaining?, state}` — a
> destructive buffer **drain** (deliberately **not** `get_*`; non-idempotent; bounded by `limit` +
> `truncated`, carrying **no cursor**, and carrying a **truncation receipt** — the third output
> shape under D1). `limit` counts **entries** (ids), in both detail modes. `detail` is
> `'folded'` (the default — one net effect per id) or `'runs'` (the same entries carrying
> `runs[]`, oldest first); anything else is `INVALID_PARAM`. A drained record is per **id** and
> carries values (`set`) as a **subset** of `props`; it may carry `src` (another session caused
> it) and `mine` (property names this session is known to have caused on that id — the evidence
> that its own write landed). It **never** carries session ids, `by`, `rf` or `writers[]`: those
> are transport between the plugin and the buffer, spent at ingest. Its codes are `INVALID_PARAM`
> (own) and `WRONG_FILE` only: it dispatches nothing to Figma — it drains the server's own
> memory — so it does **not** inherit the file gate's `DISCONNECTED` / `INCOMPATIBLE`. It
> therefore reaches `server.tool` through **`registerBufferTool`**, a third registration wrapper
> alongside the file and session wrappers, carrying the same identity handling (`fileKey` plus the
> reserved headers) behind a different gate. It must **not** inflate the facade count; it is
> counted in K above.
>
> The **team-library registry** (docs/specs/team-library-registry.md) specifies three
> non-facade meta-tools — `register_library`, `unregister_library`, `list_libraries`
> (all take `fileKey`) — outside the `figma.*` facade count.
>
> The **status monitor** (docs/specs/status-monitor.md) adds one non-facade meta-tool
> `report_status({fileKey, text, level?, label?})` — a **display-only** push of an agent's
> live status to the plugin panel (no `figma.*` counterpart; file-addressed, so it spreads
> the `fileTargetParamsSchema` mixin). It must **not** inflate the facade count.
>
> The **feedback send-flow** (docs/specs/feedback-system.md) adds five non-facade meta-tools —
> `list_feedback` (read the pending backlog + remembered identity, bounded by T10),
> `send_feedback` (Report → file every pending item as a comment), `discard_feedback` (Discard →
> hard-delete every pending item, no network), and the device-flow pair
> `github_auth_start` / `github_auth_poll` (the logged-in-identity handshake) — the agent-driven
> review-and-file mechanism. All five are **machine-global** (no `fileKey`), so they do **not**
> spread the `fileTargetParamsSchema` mixin, and they must **not** inflate the facade count.

> The tool layer only — opinions (design-system-first, audit verdicts, layout
> inference) are skill-layer (P1) and deliberately absent.

## Overview

The **facade** is **51 tools**: read/write pairs over five concept groups (session, nodes,
structure, design-system, handoff) **+ one generic `batch`**. The **exposed MCP surface is larger**
— the facade plus every non-facade meta-tool the feature specs add, per the formula above — so a
document quoting one number for "the tool surface" is quoting that total, never this facade sum.
It is the lean facade base plus
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

### The three reading rules (D1 — one rule per output shape, applied to every API of that shape)

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
  `{id, name, type, size?, childCount}` — the agent **drills by re-reading the stub's id**.
  `size` is carried, never invented: a node the file holds no measured size for (a PAGE)
  omits it rather than padding `[0, 0]`.
- **`budget`** — always-on hard cap on response size (token estimate). Even a wide level at
  shallow depth can't blow context. **Always-on means it applies whether or not the caller passes
  one**: omitting `budget` selects the default of **20,000**, it is not a request for an unbounded
  read. An explicit `depth` stays capped by it, and `depth=-1` is bounded like any other read —
  what "all" changes is where truncation lands, never whether it happens.
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
the agent raises `depth` deliberately; the read never drops a field behind the agent's back — and
**never drops the descent either**: a `depth` other than 0 paired with a projection that omits
`children` is `INVALID_PARAM`, not a silently childless reply (I64, and the same rule on
`inspect`). They still satisfy T10: the default `depth=0` bounds the call to a single node, deeper children are
id-stubs, and breadth is the agent's explicit choice — no unbounded scan, so no cursor.

**Rule C — a destructive event drain → `limit` + `truncated`, no cursor (bounded, T10).** A read
that **consumes** what it returns (exemplar `pull_changes`, the change-feed buffer drain —
[[figma-bridge/docs/specs/change-feed|change-feed.md]]) is bounded exactly as Rule A is: a default
**`limit`** caps what one call returns and a **`truncated`** flag says whether more remain. It
carries **no cursor**, because *consumption is the position* — what a call returns it also removes,
so the unretrieved remainder **is** the continuation and calling again resumes by definition. There
is no resume token to pass back verbatim and no tree-version hash that could go stale under it. The
payload is named for what it carries (`changes`, not `results`), because a drain returns **events**,
not query results. Truncation additionally carries a **receipt**, `remaining` — the count still
buffered plus mechanical per-frame buckets over the locator each entry carries — because what is
left of an **event backlog** has a shape worth reporting where what is left of a query result does
not: a thousand-record backlog handed back a hundred at a time is not actionable, and the receipt
is what makes "re-read the affected region" nameable. It is a map of *where to look*, never an
interpretation of what the changes mean (**B1**).

**Projection (D2), on any node-returning read** — `fields: [...]` allow-list (precise
token-saver) **+ presets** `profile: "minimal"|"layout"|"style"|"text"|"full"` for common
scans. No deny-list (it grows silently as the grammar grows, a T4 regression). **`contextSummary` is outside projection** — it is a server-derived, always-capped read-only field on `inspect`/`search`/`get_components`, never narrowed by `fields`/`profile`; the round-trippable full `context` rides the fidelity readers (and is included in `profile:"full"`; the lossy presets omit it).

**`match` filter, on list/tree node reads (`inspect`/`search`)** — `{name?, regex?, type?(value|array), componentKey?, styleId?, variableId?, instancesOf?}` filters at the source. `type` accepts an array (multi-type in one pass). The fidelity readers (`get_node`/`get_nodes`) carry no `match`.

**Reads degrade per node (T7).** A node whose enrichment fails is returned with a `readError`
field naming the failure instead of failing the read; every other node is unaffected. A read is
a walk over many nodes, and any one of them can refuse to be read — a node that no longer
resolves throws on every property access — so the cost of one bad node is that node, never the
tree that contains it. When the failing node cannot be identified in the returned tree — the two
sides of a read can key one node by different ids once a handle has gone stale — the failure is
reported on the root of the returned tree as `readErrors`, so a read that cannot say *which* node broke
still says that one did. Both fields **are outside projection** (like `contextSummary`): a
`fields`/`profile` narrowing cannot hide an unreachable node, and no caller could name them in
advance anyway, since which node breaks is not knowable before the read. The list reads carry
the same contract in their own shape: a candidate that cannot be read is **skipped and named** in
the reply's `warnings` (there is no node struct in a candidate list to hang the field on), and
the scan still completes.

### Defaults by job (D4)

- **`get_node`/`get_nodes`** → `depth=0` (the node you'll edit; children as id-stubs). `depth=-1` for a full subtree to round-trip; fidelity-first (no budget truncation).
- **`inspect`** →
  - **`budget` given** → fill **level-by-level** (breadth-first) until the budget is hit, then stub the rest + receipt. Budget drives depth adaptively.
  - **no budget, no depth** → `depth=0` (minimal: node + child stubs).
  - **`depth=-1`** → every level, still budget-capped like any other read.
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
`get_plugin_data`. Trees follow Rule B (depth/budget/receipt); lists follow Rule A (bounded by T10 — default `limit` + `truncated` + opaque `cursor`); node-returning reads honor `fields`/`profile` (+ `match` on `inspect`/`search`); the derived `contextSummary` is exempt from projection.

## Write model

### Create / update

- **`create_node(spec, {parentId?})`** — one node; `spec` === `get_node` output (round-trip anchor, T2). Appends under `parentId`, else the current page.
- **`create_tree(tree, {parentId?, refs?})`** — recursive + sibling-array create; the legitimate batch-create envelope (one round-trip for a subtree, T5). **ref-pool**: repeated instances/clones reference a shared spec by key; `{ id }` clone-by-id is also supported in the tree.
- **`create_from_svg(parentId, svg, {name?, size?})`** — vector import.
- **`create_image({url|bytes}) → {hash}`** — server-side `createImageAsync`/`createImage`; the hash flows into an `image(hash)` paint (image fill decision below). Supply EXACTLY ONE of `url` or `bytes` (the handler validates).
- **`update_node(nodeId, patch)`** — THE single-target mutation. `patch` is a **partial NodeSpec**: a **supplied** field is **replaced wholesale** (`fills=` overwrites the whole array, never appends); an **omitted** field is **left untouched** — reconciling lossless writes (T2) with partial/token-efficient input (T4). Absorbs every former setter (`set_fills`, `set_strokes`, `set_text_content`, `set_position`, `resize_node`, …) — T6: one mutation vocabulary, no twins.
- **Creation default — a created frame stacks (T9, B2).** A **FRAME** created by `create_node`/`create_tree`, and a **SLOT** created by `update_component`'s `slots`, whose spec names **no `layout`**, is created with **vertical auto-layout** (`layout:{mode:'V'}`) — the modern-practice arrangement, so the common case costs no follow-up call. The opt-out is the grammar's own: **`layout:{mode:'NONE'}`** creates the absolutely-positioned frame (`expression-formats.md`), and any explicit `layout` (`H`/`V`/`GRID`, with its keys) is written exactly as given — the default only fills a **silence**. Every other node type is untouched. A **bare slot name** takes the default exactly as the `{name}` object form does — the bare string *is* `{name}`, and one entry cannot mean two things depending on how it was spelled. **A stated `size` is pinned `sizing:['FIXED','FIXED']` when — and only when — the default layout is injected**, because Figma's auto-layout *hugs*: without the pin the arrangement the surface added would shrink away the height the caller stated, which is the one thing a default may never do (the old absolute default honored a stated size, and so does this one). A spec that states its own `layout` owns its `sizing` with it, and a spec that states no `size` is asking for nothing in particular — hug is right for a container that named no height. The rule is **creation-only**: `update_node` never injects it, so an omitted `layout` on a patch keeps meaning *left untouched* (T2) and an existing absolute frame is never converted behind the agent's back. Normalization happens **server-side, on the write face** every create shares, so what the plugin receives is what the agent would have had to write. **B2:** this changes a creation *default*, not the wire — no frame shape moves and the handshake is unaffected — but a build written against the old default lands differently, so it travels as a **minor** version bump and server + plugin ship at the same `APP_VERSION`.
- **A create that could not honour a stated `size` says so (T7, B61).** Every create path (`create_node`, `create_tree`, and the `update_component` slot loop) reads the node's box back after its sizing is written and, on the tree path, after its children are placed — and when the stated `size` is not the size the node reads, it emits the SAME warning `update_node` has emitted since B46, naming the axis, the sizing that took it (`layoutSizingHorizontal: HUG`), and the remedy. The discard itself is correct — a FILL or HUG axis owns its dimension and the sizing wins — but two write paths disagreeing about one field while only one of them admits it is not: a stated `size` on a layout-bearing FRAME was silently hugged away on create and pinned FIXED on update, and the difference surfaced only in a read-back. One author for the sentence, so the two cannot drift.
- **A degrade is data, on every write face (T7, B61).** `create_node`, `create_tree` and `update_node` answer plugin-side degrades and server-side lossy-conversion notes as ONE list in the reply's structured **`warnings[]`** — never as loose `Warning:` prose appended after the JSON body. The two create faces used to do the latter (create_tree for both kinds, create_node for the server's half), which reads fine to a human and is invisible to anything parsing the reply — and the reply is what an agent parses. `create_tree` is the worst place for it: it builds whole screens, so every degrade at any depth of a subtree comes home on that one envelope. Warnings are ordered plugin-first (what happened to the document), then server (what was wrong with the request), and the key is omitted entirely when nothing degraded, so its presence is the signal.
- **A layouted node always states its `gap` (T7, B63).** `JSON_REST_V1` spells zero by omission, so a gap of `0` and a gap nobody ever set reached the reader identically and the read dropped the key for both — a frame whose spacing had just been destroyed came back looking untouched. `layout.gap` (and the two GRID gaps `rowGap`/`colGap`) is therefore emitted on every auto-layout node whatever its value. `pad` keeps its own rule: an all-zero, unbound pad stays omitted, since four zeroes on every layouted node is noise and a bound zero already survives. Related and NOT a defect: **binding a variable to a layout field takes that field over** — Figma re-resolves it through the variable, so the literal that was there is replaced by the variable's value in the node's resolved mode (a gap of 4 bound to `space/8` reads 8 afterwards). A variable with no value in that mode resolves to the type's zero, which is why `create_variables`' unknown-mode warning is worth reading before binding.
- **`context` write validation (T7/T2):** the `context` `NodeSpec` field is size-capped at **2 KB** (`CONTEXT_MAX_BYTES` = 2048, UTF-8) wherever a spec is written (`create_node`/`update_node`/`create_tree`). An oversized value is rejected with a clean **`INVALID_PARAM`** error (`context is N bytes; limit is 2048 — trim the body or move detail behind a Links entry`), never a Figma throw. On `update_node`, an **omitted** `context` leaves the stored value untouched; a **supplied empty/whitespace** `context` **clears** the reserved key (same empty-clears rule as `set_plugin_data`). An over-cap value written via the raw `set_plugin_data` escape hatch is a **declared read-only, non-round-trippable** state (T2 asymmetry): fidelity readers return it faithfully, a naive full-spec write-back is rejected with the same `INVALID_PARAM` error — resolve by omitting or trimming `context`.
- **`vectorPaths` field (VECTOR nodes):** a `NodeSpec` field accepting an array of `path(windingRule,"data")` atoms (see `expression-formats.md` for the atom grammar). Write: include in a `create_node`/`update_node` spec to set the vector's editable paths. Read: `get_node` on a VECTOR node returns `vectorPaths` as an array of path atoms, enriched from the live `node.vectorPaths` (not from `exportAsync` `fillGeometry`/`strokeGeometry`). This is NOT a new tool — it is a field on the existing `NodeSpec` struct; tool count is unchanged.
- **`pointCount` field (POLYGON + STAR nodes):** plain integer `NodeSpec` field (no atom grammar). Write: include in `create_node`/`update_node` spec to control the number of polygon sides or star points. Read: `get_node` returns it from the raw export when present. Not a new tool.
- **`innerRadius` field (STAR nodes):** plain number `NodeSpec` field, range 0..1, no atom grammar. Write: include in `create_node`/`update_node` to set the star's inner radius ratio. Read: `get_node` returns it from the raw export when present. Not a new tool.
- **`sectionContentsHidden` field (SECTION nodes):** plain boolean `NodeSpec` field, no atom grammar. Write: include in `create_node`/`update_node` to control whether section contents are collapsed. Read: `get_node` returns it from the raw export when present. Not a new tool.
- **`isMask` field:** plain boolean `NodeSpec` field (no atom grammar). When `true`, the node clips siblings below it in the same parent. Write: include in `create_node`/`update_node`; applied post-append so the sibling context is resolved. Read: `get_node` returns it when enriched by plugin export (not in `JSON_REST_V1`). Not a new tool.
- **`maskType` field:** plain string enum `NodeSpec` field — `'ALPHA' | 'VECTOR' | 'LUMINANCE'`; only meaningful when `isMask` is `true`. Same write/read pattern as `isMask`. Not a new tool.
- **GRID layout mode (M12 — `layout.mode:'GRID'`):** `layout.mode` now accepts `'GRID'` in addition to `'H'`/`'V'`/`'NONE'`, enabling Figma's CSS-Grid-like layout. Four GRID-only keys on the `layout` struct: `rows` (gridRowCount), `cols` (gridColumnCount), `rowGap` (gridRowGap), `colGap` (gridColumnGap). The scalar `gap`/`align`/`wrap` keys remain H/V-only and are ignored for GRID. Write: include `{mode:'GRID', rows, cols, rowGap, colGap}` in any spec; plugin applies with feature-detect guards (T7 — degrades on old runtimes, warns, never throws). Read: `get_node` enriches GRID frames from the live node (not `JSON_REST_V1`, which may omit these fields). Not a new tool — extends the existing `layout` struct (T6/T8). Deferred: `gridRowSizes`/`gridColumnSizes` (track sizing) + per-child `gridRowSpan`/`gridColumnSpan`/`gridChild*Align` (child placement) — see `docs/deferred-capabilities.md`.
- **`component.key` + `component.remote` for INSTANCE nodes (M14 — library-instance round-trip):** `get_node`/`get_nodes`/`inspect` now emit `component.{id, key, remote:true}` for an INSTANCE (via `getMainComponentAsync`, feature-detected T7). `create_node(INSTANCE)` prefers `importComponentByKeyAsync(key)` when `remote===true`, falling back to `id` on failure (T7). Emitted on **every node the read returns complete** — the requested node and, within `depth`, its descendants — on the measurement in `expression-formats.md` ("`component.key` follows, on its own measurement": ~0.06 ms per instance, so the per-instance call the lookup requires is affordable). `component.remote` is a read-emitted hint, not an agent-settable gate; do NOT add an `includeRemote` flag. Not a new tool — extends existing fidelity readers.

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
  `reorder_children`, `clone_node`, `boolean_op`, `flatten`, `group_nodes`, `transform_group`, `apply_style`,
  `update_component`, `combine_variants`, `swap_component`, `set_instance`, `bind_variable`,
  `create_styles`, `update_styles`, `delete_styles`, `create_variables`, `update_variables`, `delete_variables`,
  `set_plugin_data`, `set_reactions`, `set_annotations`, `create_page`, `set_current_page`, `duplicate_page`.

Family-specific array envelopes (`create_tree`, `get_nodes`, `create_styles`,
`create_variables`) create a coherent unit and stay distinct from the generic `batch`
(N ops over existing targets).

### Ordering constraints (load-bearing, enforced server-side within one op)

- Set `layoutSizing:FILL` / `layoutPositioning:ABSOLUTE` only **after** `appendChild` to an auto-layout parent → the server orders the property sets within one call.
- Set `minWidth`/`maxWidth`/`minHeight`/`maxHeight` only **after** `appendChild`. Figma accepts a clamp on an auto-layout frame or on a direct child of one, and judges that against the node's real parent — so a create writes the clamps once the node is where the spec put it. A spec whose END state carries no auto-layout at all is refused, and the refusal names the field, the value and the node.
- In `create_tree`, a node that states `children` keeps its stated `size` until they are built: its own `sizing` (the `FILL`/`HUG` resize) is applied **after** its subtree. A child is therefore placed at its authored position inside the box its position was authored against, and takes its `constraints` before any resize of that box — so the parent's later collapse re-anchors it instead of leaving it where nothing can.
- `align: ["SPACE_BETWEEN", …]` combined with a **variable-bound** `gap` is a self-contradictory pair (space-between means Figma owns the spacing) and is **refused at every write door** — create/update/batch/slot specs/`bind_variable` — with a branch-accurate error naming the recovery (`bind_variable {clear:true}` on the gap, then write). A document already carrying the pair refuses align edits until the gap is cleared. A LITERAL gap beside SPACE_BETWEEN is fine.
- `loadFontAsync` resolves **before** any `text.content`/`font` write → the server loads first.
- `textAutoResize` set before `resize()`.

### Honesty / warn-on-no-op (T7)

- **Every tool schema is strict.** An unknown parameter — top-level on any tool — is `INVALID_PARAM` naming the key, never silently stripped: a stripped key inverts a call's meaning without a trace (the B52 lesson, generalized to the whole surface).

- Feature-detected + degraded: slots (`update_component` `slots` param via `component.createSlot()`), paint variable-binding (`bind_variable`), annotations (editorType-gated), reactions, expose-nested-prop, `swap_component` remote `key` import. Each **warns and continues** — emits a `warnings[]` entry naming what was skipped, never a silent no-op or a hallucinated success.
- **Warn on silent no-op**: x/y on an auto-layout child → `warnings[]` entry naming the dropped field; same for `reorder_children` set-equality and overrides surviving a `swap_component`.

## Expression integration

One grammar, two faces (T8, expression-formats.md):

- **Reads emit the view face.** `inspect` renders **structs as YAML** (`node`, `layout`, `text`) and every leaf as **one atom** — `[style(N)|var(N)] value [{…}]` — so binding *and* appearance ride in one token-cheap string.
- **Writes consume the edit face.** `create_node`/`update_node`/`create_tree` take the same `NodeSpec` + atom grammar; the write parser also accepts friendlier notations (`rgb()`, `rgba()`) the view never emits. View is the lossy subset of edit.
- **Size clamps are read-emitted:** `minWidth`/`maxWidth`/`minHeight`/`maxHeight` come back on reads wherever set (a floor is verifiable by field, not only by geometry). **`layout.gap` (and both grid gaps) are ALWAYS emitted for a layouted node, `0` included** — the runtime omits `itemSpacing` at 0, and the reader compensates, so a zeroed gap can never read as an unset one.
- **Image fills (both — two capabilities not two paths):** a paint atom **`image(url|hash){scale?,rot?,…}`** sits in `fills[]` alongside `solid`/`linear`/…; on write `image(url)` makes the hash server-side (deduped by URL), `image(hash)` reuses one; reads emit `image(hash)` (round-trips). **`create_image`** is the *only* path for **raw bytes** and for **pre-creating a reusable hash**; `image(url)` is inline sugar for the URL case.
- **The two round-tripping grammar wrappers (T2):** `var()` and `style()` are emitted on a read to surface an existing binding, and a write of the same atom applies the literal **and then re-establishes the binding** — by NAME, never by id, degrading to the literal plus a `warnings[]` entry when the name resolves to nothing (T7)**; the one exception is a styleable field written as a bare `style()` reference (`fills`, `strokes`, `effects`, `grids`), which has no literal to keep — there an unresolvable or wrong-type name is an `INVALID_PARAM` error (expression-formats.md — *A styled field is a reference, not a list*)**. Binding inline is the default path; **`bind_variable`** / **`apply_style`** remain the explicit route for a field a write is not otherwise touching (and for `bind_variable`'s collection-mode pin). Both wrappers name their source (`style(Brand/Primary)`, `var(radius/medium)`), never the opaque runtime id, and both are emitted on **every node the read returns complete** — the requested node and, within `depth`, its descendants. Resolution is per distinct token, not per bound field, so the cost scales with how many tokens the document defines rather than how large the subtree is. `component.key` follows the same rule. Named here and in the grammar doc, where the measurements are.
- **Styles vs variables routing:** `apply_style` binds a *style* id; `bind_variable` binds a *variable*. Both surface on reads as `style(...)`/`var(...)` so the route is visible on read-back.

## Tool catalogue

Format: `name(params) → returns` — purpose · principle/checklist need.

**Count = 51** (auditable per group): Session 2 · Read-nodes 4 · Read-query 3 · Read-DS 4 · Read-meta 2 · Write-nodes 5 · Write-structure 10 · Write-pages 3 · Write-components 5 · Write-DS 8 · Write-meta 2 · Handoff 2 · Batch 1 = **51**.

**`record_feedback` — deliberate meta-tool, outside the 51-tool facade (T6/T7 exception).**
`record_feedback({category, title, description, tool?}) → {…}` (see
[[figma-bridge/docs/specs/feedback-system]]). The facade
rule (T6/T7) requires every tool to map to a real `figma.*` capability. `record_feedback` is
the **original** such exception (the enumerated non-facade meta-tools above — `report_status`,
`search_components`, `reindex`, `pull_changes`, the registry tools, and the feedback send-flow
tools `list_feedback` / `send_feedback` / `discard_feedback` / `github_auth_start` /
`github_auth_poll` — are admitted
on the same basis) — it captures bridge-experience friction and has no Figma API counterpart.
It is admitted knowingly and quarantined: placed in its own conceptual `feedback` group, absent
from `COMMANDS` and the verify-live `ALL_TOOLS` catalogue, so the facade count is unchanged.
Precedent: `get_document_info` / `close_plugin` are already non-facade lifecycle commands (as is the new
`ping` liveness probe — [[figma-bridge/docs/specs/connection-liveness|connection-liveness.md]]). See
[[figma-bridge/docs/specs/feedback-system]].

### Session (2)
- `connect({fileKey?, fileName?}) → {fileKey, fileName, connected, available[]}` — pair the MCP server to a **specific file's** plugin, targeted by `fileKey` (or `fileName`), and return the currently **available** files `available:[{fileKey, fileName, connectedAt, version?, build?, currentPage?, selected?}]` (the enriched relay availability registry — the same entry `status().available[]` returns; see [[figma-bridge/docs/specs/plugin-presence|plugin-presence.md]]). When the target is ambiguous or **not available**, it does **not** guess — it returns an error listing `available[]` and asks the agent to choose (B3). The raw channel is now an internal detail (server resolves `fileKey`→channel). *(`fileKey` needs `enablePrivatePluginApi`; `fileName` is the fallback id — see overview *Connection lifecycle*.)* · B1, B3; §2 connect.
- `status() → {connected, joined:[{fileKey, fileName, channel, currentPage, selection[], viewport, version, build, serverBuild, incompatible?, buildSkew?}], available[]}` — **every joined file** (multi-file) with its best-effort live context, plus the **availability set**, in one read (live context is best-effort; failures degrade, they don't throw) · B1, B3, T4; §2 read-what-user-sees. **`build` is the BUILD FINGERPRINT beside the version (I62):** only CI moves the version, so every dev build of both sides stamps the same one and a same-version pair proves nothing about whether the two halves came out of one build — a stale installed bundle passed the handshake and then answered reads that were *wrong rather than absent*. `build` is the sandbox bundle's build identity (`<short-sha>[+]@<UTC minute>`, `'source'` for an unbundled run), `serverBuild` is this server's, and `available[].build` carries the registry's copy. The comparison is **ADVISORY**: a `buildSkew` note rides the SUCCESS reply, `requireFile` never consults it, and nothing is ever refused on it — see [[figma-bridge/docs/specs/version-handshake|version-handshake.md]].
- *(plugin teardown = internal `close_plugin` command, not a tool — transport/dev-reload lifecycle, see overview *Connection lifecycle*; T6. **Addressing (B3):** tools take an explicit per-call **`fileKey`** param naming their target file (canonical; per [[figma-bridge/docs/specs/overview|overview.md]] and [[figma-bridge/docs/specs/request-envelope|request-envelope.md]] — the addressing/envelope source of truth). The param is carried by a shared **`fileTargetParamsSchema` mixin** — a required **`fileKey`** plus the **reserved, server-managed** optional identity headers **`sessionId`** and (for subagent calls) **`agentId`/`agentType`** (all marked *do not set — injected by the session `PreToolUse` hook*, per request-envelope) — **spread into every file-addressed tool** so "required" is one definition, not per-tool. It is a **param-schema mixin, not a new tool** — the 51-facade count is unchanged. The **session/transport and non-file meta-tools are the exceptions:** `connect({fileKey?})` (discovery), `status()` (no per-call file), and the global feedback meta-tools `record_feedback` / `list_feedback` / `send_feedback` / `discard_feedback` / `github_auth_start` / `github_auth_poll` (global feedback store + machine-wide identity, no file) address the *connection* or a non-file store, not a per-call file, and do **not** spread the mixin. `requestId` is a **server header** (`genId('cmd')`), not a tool param.)*

### Read — nodes (4)
- `inspect({nodeId?, pageId?, depth?, budget?, fields?, profile?, match?}) → {view, truncated[]}` — compact lossy view, drill-by-id (Rule B); each node carries a read-only **`contextSummary`** (the frontmatter slice of `context`, capped at `CONTEXT_SUMMARY_MAX_BYTES` = 512, rendered as a YAML block scalar; server-derived, **not** `fields`/`profile`-projectable; omitted when absent); omit both ids to inspect the current selection (multi-select returns a `SELECTION` forest) · **T3 inspect**, T4; §1 human view, §3 deep/large trees, §13 CSS-handoff data.
- `get_node(nodeId, {depth?=0, fields?, profile?}) → NodeSpec` — faithful edit form, round-trips; **fidelity-first, never budget-truncated**, **no budget/match** (children past `depth` are id-stubs that round-trip via drill-by-id). **`depth` is never silently inert (I64):** a `depth` other than 0 asks the read to DESCEND, and a projection that drops `children` — any `fields` list without it, any `profile` but `full` — throws away the one field the descent produces, so the pair is `INVALID_PARAM` naming both ways out (`'children'` in `fields`, or `profile:'full'`/no projection, or drop `depth`). It **refuses rather than auto-including** the children as stubs, because `fields` is an exact allow-list with no identity floor and merging a field in behind the caller would contradict that on the read face while it holds on the search face — and because whether a projection carries an identity floor at all is still an open decision (I29). Same rule, same message, on `get_nodes` and `inspect`; enforced in the handler, so a `batch` entry faces it too. `NodeSpec` carries `context` (full, round-trippable markdown note ≤ 2 KB, from shared `pluginData`), `layoutPositioning`, instance `componentProperties`/`variantProperties`/`overrides` — so override-reads (§6/§11) and the §7 absolute-positioning audit ride on this read · **T3 edit**, T2; §1 read-exact-to-write, §6 instance overrides.
- `get_nodes(nodeIds[], {depth?, fields?, profile?}) → {results, errors[]}` — multi-id read (faithful spec per id — including the full `context` field, same as `get_node`; same reduced params + fidelity-first contract) · T4, T5; §1 read-many.
- `export(nodeId, {format?, scale?}) → image|svg-text` — render-to-see + one-off asset export (`format`: PNG|JPG|SVG|PDF, default PNG; `scale` ignored for SVG/PDF) · T6; §1 visual-confirm, §13 export-assets. *(Persistent `exportSettings` is a `NodeSpec` field — round-trips via `get_node`/`update_node`.)*

### Read — query & document (3)
- `search({scope?, pageId?, nodeId?, depth?, match?, cursor?, limit?=50, fields?, profile?}) → {results, truncated, cursor?, warnings?}` — the one finder (`scope`: document(default)|page|node|selection; `match` incl. `type` array, `instancesOf`, `styleId`/`variableId`); **`scope:'page'` without a `pageId` scans the CURRENT page and names it — page name and id — in `warnings[]` (I65)**: it used to answer `Page not found: undefined`, printing the missing value back as if the caller had typed it, while the neighbouring `inspect({pageId?})` already meant the current page — two sibling reads meaning two different things by "this page" is the T1 failure. A `pageId` that names nothing is still `Page not found`, and the note is emitted ONLY when the tool had to choose; **an unknown top-level key — or an unknown key inside `match` — is `INVALID_PARAM`**, naming the key, and the top-level message points at `match` — a silently stripped filter key would invert the reply into a match-all (T7), and an emptied `match` matches everything; `depth` bounds the **scan scope** (how deep the plugin traverses each root: -1/omitted = whole subtree, 0 = roots only, N = N levels), results stay a flat list (Rule A, bounded by T10); `limit` defaults to **50** (lower than the other list reads' 100 — projected search results are heavier per entry); `cursor` is the opaque pagination token (returned only when `truncated`); `fields` takes any NodeSpec field except **`context`** (B64 — a bounded reader carries the capped summary in its place, so the raw note is `get_node`/`get_nodes` only, and accepting the name here returned an empty row per result), plus three search-only names — `characters` (text-copy inventory), `childCount` (how many children the result has, the only way to re-parent the flat DFS list) and `contextSummary` — and **an entry outside that vocabulary is `INVALID_PARAM`**, naming the entry: a dropped field is indistinguishable from a field the node does not carry, so the caller would read the absence as a fact about the design (T7, no silent drops); each result also carries a read-only **`contextSummary`** (capped frontmatter slice; server-derived, so it rides on every row whether or not `fields` names it — the name is accepted rather than refused, because refusing the one field a row always carries is the same lie pointed the other way; omitted when absent); `warnings` name every candidate the scan could not read — skipped, never fatal, omitted when the scan was clean (T7, *Reads degrade per node*); **every id a search result carries resolves** — the scan composes real, full-chain ids for instance-sublayer nodes (the T2 emit-resolves promise extended to the finder) · T1 (the one finder), T7, T10; §4 all find + text inventory. 🟠 reverse-lookup returns only matching ids — any usage/orphan/audit interpretation is skill-layer (P1).
- `list_pages({cursor?, limit?=100}) → {docName, results:pages[{id,name,isCurrent,childCount}], truncated, cursor?}` — document + page enumeration (Rule A, bounded by T10; `limit` defaults to **100**, `cursor` continues when `truncated`) · T10; §2 list-pages.
- `get_selection() → [{id,name,type}]` — read selection; twin of `set_selection` · T2; §1 selection.

### Read — design system (4)
- `get_styles({type?, id?, cursor?, limit?=100}) → {results, truncated, cursor?}` — paint/text/effect/grid styles, resolved to grammar atoms (`results:[{id,name,type,value,description?}]` — `description` returned in full, omitted when absent, round-trips via `create_styles`/`update_styles`); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated`) · T1, T10; §5 list-styles.
- `get_variables({collectionId?, cursor?, limit?=100}) → {results, truncated, cursor?}` — collection-grouped, mode-resolved, alias chains (`results:[{id,name,modes,variables[{id,name,type,valuesByMode,aliases:{modeName:targetVarId},scopes,codeSyntax,hiddenFromPublishing}]}]`); `aliases` is a `{modeName: targetVarId}` map — same shape `create/update_variables` consume (T2 round-trip); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated`) · T2, T10; §5 variables/tiers, §6 per-mode, §12 export-planning data.
- `get_components({query?, includeRemote?=false, cursor?, limit?=100}) → {results, truncated, cursor?}` — components/sets, keys, all 4 property types (unified `properties:[{id,name,type,defaultValue,variantOptions?}]` — same shape `update_component` writes), variant axes, defaults; each entry also carries `description` (full, omitted when absent, round-trips via `create_component`/`update_component`) and a read-only **`contextSummary`** (capped frontmatter slice from the component's shared `pluginData`, omitted when absent); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated`); `query` is a case-insensitive name substring. **The expensive scan is gated, not paged (T10):** the O(document) **remote/library component discovery is opt-in** — `includeRemote` defaults to **false**, so by default only the cheap **local** component/set scan runs and `remote` is empty; set it `true` to also walk every instance's `mainComponent` to discover library/remote components. The `limit`/`cursor` pair then **pages the flattened (local ⧺ remote) list server-side** (same `paginateList` helper as every other bounded list read) so the agent context stays bounded; the cursor is best-effort over the session-stable list (version-stamped → STALE if the set changes under it). **Live-caught T10 violation:** the prior *always-on* remote discovery ran a document-wide all-instances scan (`findAllWithCriteria(['INSTANCE'])` resolving every remote main) that timed out on a real UI-kit document; making that scan opt-in (default off) is the fix — the local path no longer runs any instance scan. *(Future: a remote-component cache lets `includeRemote` answer without the O(document) scan.)* · T1, T10; §5 discover/variant-axes, §7 variant-count data (verdict skill).
- `list_fonts({query?, cursor?, limit?=100}) → {results, truncated, cursor?}` — loadable fonts so writes don't guess (`results:[{family,styles[]}]`); Rule A, bounded by T10 (`limit` defaults to **100**, `cursor` continues when `truncated` — the host font list is large, so this read is genuinely paged); `query` filters family-name substring · T7, T10; §5 know-fonts.

### Read — node metadata & prototype (2 · restored)
- `get_plugin_data(nodeId, {namespace?}) → {nodeId, pluginData, sharedPluginData?, warnings?}` — agent metadata (plugin + shared namespaced); plain read (not a Rule-A list — it returns the data maps directly) · T2; §1 read agent-state.
- `get_reactions(nodeId, {cursor?, limit?=100}) → {results, truncated, cursor?, warnings?}` — prototype flow/wiring read; **Rule-A list envelope** (per D1 — uniform with every other list read, bounded by T10: `limit` defaults to **100**, `cursor` continues when `truncated`; `warnings` carry the T7 feature-detect degrade); twin of `set_reactions` · T2, T4, T7, T10; §13 read-prototype.

### Write — nodes (5)
- `create_node(spec, {parentId?}) → {id,name,type,…}` — create one node; `spec` === `get_node` output (round-trip anchor) · T2, T9; §8 build tasks.
- `create_tree(tree, {parentId?, refs?}) → {root, ids[]}` — recursive/sibling batch-create + ref-pool + `{id}` clone-by-id · T5, T9; §8 build screen/card/grid.
- `create_from_svg(parentId, svg, {name?, size?}) → {id,…}` — vector import · §8 add-icon.
- `create_image({url|bytes}) → {hash}` — the **only** path for raw bytes + pre-creating a reusable hash; its hash feeds an `image(hash)` paint (inline `image(url)` is sugar for the URL case); supply exactly one of `url`/`bytes` · T9; §8/§9 image fill.
- `update_node(nodeId, patch) → {id,…,warnings[]}` — the single mutation; `patch` is a partial NodeSpec (supplied field replaces wholesale, omitted untouched; supplied empty/whitespace `context` clears it, `context` size-capped — see *Create / update*); warns on no-op · T1/T6, T7; §9 all restyle/bulk-edit, §8 ABSOLUTE/constraints, basic props (name/lock/visible/opacity/blend/rotation).

### Write — structure (10)
- `clone_node(nodeId, {parentId?, index?, count?}) → [{id,…}]` — raw duplication (one entry per clone) · T6; §10 duplicate, §8 grid.
- `delete_node(nodeId) → {id,name,type[,currentPageId]}` — page-aware remove (info captured before removal). **PAGE semantics:** deleting the last remaining page → `{error}` (Figma forbids a pageless document); deleting the current page → auto-switch to adjacent sibling (rule: previous sibling, else next; `pages[idx-1] ?? pages[idx+1]`), then remove — reply includes `currentPageId` (machine-visible). `setCurrentPageAsync` absent → degrade: warn + skip remove, never throw. Non-PAGE nodes: unchanged path · T1/T6/T7; §9 cleanup.
- `reparent_node(nodeId, parentId, {index?}) → {id,…,parentId}` — the one reparent path; an **auto-layout** parent governs position (re-flows into the layout), a **non-auto-layout** parent **preserves the node's visual position** (its absolute spot is kept, not its raw relative x/y) · §10 move-into-frame.
- `reorder_children(parentId, nodeIds[]) → {parentId, order, warnings[]}` — set-equality validated; warns on mismatch (never throws) · T7; §10 reorder.
- `set_selection(nodeIds[]) → {selectedCount}` — twin of `get_selection`; **selection only** (does NOT scroll the canvas — pair with `set_focus`); empty array clears the selection · T2; §2.
- `set_focus(nodeIds[]) → {viewport}` — scroll + zoom the canvas to nodes (`figma.viewport.scrollAndZoomIntoView`); the viewport writer (`status` reads viewport); unresolvable ids are skipped · T7; §2 focus/scroll-to-node.
- `boolean_op(op, nodeIds[], {parentId?}) → {id,…}` — union/subtract/intersect/exclude → BooleanOperationNode (`op`: UNION|SUBTRACT|INTERSECT|EXCLUDE; ≥2 nodes; `parentId` defaults to the first node's parent) · T6; §10 combine-shapes (restored).
- `flatten(nodeIds[], {parentId?}) → {id,…}` — flatten to one vector (≥1 node; `parentId` defaults to the first node's parent) · T6; §10 flatten/icon-prep (restored).
- `group_nodes(nodeIds[], {parentId?}) → {id,name,type}` — group ≥1 existing nodes into a GROUP via `figma.group()` (`parentId` defaults to the first node's parent; T7-gated: feature-detects `figma.group` availability); the GROUP reads back via `get_node` (T1/T2 round-trip with M10a). **Batch op-set member** — same shape as `boolean_op`/`flatten` (operation over existing ids) · T1, T2, T6, T7, T9; §10 group-for-layout.
- `transform_group(nodeIds[], modifiers[], {parentId?}) → {id,name,type}` — apply a **repeat-pattern** transform to ≥1 existing nodes via `figma.transformGroup()` → TransformGroupNode (a REPEAT feature — linear/radial repeat — **NOT** general grouping; that is `group_nodes`). `modifiers` is a discriminated union on `repeatType`: `{ type: 'REPEAT', repeatType: 'LINEAR', count, unitType, offset, axis: 'HORIZONTAL'|'VERTICAL' }` or `{ type: 'REPEAT', repeatType: 'RADIAL', count, …passthrough }` — **confirmed live LINEAR shape**: `{type:'REPEAT',repeatType:'LINEAR',count:3,unitType:'PIXELS',offset:100,axis:'HORIZONTAL'}`; `parentId` defaults to the first node's parent. **T7-gated**: feature-detects `figma.transformGroup` availability — absent → `{error}` (clear, not a throw). **Runtime absence is still possible** (`figma.transformGroup` is a niche API added in @figma/plugin-typings 1.130.0; the repo now pins `^1.132.0`, so the TYPE is present — but a typing is not a runtime, as `PatternPaint` demonstrates) and is handled by the T7 gate above, which returns `{error}` when the API is missing. The tool stays registered either way, so the facade count is a firm 51. **Batch op-set member** — same operation-over-existing-ids shape as `boolean_op`/`flatten`/`group_nodes`. **T8**: discriminator + structural fields are plain enum/struct (not grammar-routed); numeric scalars are plain numbers (structural op, not an appearance atom) · T1, T2, T6, T7, T8, T9; §10 repeat-pattern.

### Write — pages (3 · restored)
- `create_page(name) → {id,name}` — new page; write twin of `list_pages` · §2 create-page.
- `set_current_page(pageId) → {currentPage}` — switch page (current-page write; naming exception to get_/set_, documented under D5) · T2; §2 switch-page.
- `duplicate_page(pageId, {name?}) → {id,name}` — `page.clone()` backup/variant · §2 backup-before-bulk-edit.

### Write — components & instances (5)
- `create_component(nodeId, {name?, description?}) → {id,key,…}` — **promote-only**: componentize an existing node via `createComponentFromNode()`, optionally rename / set description; slots/properties are added afterward via `update_component`. To build a node first, use `create_node`/`create_tree` then promote the returned id (no spec/parentId overload) · T7, T9; §11 componentize.
- `update_component(componentId, {add?, edit?, delete?, description?, expose?, slots?}) → {id, properties, slotsCreated, slotsSkipped, warnings[]}` — add/edit/delete all 4 property types, set description, **expose nested-instance property (🟠: feature-detected; on unavailability emits a `warnings[]` entry naming the dropped expose, never a silent no-op, T7)**; **create new empty SLOT nodes via `slots` param (🟠: feature-detected via `component.createSlot()`; each entry becomes a brand-new empty SLOT node inside the component, named accordingly — no pre-existing child needed; on unavailability emits a `warnings[]` entry and populates `slotsSkipped`, T7; structured degrade: `{slotsCreated:string[], slotsSkipped:string[]}` — name lists, always present so agents can programmatically detect which slots landed)**; **a slot entry is `string | {name, …spec}` — the bare string is exactly `{name}` (back-compat), and the object form additionally applies its spec to the freshly created slot. The spec IS `update_node`'s patch with `name` required (one write face, not a subset of one — same atom grammar, same inline `var()`/`style()` bindings, T8); `layout`, `fills`, `sizing` and `size` are the fields that make a slot usable, because `createSlot()` takes no argument and a fresh slot is born 100×100 FIXED with an opaque `#FFFFFF` fill and Figma's own no-auto-layout — without this, every usable slot costs two `update_node` follow-ups (one for layout, one to clear the white fill), which is the T9 cheap-path failure. An entry that names no `layout` — a bare name included — takes the **creation default** (*Create / update* above): the slot is created as a vertical stack, and `layout` is written only to ask for something else. The born fill is Figma's and stays the caller's to set. Degrade (T7): a field the slot cannot take warns and continues (`warnings[]`, **every note attributed to the slot by name** — N slots can fail the same way in one call), and the slot is still created and named with its other fields landed; a field the SLOT node type cannot carry is named rather than silently no-opped, exactly as on `update_node`; a key the write face does not know is reported, never applied; a known field of the wrong type is rejected as `INVALID_PARAM` at the param boundary, before the plugin is contacted**; **an entry may carry `parentId` — a node INSIDE the same component that can hold children — and the slot is moved there once created, BEFORE its spec is applied (a layout written while the slot still sits at the root is written against the wrong parent). `createSlot()` takes no argument and drops the slot at the component root, so without this every nested slot cost a second `reparent_node` call and the component was laid out wrong until it landed. A target that is missing, outside the component, or unable to hold children leaves the slot AT THE ROOT and warns saying which (T7) — a slot parked somewhere the caller did not ask for is worse than one still at the root, because only the second is where the caller will look for it**; **each `add` entry optionally carries `targetNodeId` (descendant node id) and `field` (`'characters'|'visible'|'mainComponent'`) to bind the property via `componentPropertyReferences` — if `targetNodeId` is omitted, the property is added but left unbound and a `warnings[]` entry is emitted (`"property '…' added but no targetNodeId given — it is unbound and set_instance will be inert"`, T7 honesty); `field` defaults to the type-inferred value when omitted (`TEXT→characters`, `BOOLEAN→visible`, `INSTANCE_SWAP→mainComponent`); binding failures (unresolved child, non-bindable field) also warn+skip (T7 partial-success); `componentPropertyReferences` is projected on nodes that have it, so the binding is observable via `get_node`**; returns `properties` in the unified `[{id,name,type,defaultValue,variantOptions?}]` shape (same as `get_components`); round-trips create_component · T2, T7, T9; §11 add-properties/description/expose/slots/binding.
- `combine_variants(componentIds[], {parentId?, name?}) → {id,key, warnings[]}` — combine ≥2 into a variant set; sole variant-combiner; warns if a variant name packs multiple axes into one property (e.g. `Style=PrimaryLarge`), nudging one-property-per-axis (T7/T9) · T6; §11 states/axes.
- `swap_component(instanceId, {mainComponentId?, key?}) → {id, warnings[]}` — point an instance at a different main; accepts EITHER a LOCAL `mainComponentId` (node id, resolved directly) OR a remote `key` (resolved via `importComponentByKeyAsync`, T7-gated — degrades with a warning if the import fails); if both are given the LOCAL `mainComponentId` wins; warns on dropped overrides · T7; §11 migrate/swap.
- `set_instance(instanceId, {properties?, overrides?}) → {id,…, warnings[]}` — the one instance-state path (set variant + BOOLEAN/TEXT/INSTANCE_SWAP via `setProperties`, plus per-node `overrides`); never auto-detaches; **read instance state via `get_node`** (NodeSpec `componentProperties`/`overrides` — the read twin); per-node `overrides` are accepted but degrade with a warning — applying them is reserved for a later phase (T7 degrade) · T6, T9; §6/§11 configure + read-overrides.
- *(instance placement = `create_node`(INSTANCE) by key/id — no separate tool, T6.)*

### Write — design system (8)
- `create_styles([{type, name, value, description?}]) → {results, errors}` — array-create paint/text/effect/grid styles from grammar atom values; partial success (`results:[{id,key,name,type,index}]`, `errors:[{index,error}]`) · T5; §12.
- `update_styles([{id|name+type, value?, newName?, description?}]) → {results, errors}` — array-edit styles' parsed value/name/description; partial success (`results:[{id,index}]`, `errors:[{index,error}]`); round-trips get_styles · T2; §9 brand recolor.
- `delete_styles([{id?} | {name, type}]) → {results:[{id, index}], errors:[{index, error}]}` — array-delete styles by id OR by name+type (same addressing as update_styles); partial success — one entry's failure never aborts the rest; `remove()` feature-detected per entry (T7 degrade to per-entry error if absent); no value-convert (T8 — deletes carry no grammar) · T1, T5, T7; §12 design-system teardown.
- `apply_style(nodeId, styleId, field) → {id, warnings?}` — bind a style to a field (`field`: fill|stroke|text|effect|grid) · T9; §9/§12.
- `create_variables({collection?, collectionId?, modes?, variables[]}) → {collectionId, modes, variables[{id,name}], warnings?}` — add variables to a collection, creating the collection when nothing carries the name; each variable sets per-mode values + `aliases` + `scopes` + `codeSyntax` + `hiddenFromPublishing` on create (parity with update; each gated member feature-detect + T7-degrade) · T9; §12 3-tier/modes/scales/export. **The collection is ADDRESSED, and exactly one address is required: `collection` (a NAME) or `collectionId` (an id) — both, or neither, is `INVALID_PARAM`.** A name **no** collection carries creates one; a name **exactly one** collection carries **EXTENDS that collection** and the reply's `warnings[]` says so; a name **several** collections carry is refused, naming every id, because picking the first is a coin toss the caller does not control (the reasoning B66 applies to a shadowed variable name). Extending is what makes a design system whose `sem/*` aliases live beside its raw tokens buildable at all — an alias needs a target id the first call has not yet returned, and the create-only tool forked instead of appending. **An EXTEND renames no mode**: the collection's modes already hold values for variables this call did not write, so a `modes` entry it lacks is ADDED and one it has is used as it stands (only a NEW collection renames its default mode to the first entry). **A variable name the target collection already holds is skipped with a warning naming `update_variables`** — a second variable of one name inside one collection makes the name ambiguous in the very scope Figma says it is unique in.
- `update_variables({collectionId, addModes?, removeModes?, renameModes?:[{from,to}], variables?:[{id, valuesByMode?, aliases?:{modeName:targetVarId}, scopes?, codeSyntax?, hiddenFromPublishing?}]}) → {collectionId, modes, warnings[]}` — **one collection**: full mode lifecycle (`addModes`/`removeModes`/`renameModes`) + per-variable value/`aliases`/scopes/codeSyntax/hiddenFromPublishing edits; `aliases` maps mode NAME → target variable ID — same shape as `create_variables` (T2 round-trip); alias apply is feature-detected + T7-degraded. Returns `{…, warnings[]}` (T7 degrade), **not** `{results, errors}` — it's a single-collection op, not a heterogeneous batch · T2, T7; §9 recolor-by-token, §12 modes (restored: mode lifecycle).
- `delete_variables({variables?:id[], collections?:id[]}) → {results:[{id, kind:'variable'|'collection'}], errors:[{id, error}]}` — remove variables AND/OR collections by id; collections processed first (cascade removes their variables); partial success — one bad id never sinks the rest; `remove()` feature-detected per entry (T7 degrade to per-id error if absent); at least one of `variables`/`collections` must be non-empty (INVALID_PARAM) · T1, T5, T7; §12 design-system teardown.
- `bind_variable(nodeId, variableId?, field?, clear?, mode?:{[collectionId]:{modeId?|modeName?|clearMode?}}) → {id,…,warnings[]}` — bind a variable to a field (scalar proven, paint feature-detected), UNBIND one (`clear:true` + `field` → `setBoundVariable(field, null)`; mutually exclusive with `variableId`; per-paint fields redirect to per-paint binding with a naming warning), and/or pin a frame to a collection mode via `setExplicitVariableModeForCollection`; at least one of `{variableId+field, mode}` required (handler-enforced); mode uses the OBJECT overload (not deprecated string-id); `clearMode:true` clears the pin; modeName resolved plugin-side against collection.modes; per-entry try/catch so one bad collection never sinks the rest (T7); read-back via `explicitVariableModes` on NodeSpec (read-only map, write is one-collection-per-call) · T2, T7, T8; §9 token-fill, §12 bind + switch-frame-to-mode.

### Write — node metadata & prototype (2 · restored)
- `set_plugin_data(nodeId, key, value, {namespace?}) → {id,…}` — twin of `get_plugin_data`; empty-string value clears the key · T2; §1 persist agent-state.
- `set_reactions(nodeId, reactions[]) → {id, warnings?}` — `setReactionsAsync`; twin of `get_reactions`; feature-detected · T2, T7; §13 wire-prototype (restored).

### Handoff (2 — read/write twin) + Batch (1)
- `get_annotations({nodeId?, cursor?, limit?=100}) → {results, truncated, cursor?, warnings?}` / `set_annotations(nodeId, annotations[]) → {id, warnings?}` — read/overwrite spec notes; matched plural twin; read shape (Rule-A list, bounded by T10: `limit` defaults to **100**, `cursor` continues when `truncated`) == write shape; `get_annotations` omits `nodeId` to read the selection; editorType-gated · T2, T7, T10; §13 annotate.
- `batch({op?, ops:[{op?, …params}]}) → {results, errors[]}` — one or mixed WRITE ops over N existing targets, in order, partial success; the only multi-target mutation path (op set listed under *The one generic batch*) · T5; §9/§11 all "N-call loop" tasks.

## Resolved decisions

- **D1 — Reading bounded by default (T10), one rule per output shape.** List reads → uniform `{results, truncated, cursor?}`: **every** list read is bounded with a default **`limit` (100)**, a `truncated` flag, and an opaque self-contained cursor token returned when truncated — the agent continues by passing the token back verbatim. Tree reads → **depth + always-on budget + truncation receipt + drill-by-id stubs** (no cursor — already bounded, the continuation handle is drill-by-id). `get_node`/`get_nodes` are the **fidelity-first exception** (bounded by `depth=0`, never budget-truncated, no budget/match/cursor, T2). Destructive event drains → **`limit` + `truncated` + a truncation receipt, no cursor** (exemplar `pull_changes` — [[figma-bridge/docs/specs/change-feed|change-feed.md]]): consumption is the position, so the unretrieved remainder is the continuation and there is nothing a resume token could resume from; the payload is named `changes`, not `results`, because these are events; and `remaining` reports the shape of what is left, which an event backlog has and a query result does not. Uniform across every API of its shape — learned once. **`get_components` additionally gates its expensive scan**: remote/library discovery is opt-in (`includeRemote=false` by default skips the O(document) all-instances scan — the live timeout fix), and the resulting list is then paged server-side by `limit`/`cursor` like every other list read (a remote-component cache is the future fix). *(Re-alignment: an earlier reconciliation had dropped the cursor from the naturally-bounded readers as an "improvement"; T10 reverses that and restores the cursor on every list read — the original Rule-A contract, not a new divergence.)*
- **D2 — Projection.** `fields:[...]` allow-list **+ presets** (`minimal/layout/style/text/full`); no deny-list. Same param on every node-returning read.
- **D3 — Batch.** One `batch` tool, one shape `{op?, ops:[{op?,…}]}` — top-level `op` default (homogeneous, compact) or per-entry `op` (heterogeneous); in-order, partial-success, best-effort; ordering guarantees are within-op only (cross-entry deps are the agent's to sequence); entries warn like single calls. Scope is WRITE ops over existing targets (create-* excluded).
- **D4 — Defaults.** `get_node`/`get_nodes` depth=0 (fidelity-first, no budget — a capped edit read would break T2); `inspect` budget-adaptive level-fill, **always budget-capped** (default **20,000**): neither `depth` nor `budget` → depth=0; `depth=n` → n levels, then capped; `depth=-1` → every level, then capped; `budget` alone → level-fill to that budget. Depth chooses **where** truncation lands, the budget decides **whether** it happens — so no combination of arguments yields an unbounded read (T10). Same rule, job-tuned defaults.
- **D5 — Naming.** `get_X` / `create_X`+`update_X`; `set_X` only for whole-state writes; `inspect`/`get_node` the one deliberate two-name split (encodes T3). **Documented naming exceptions** (read-many vs write-one, or operation-shaped): `list_pages`↔`create_page`/`set_current_page` and `get_components`↔`create_component`/`update_component` (plural enumeration read vs singular promote/edit-one write); `set_focus` (viewport writer). Genuinely **operational** capabilities use verb names (`boolean_op`, `flatten`, `combine_variants`, `swap_component`, `clone_node`, `reparent_node`, `reorder_children`, `apply_style`, `bind_variable`, `create_from_svg`) — the get/create/update/set scheme governs CRUD-shaped tools, not every tool. **Reads that consume/drain server state (non-idempotent) take a consumption verb, never `get_`** — exemplar `pull_changes` (change-feed.md), which pops+clears a buffer, so a `get_` prefix would falsely imply an idempotent read.
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
