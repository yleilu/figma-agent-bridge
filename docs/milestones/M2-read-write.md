---
title: M2 — Parse, Read & Simple Write
created: 2026-06-25T15:30:00+08:00
tags:
  - figma-bridge
  - milestones
  - tool-surface
type: plan
related:
  - "[[figma-bridge/docs/milestones/README]]"
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
  - "[[figma-bridge/docs/reference/figma-task-checklist]]"
---

# M2 — Parse, Read & Simple Write · **done**

The substrate plus everything an agent needs to **read any design and make simple
single-target edits**, on the new clean-start spec. Greenfields the tool + value layers;
keeps the bridge (M1). Governed by B1/T1–T9/P1.

## Scope

**Parsers / foundations**
- `NodeSpec` (the one round-trip shape) + the frozen server↔plugin command registry.
- The atom expression grammar — **both faces** (parse + render) with a round-trip suite.
- Read-model infra: opaque cursor (list reads), depth + always-on budget + truncation-receipt drill-by-id (tree reads), `fields` projection + presets, `match` filter.
- The pure write-converter (`specToFigma`, omitted-untouched semantics).

**Reads (all)**
`inspect` · `get_node` · `get_nodes` · `search` · `list_pages` · `get_selection` · `get_styles` · `get_variables` · `get_components` · `list_fonts` · `get_reactions` · `get_plugin_data` · `get_annotations` · `export` · `status` / `connect`.

**Simple (single-target) writes**
`create_node` (one node) · `update_node` · `delete_node` · `set_selection` · `set_focus` · `create_page` / `set_current_page` / `duplicate_page` · `create_from_svg` · `create_image` · `bind_variable` (bind an existing variable) · `set_plugin_data` · `set_reactions` · `set_annotations`.

**Capstone — round-trip-proof slice:** `get_node` ↔ `update_node` + `bind_variable`, end-to-end through the real plugin — locks T1/T2 (symmetric round-trip), the read-model, and feature-detect honesty (T7) before the M3 fan-out.

## Ships

The agent can **read any design in the new grammar + read-model and make simple edits**
(create/update a node, bind a token, page/selection/viewport ops) — round-trip-safe.

## Status

**done** — built clean on `feat/m2-tool-surface` and merged to `dev` (merge `0cb85e1`): 9
commits across P0 foundations → slice → reads → simple writes → legacy retirement →
multi-selection inspect. **732 tests green**, 32 MCP tools registered. Each chunk ran
build → code-review → green-gated commit; the bridge layer was untouched.

**Carried to M3 / verification:** `create_tree`/`create_component` still old-format (M3
rebuilds them); per-side-stroke write `TODO(M3)`; the Variables runtime re-introspection
(gates M3 DS-authoring); package.json exports hardening; and the **live-Figma manual
verification** (the suite is mock-plugin-over-real-relay / headless).

## Working docs (untracked — `docs/scratch/` is gitignored)

- Design: `docs/scratch/tool-surface-design.md` (the 47-tool surface + Resolved decisions).
- Build plan (P0 + slice detailed): `docs/scratch/plans/2026-06-25-tool-surface-clean-build-plan.md`.

## Committed inputs

- Requirements: [[figma-bridge/docs/reference/figma-task-checklist]] · grammar: [[figma-bridge/docs/specs/expression-formats]] · ceiling: [[figma-bridge/docs/reference/figma-plugin-api]] · practice (T9): [[figma-bridge/docs/reference/figma-professional-practice]].

## Seam with M3

`create_node` (single, simple) is here; `create_tree` (recursive + ref-pool) is **M3**.
`bind_variable` (use an *existing* variable) is here; variable/style **authoring** is **M3**.
M2 can *use* the design system; M3 *builds* it. (`apply_style` — applying an existing style —
ships in **M3** alongside style authoring, a deliberate grouping exception to the use-in-M2
rule, since style application travels with the styles it applies.)
