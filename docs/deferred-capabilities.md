---
title: Deferred Capabilities — Spec-Completeness Backlog
created: 2026-06-27T16:00:00+08:00
tags:
  - figma-bridge
  - spec
  - backlog
  - deferred
type: reference
---

# Deferred Capabilities — Spec-Completeness Backlog

**What this is:** real Figma capabilities (and surface-symmetry holes) that we **know exist** but have **deliberately deferred** — they are _not bugs_ and _not in scope_ for the current live-sweep bug-fix pass. A "gap" here = **a feature to be fulfilled later**, once it gets a **full review + plan**.

**Why they're separate from bugs:** bugs are **code↔spec** mismatches (the spec declares it, the code is wrong → fix the code). These gaps are **spec↔principles** mismatches — the **spec itself never declared them**, so it's incomplete relative to its governing principles (T1 symmetry, T6 "expose every distinct capability", T2 round-trip). See `principles.md`.

> **Process gate — do NOT fill these piecemeal.** Before implementing _any_ of these, run a **spec-completeness audit** (sweep the spec against T1/T6/T2 to surface the _full_ set, not just the ones a sweep happened to hit), then per feature: **brainstorm → update the spec first → plan → build** (cascade per the doc-management hierarchy). Several of these are one coherent family and should be decided together.

Surfaced 2026-06-27 during the comprehensive live tool sweep + per-issue spec review.

## T6 — real Figma capabilities not yet exposed

| Capability                                                                                 | Figma API (verified real)                                                                    | Current status                                                                                                                                                                                                                | What fulfilling it needs                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **css-grid / GRID auto-layout** — ✅ **SHIPPED (M12, merged e87cc39)**                    | `frame.layoutMode='GRID'` + `gridRowCount`/`gridColumnCount`/`gridRowGap`/`gridColumnGap`    | ✅ **SHIPPED (merged e87cc39):** `layout.mode:'GRID'` + `rows/cols/rowGap/colGap` on the `LayoutSpec` struct; writer/reader/plugin-apply all wired; feature-detected (T7 — degrades gracefully on old runtimes). Deferred follow-on: `gridRowSizes`/`gridColumnSizes` (track sizing) + per-child `gridRowSpan`/`gridColumnSpan`/`gridChild*Align` (child placement) — see GRID follow-on row below. | Done — see GRID follow-on row for remaining track-sizing/child-placement deferral. |
| **TEXT_PATH** (text on a path)                                                             | `figma.createTextPath(vector, startSegment, startPosition) → TextPathNode` (typings 1.123.0) | **Writer DEFERRED — M11 ship-gate failed live (2026-07-18):** `createTextPath` works + creates a TEXT_PATH, but `get_node` cannot recover the source-vector ref — `TextPathNode.vectorNodeId`/`startSegment`/`startPosition` are NOT exposed at runtime (and the node has no readable `vectorPaths`), so the write is write-only → deferred per T2 (never ship a write-only tool). Text content DOES read back; existing TEXT_PATH nodes still read type+text. Full impl preserved on unmerged branch `feat/m11-textpath`. | Re-enable when the runtime surfaces the source-path ref on `TextPathNode` (then finish the export enrichment + merge `feat/m11-textpath`). |
| **Masks** — ✅ **SHIPPED (M9, merged 0fa4612)**                                            | `node.isMask` (+ `maskType`)                                                                 | ✅ **SHIPPED (merged 0fa4612):** `isMask` + `maskType` fields wired — writer, plugin-apply, and reader all handle mask round-trip. Sibling-ordering semantics documented.                                                     | Done. |
| **`create_tree` declarative composites** — `GROUP`, `BOOLEAN_OPERATION`, `TRANSFORM_GROUP` | children-combining node types (plugin handlers existed but unspecced)                        | **Partial:** `GROUP` ✅ SHIPPED as `group_nodes` (M10, merged f959647); `TRANSFORM_GROUP` ✅ SHIPPED as `transform_group` (M15, merged 5e7f613). `BOOLEAN_OPERATION` remains **honest-rejected** — `create_tree` validates against `CREATABLE_TYPES`; booleans route to the **`boolean_op` tool**. | `BOOLEAN_OPERATION` in `create_tree`: decide whether to surface it here or keep routing to `boolean_op`. GROUP and TRANSFORM_GROUP resolved. |
| **GROUP creation** — ✅ **SHIPPED (M10, merged f959647)**                                  | `figma.group(nodes)`                                                                         | ✅ **SHIPPED (merged f959647):** `group_nodes` tool added; GROUP read round-trip also wired (T2 — existing GROUP nodes no longer silently flattened).                                                                          | Done. |
| **GRID layout — track sizing + child placement (M12 follow-on)**                          | `gridRowSizes`/`gridColumnSizes` (track sizing) + per-child `gridRowSpan`/`gridColumnSpan`/`gridChild*Align` (child placement) | **Deliberately deferred** (drop-nothing rule) — M12 ships `rows/cols/rowGap/colGap` on the frame; these per-track/per-child properties are a natural follow-on. No code removed. | design per-track struct (fixed/auto/fr sizing per track), per-child grid-area fields on `NodeSpec`, writer + plugin-apply + reader read-back |
| **Library/remote instance round-trip** (T2) — ✅ **SHIPPED (M14, merged 7bc5618)**         | `getMainComponentAsync()` on the read path (ROOT-ONLY, T10)                                  | ✅ **SHIPPED (merged 7bc5618):** ~~`get_node` reads back only `{ id }`~~ — **FIXED**: `get_node`/`get_nodes`/`inspect` now emit `component.{id, key, remote:true}` for the directly-requested INSTANCE root via `getMainComponentAsync` (feature-detected, T7); `create_node(INSTANCE)` prefers `importComponentByKeyAsync(key)` when `remote===true`, falls back to `id` (T7). **Root-only asymmetry (T10):** the same instance reads back `key+remote` when it is the get_node root but `id-only` when it is a descendant inside a deep inspect — deliberate bounded-scan optimization, not inconsistency. `component.remote` is a read-emitted hint, not a gate; no `includeRemote` flag. | Done — resolved via `isRoot` gating. |

## T1 — symmetry / CRUD holes

| Capability                               | Figma API                                                      | Current status                                                                             | What fulfilling it needs                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **`delete_variables` / `delete_styles`** — ✅ **SHIPPED (M1a/M1b, merged 1f8fada)** | `collection.remove()` · `variable.remove()` · `style.remove()` | ✅ **SHIPPED (merged 1f8fada):** `delete_variables` and `delete_styles` tools added; CRUD symmetry with `create_*` restored. | Done. |
| **`delete_page` handling (page-guard)** — ✅ **SHIPPED (M4, merged 1f8fada)**        | `page.remove()` (via existing `delete_node`)                   | ✅ **SHIPPED (merged 1f8fada):** current-page guard added to `delete_node` — switches away then removes, or returns a clear error if it is the last page. | Done. |

## Shipped in M-build (2026-07-18) — items not previously tracked as deferred

The following capabilities were built and merged to `dev` as part of the M-items build. They were not listed in the deferred tables above (they arose from the same spec-completeness audit), so they are recorded here for traceability.

| Capability | Merged sha | Notes |
| ---------- | ---------- | ----- |
| **Slots — define (createSlot via `update_component`) + fill (append into an instance's slot)** (M2) | `2c5e83f` | ✅ SHIPPED. Slot definition on components + slot-filling on instances. |
| **VECTOR `vectorPaths` authoring + round-trip, the `path()` atom, re-homed `pointCount`/`innerRadius`/`sectionContentsHidden`, field-symmetry meta-test** (M3) | `4430194` | ✅ SHIPPED. Closes the **field-strip class** for `vectorNodeId`/`booleanOperation`/`component` fields — these are now correctly wired through writer→plugin. `vectorPaths` (V1/V2) merged; full bezier `vectorNetwork` (V3) remains deferred — see "Read round-trip limitations" section below. |
| **Variable aliases round-trip (B2) + per-node explicit variable-mode selection** (M13) | `3453977` | ✅ SHIPPED. Variable-alias expressions resolve through the alias chain on read; per-node `variableMode` override field added. |
| **`transform_group` (`figma.transformGroup` repeat-pattern)** (M15) | `5e7f613` | ✅ SHIPPED. `transform_group` tool added; enables repeat-pattern layout via `figma.transformGroup`. |

## Authoring ergonomics (surfaced 2026-07-06 — analytics-dashboard capability demo)

Two real DX gaps hit while building a full dashboard end-to-end through the tools:

- **`update_component` adds property definitions but does NOT bind them to nodes.** The `add` path only calls `comp.addComponentProperty(name, type, defaultValue)` (`packages/figma-plugin/src/code.ts` ~:1891); it never sets any node's `componentPropertyReferences`. So a TEXT/BOOLEAN/INSTANCE*SWAP property is created but **inert** — `set_instance` sets the property \_value*, yet no node reflects it (labels/values don't change). Only VARIANT props (set-level) work. **Effect: data-driven instances aren't possible** — every instance shows the same baked text, so varied content (KPI cards, nav labels, table rows) must be built directly instead of as instances. Fulfilling it: let `add`/`edit` bind a property to a node+field (e.g. `{name, type, boundTo:{nodeId, field:'characters'|'visible'|'mainComponent'}}`), or auto-bind by matching a text node whose name equals the property name; then round-trip the bindings on read (T2). _(Confirmed the binding is absent by reading the handler, not just observed.)_
- **An auto-layout frame with an explicit `size` still HUGs (ignores the size) unless `sizing:['FIXED','FIXED']` is set.** `size:[1440,900]` + a `layout` produced a frame that collapsed to hug its content — the explicit size was silently ignored because the container's axis-sizing modes default to AUTO/HUG. Least-surprise fix: when a node has BOTH `layout` and an explicit `size`, default its sizing to FIXED (respect the size) unless `sizing` overrides; at minimum document it. (Cost one rebuild in the demo.)

## Read round-trip limitations (JSON_REST_V1 gaps)

- **`vectorNetwork` / `setVectorNetworkAsync` — full bezier authoring (M3-V3, DEFERRED).** `vectorPaths` (M3-V1/V2, ✅ SHIPPED merged `4430194`) covers VECTOR node write + read-back for non-curved paths via `node.vectorPaths`. The deeper `vectorNetwork` API (`VectorNetwork` with bezier handles, vertices, segments, regions) enables exact bezier editing but requires a non-atom struct grammar (it is a complex nested object, not a string). **Consequence:** `vectorPaths` read-back from `get_node` is a **documented lossy projection** for pre-existing vectors that have bezier curves or multi-region shapes — their _exact_ geometry lives in `vectorNetwork`, not `vectorPaths`. This is a deliberate, documented T2 asymmetry (T7 honest: the limitation is stated here and in `expression-formats.md`), not a silent gap. **To fulfill:** design the `vectorNetwork` struct grammar, add a `vectorNetwork` field to `NodeSpec`, implement writer + plugin apply (`setVectorNetworkAsync`) + reader read-back.

- **Rotated-node size/position read-back.** `JSON_REST_V1` carries only `absoluteBoundingBox` (no `relativeTransform`), so for a ROTATED node the reader returns the axis-aligned bounding box, not the unrotated geometry — e.g. a 60×60 rect rotated 30° reads back size ≈ `[81.96, 81.96]` at a shifted origin. The 2026-06-28 transform-family pass fixed `rotation` units (radians→degrees) and ABSOLUTE-child positioning, but the rotated bbox itself can't be un-rotated without the transform. Durable fix: have the plugin attach `relativeTransform` (or the unrotated width/height + x/y) to the read export, like the parent-relative position approach. Same root cause as the C5 position limitation.
- **`get_node` `profile` crashes on an unrecognized value.** An invalid `profile` arg throws `"undefined is not an object (evaluating 'keys')"` instead of a clean error; valid values (`minimal`/`layout`/`style`/`text`/`full`) work. T7 robustness — validate the enum and return a clear message (or fall back to `full`).
- **`get_node` gradient angle read-back is lossy — every gradient reads back as `linear(0)`.** A linear gradient written at any angle RENDERS correctly (verified 2026-07-16: `linear(135)` exports a true diagonal, and Figma stores correct `gradientHandlePositions`), but `get_node`/`get_nodes`/`inspect` project it back as `linear(0)`. Root cause: `serialize/node-spec-reader.ts:~234` recovers the gradient direction from `p.gradientTransform`, but the plugin's read serializes the direction as `gradientHandlePositions` and sends **no** `gradientTransform`, so the reader takes the identity-matrix fallback (`[[1,0,0],[0,1,0]]` = 0°) and ignores the handle positions. NOT a write/render bug and NOT a Figma-runtime normalization (earlier fixture/spec notes mischaracterized it). Durable fix: derive the transform from `gradientHandlePositions` when `gradientTransform` is absent (they're interconvertible), or have the plugin include `gradientTransform` in the read. High-leverage — the false read-back makes an agent distrust correct output and downgrade (e.g. choosing a radial banner to dodge a non-existent problem).

## Tooling / workflow

- **Auto-reconnect-with-backoff (deferred).** **Shipped 2026-06-28:** the `close_plugin` internal command (`figma.closePlugin()`) + the channel-persistence fix (keep `channel-id` across an unintended close; clear only on explicit Disconnect) _(mechanism superseded by per-file channels — reload determinism now comes from binding the channel to `fileKey`; see [[figma-bridge/docs/specs/overview|overview.md]] Connection lifecycle)_ + `scripts/reload-plugin.sh` — so the **rebuild → close → reopen → auto-reconnect → verify** loop reloads new `dist/code.js` headlessly (see `docs/specs/overview.md` Connection lifecycle). The remaining nice-to-have is auto-**re**connect-with-backoff so a _live_ plugin self-heals when its socket drops while it stays open (relay restart, network blip), not only on relaunch. Add only if live relay-restart drops prove annoying.

## Test-infrastructure (deferred quality)

- **Comprehensive plugin-apply unit-test layer.** The headless suite exercises a **mock stand-in**, never the real plugin — so plugin-side crashes/no-ops were invisible until live (the root reason the conversion-shape/field-strip/constraints class stayed live-only). **Partially realized** by the 2026-06-27 bug-fix pass: the layout-apply and instance-prop-resolver logic were extracted into pure, headlessly-tested modules (`apply-layout.ts`, `resolve-instance-props.ts`). The durable fix is to continue extracting `applyCommonProperties`' field-applies (constraints, grids, effects, sizing) into pure helpers tested against `@figma/plugin-typings`.
- **B-i — writer↔plugin field-symmetry test.** A meta-test asserting every `spec.<field>` the plugin reads is declared in `NodeSpec` and copied by the writer — catches the field-strip class (the bug behind `booleanOperation`/`vectorNodeId`/`component`) before it ships. Deferred from the bug-fix pass (the actual fields are resolved — the field-strip class is now fully closed by M3, merged `4430194`; this guard is a fragile-to-author hardening step worth its own focused effort).
- **B-ii — reject/warn on unknown `NodeSpec` fields.** The node-spec schema currently strips/ignores unknown fields silently; rejecting or warning would surface a typo'd/unsupported field (T7) instead of a confusing downstream `undefined`. Hardening, not a live-sweep bug.

## Distribution & publishing (surfaced 2026-07-10 — dev-ops workflow design)

- **Public Figma Community distribution — self-issued `fileKey`.** The plugin sets `enablePrivatePluginApi: true` and reads `figma.fileKey`, which Figma restricts to **private/Organization plugins and Figma-owned resources** — public Community plugins are deliberately barred from the file key ([developers.figma.com/docs/plugins/api/figma](https://developers.figma.com/docs/plugins/api/figma/)). So the plugin **cannot be published to the public Community as-is**. **Current path:** the fig-plugin travels as a **manifest-import payload** inside the Claude Code plugin package (`docs/specs/claude-plugin.md` §5.1) and is imported by the user — a privately distributed plugin, so the private API stays available and no Figma review is involved. **Deferred:** public Community distribution (to be discussed before building). **Plan when we do it:** keep the same identity key name **`fileKey`** on the wire/register protocol, but populate it with an **id we generate ourselves** — a stable per-file id stored on the document via `figma.root.setPluginData`/`getPluginData` (survives sessions, shared across collaborators on the same file) — and drop `enablePrivatePluginApi`. This is **transparent to the server**, which already trusts whatever id the plugin reports on `register`; only the _source_ of the value changes. Trade-off: we lose the _real_ Figma file key (no Figma REST-API correlation), which the localhost bridge does not use today. See the dev-ops spec's distribution section.

## Dev-ops — deferred verification & follow-ups (surfaced 2026-07-11 — dev-ops workflow shipped)

The dev-ops workflow is **built + merged to dev** (CI gate, release pipeline, and the npm-published Claude Code plugin package — see `docs/specs/dev-ops.md`). The headless-verifiable parts are done and green; the following need a real machine / app / release and are **deliberately deferred** — the workflow is treated as complete:

- **Live installs (human, GUI/CLI):** the Claude Code plugin install + run on a box **with Bun on PATH** (including that the package installs inert — no dependency-install step); and, since **Bun is a prerequisite of every route** (`docs/specs/dev-ops.md` §3.1), that a **missing Bun** surfaces the clear error the design promises — pointing at the README check-install — rather than failing silently; the **Windows** path (Bun `.mcp.json` PATH resolution on a real Windows box); the Figma plugin **manifest import** from the path `figma-setup` reports, including that an upgrade needs no re-import.
- **Real release run:** `release.yml` executes only on a pushed `v*` tag with the `FEEDBACK_WORKER_URL` repo secret set — cutting a first tagged release validates gate → server bundle + Figma plugin build → package publish → fig-plugin zip → GitHub Release end-to-end.
- **Claim the npm package name before the first publish:** the `figma-agent-bridge` name must be owned on the registry and a publish token wired into CI — the marketplace entry resolves the plugin from there, so the first tagged release cannot ship without it.
- **Pin Bun before enabling cloud CI:** Bun is the toolchain that builds the published server bundle, and CI (`oven-sh/setup-bun@v2` = latest) is unpinned, so what a release ships depends on whichever Bun the runner happens to install. Pin it (`setup-bun` `bun-version` + a `.bun-version`) so the server bundle builds reproducibly across runs.
- **Windows coverage for the plugin's hooks:** the shipped hooks are bash scripts using `jq` and `curl`. No Windows-native equivalent or graceful degradation exists when a shell/`jq` is absent — behaviour there is unaddressed, not just unverified.
- **P2 / P3 (non-code):** cloud CI turns on the moment `dev`/branches are pushed (`ci.yml` already triggers); PR-gated merges are a GitHub branch-protection toggle on `dev`/`main` requiring the `ci` check.

First-release recipe: bump root `package.json` → `bun run release:stamp` → commit → tag `vX.Y.Z` → push (CI builds the server bundle + Figma plugin, publishes the package to the registry, and cuts the GitHub Release).

## Skill guidance (figma-design) — deferred improvements (surfaced 2026-07-16 — skill-in-loop QA)

Improvements to the **shipped `plugin/skills/figma-design/SKILL.md`** (the design methodology
agents run), not the tools. Both verified live on a skill-in-loop Northwind build.

- **Component-first must extend to CONTAINERS / SHELLS, not just repeated atoms.** The
  current rule — *"repeated elements become components"* — drives agents to componentize leaf
  atoms (nav item, KPI card, chip) and shared chrome (top-bar, logo) but leaves layout
  containers (`sidebar`, `menu`, `app-shell`) as one-off FRAMEs. Those repeat **across
  screens**, so a multi-screen build duplicates the sidebar/shell N times. Verified: the
  skill-in-loop Overview had 22 components, yet `shell/sidebar`, `NavMenu`, and `shell/app`
  were all frames. Fix: add an explicit rule — *a container or shell that repeats across
  screens (sidebar, app-shell, page header/footer) is itself a component: build it once and
  instance it per screen.*

- **Prevent component-master collision — don't pile masters at `[0,0]`.** Agents create
  component masters with no position, so `create` defaults them to the page origin; they stack
  on each other and over the canvas content. Verified: 22 masters + orphan `Spark`/`GasChip`
  frames piled at `[0,0]` over the Overview. Fix: the skill should mandate a deliberate home
  for masters — a dedicated **`Components` page**, or an off-canvas laid-out grid with spacing
  — placed explicitly, never relying on the `[0,0]` default. (Complements the tool-side
  collision-aware auto-placement idea, but the skill should not depend on a tool fix landing.)

## See also

- `docs/principles.md` (T1/T2/T6 — why these are obligations)
- `docs/specs/tool-surface.md` · `docs/specs/expression-formats.md` (the spec these complete)
- `docs/reference/api-coverage.md` (canonical Figma-API coverage checklist — reconcile statuses here)
- `docs/scratch/plans/2026-06-27-bug-sweep-fixes.md` (the bug-fix pass these are deferred from)
