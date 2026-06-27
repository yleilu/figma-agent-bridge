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

**What this is:** real Figma capabilities (and surface-symmetry holes) that we **know exist** but have **deliberately deferred** — they are *not bugs* and *not in scope* for the current live-sweep bug-fix pass. A "gap" here = **a feature to be fulfilled later**, once it gets a **full review + plan**.

**Why they're separate from bugs:** bugs are **code↔spec** mismatches (the spec declares it, the code is wrong → fix the code). These gaps are **spec↔principles** mismatches — the **spec itself never declared them**, so it's incomplete relative to its governing principles (T1 symmetry, T6 "expose every distinct capability", T2 round-trip). See `principles.md`.

> **Process gate — do NOT fill these piecemeal.** Before implementing *any* of these, run a **spec-completeness audit** (sweep the spec against T1/T6/T2 to surface the *full* set, not just the ones a sweep happened to hit), then per feature: **brainstorm → update the spec first → plan → build** (cascade per the doc-management hierarchy). Several of these are one coherent family and should be decided together.

Surfaced 2026-06-27 during the comprehensive live tool sweep + per-issue spec review.

## T6 — real Figma capabilities not yet exposed

| Capability | Figma API (verified real) | Current status | What fulfilling it needs |
|---|---|---|---|
| **css-grid / GRID auto-layout** | `frame.layoutMode='GRID'` + `gridRowCount`/`gridColumnCount`/`gridRowGap`/`gridColumnGap` | **Dropped from spec** (issue #1) — was specced but never built | re-introduce the `css-grid` struct, plugin apply, reader read-back, tests |
| **TEXT_PATH** (text on a path) | `figma.createTextPath(vector, startSegment, startPosition) → TextPathNode` (typings 1.123.0) | **Honest-rejected** (issue #3) — removed from `CREATABLE_TYPES` | wire `vectorNodeId`/`startSegment`/`startPosition` through the writer, add to `NodeSpec`, spec it, read-back (also depends on having a VectorNode to flow along) |
| **Masks** | `node.isMask` (+ `maskType`) | Not exposed (no `NodeSpec` field) | `isMask` field → writer + plugin apply + reader; masking has sibling-ordering semantics |
| **`create_tree` declarative composites** — `GROUP`, `BOOLEAN_OPERATION`, `TRANSFORM_GROUP` | children-combining node types (plugin handlers existed but unspecced) | **Honest-rejected** (issue #2) — `create_tree` now validates against `CREATABLE_TYPES`; booleans available via the **`boolean_op` tool** | decide the family together: design how a tree declares "combine these children" + the fields + spec, OR keep routing to the dedicated tools |
| **GROUP creation** | `figma.group(nodes)` | Not exposed (FRAME-only; T9 prefers frames) | a `group_nodes` op **or** a documented deliberate omission — but **GROUP must at least round-trip on read** (T2) so existing files aren't silently flattened |
| **Library/remote instance round-trip** (T2) | `getMainComponentAsync()` on the read path | `create_node(INSTANCE)` works by `key` *and* `id` (issue #4), but `get_node` reads back only `{ id }` — so **local** instances round-trip while **published/library** ones don't (the remote `id` won't resolve on re-create) | emit `component.key` for published instances on read by augmenting `exportNodeDocument` per-INSTANCE via `getMainComponentAsync` (**perf-sensitive** — same O(instances) shape as the get_components scan), then prefer `key` when the main is remote |

## T1 — symmetry / CRUD holes

| Capability | Figma API | Current status | What fulfilling it needs |
|---|---|---|---|
| **`delete_variables` / `delete_styles`** | `collection.remove()` · `variable.remove()` · `style.remove()` | Missing — `create_*` with no `delete_*` (live sweep left `SweepTokens`/`Sweep/*` stranded) | the two delete tools (+ confirmation/guard semantics) |
| **`delete_page` handling** | `page.remove()` (via existing `delete_node`) | `delete_node` works on pages but **fails on the current/last page** | a current-page guard in `delete_node` (switch-then-remove, or clear error) — small; arguably a fix, not a new tool |

## Test-infrastructure (deferred quality)

- **Comprehensive plugin-apply unit-test layer.** The 917-test suite exercises a **mock stand-in**, never the real plugin — so plugin-side crashes/no-ops are invisible until live (this is the root reason the whole conversion-shape/field-strip/constraints class stayed live-only). The bug-fix pass adds only *targeted* plugin-apply tests; the durable fix is unit-testing the plugin's apply functions directly against `@figma/plugin-typings`.

## See also
- `docs/principles.md` (T1/T2/T6 — why these are obligations)
- `docs/specs/tool-surface.md` · `docs/specs/expression-formats.md` (the spec these complete)
- `docs/reference/api-coverage.md` (canonical Figma-API coverage checklist — reconcile statuses here)
- `docs/scratch/plans/2026-06-27-bug-sweep-fixes.md` (the bug-fix pass these are deferred from)
