---
title: figma-agent-bridge Milestones
created: 2026-06-22T17:00:00+08:00
tags:
  - figma-bridge
  - plan
  - milestones
  - index
type: plan
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/plans/2026-03-17-m1-foundation]]"
  - "[[figma-bridge/docs/plans/2026-03-19-m2-read-parse]]"
  - "[[figma-bridge/docs/plans/2026-03-22-m3-build-create]]"
  - "[[figma-bridge/docs/plans/2026-03-22-m3-post-review-fixes]]"
  - "[[figma-bridge/docs/plans/2026-06-22-tool-surface-harvest-brief]]"
---

# figma-agent-bridge — Milestones

> Governed by [[figma-bridge/docs/principles|the principles]]. This is the **index** — one entry per milestone. Goal, status, and links only; the detail lives in each plan/spec. Reference, don't restate.

## Status legend

| Status | Meaning |
|--------|---------|
| **planned** | Scoped but not yet specified or built. |
| **spec** | A binding spec exists; implementation not started. |
| **in progress** | Under active implementation. |
| **done** | Shipped and review-closed. |

## M1 — Foundation · **done**

Get the three-layer architecture (MCP server ↔ relay ↔ Figma plugin) running end-to-end with `connect`/`status`, full test infrastructure, and CI-ready linting. Establishes the Bun monorepo (figma-plugin, relay, server, cli, shared) and the mock-plugin test path.

- Plan: [[figma-bridge/docs/plans/2026-03-17-m1-foundation]]

## M2 — Read & Parse · **done**

Build the server-side parsing layer and all read tools so the agent can understand any design — `inspect_*` (compact YAML, breadth) vs `get_*` (faithful JSON, fidelity), plus list pages, discover styles/components, search nodes, export images. All pure reads. Implements the view-vs-edit split (T3).

- Plan: [[figma-bridge/docs/plans/2026-03-19-m2-read-parse]]

## M3 — Build & Create + post-review · **done**

The four write tools — `create_node`, `create_tree`, `create_component`, `create_from_svg` — across all 18 Figma node types with round-trip fidelity (`create_node` input = `get_node` output, T2). The post-review pass fixed five type-safety, consistency, and error-reporting issues (discriminated-union expressions, hex-regex alignment, schema/registration cleanup, `createSlot` feature-detection).

- Plan: [[figma-bridge/docs/plans/2026-03-22-m3-build-create]]
- Follow-up: [[figma-bridge/docs/plans/2026-03-22-m3-post-review-fixes]]

## M4 — Tool-Surface Harvest · **spec**

Author the full agent-facing tool surface: the trimmed + feasibility-fixed harvest of the autoresearch R36 spec (94 tools → **45**), closing the edit gap (mutation core, design-system writes, components/instances, handoff & text) and restoring round-trip symmetry (T1/T2). One generic `batch` tool is the sole multi-target path. **Ships atomically** — all 45 exposed together, one minor bump, so the round-trip guarantee always holds.

- Spec: [[figma-bridge/docs/specs/tool-surface]]
- Input brief: [[figma-bridge/docs/plans/2026-06-22-tool-surface-harvest-brief]]
