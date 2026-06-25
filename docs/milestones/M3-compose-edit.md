---
title: M3 — Compose, Edit & Batch
created: 2026-06-25T15:30:00+08:00
tags:
  - figma-bridge
  - milestones
  - tool-surface
type: plan
related:
  - "[[figma-bridge/docs/milestones/README]]"
  - "[[figma-bridge/docs/milestones/M2-read-write]]"
  - "[[figma-bridge/docs/principles]]"
---

# M3 — Compose, Edit & Batch · **planned**

The powerful layer on top of M2: composable construction, bulk edit, design-system authoring,
and components/instances. Builds on M2's foundations + the proven round-trip; completes the
47-tool surface.

## Scope

**Composable construction**
`create_tree` (recursive + ref-pool) · `clone_node` · `reparent_node` · `reorder_children` · `boolean_op` · `flatten`. *(`boolean_op`/`flatten` sit here as compositional geometry ops — single-call multi-input, not M2 simple writes.)*

**Bulk**
`batch` — the one generic multi-target edit path (homogeneous + heterogeneous; in-order, partial-success, best-effort).

**Design-system authoring**
`create_variables` (+ modes) · `update_variables` (mode lifecycle) · `create_styles` · `update_styles` · `apply_style`.

**Components & instances**
`create_component` · `update_component` · `combine_variants` · `swap_component` · `set_instance`.

## Ships

Build whole trees, bulk-edit at scale, author the design system, and compose reusable
components — the full 47-tool surface complete.

## Status

**planned** — sketched in the build plan (P3–P6 + the Track-X write-face); detailed when M2 lands.

## Absorbs

The old M4 "Tool-Surface Harvest" (45 tools) — the clean-start 47-tool surface **replaces**
(not extends) it; the compose/write capability M4 would have added is delivered natively across
M2/M3.

## Working doc (untracked)

- Build plan (later phases sketched): `docs/scratch/plans/2026-06-25-tool-surface-clean-build-plan.md`.
