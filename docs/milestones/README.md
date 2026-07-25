---
title: figma-agent-bridge Milestones — Index
created: 2026-06-25T15:00:00+08:00
tags:
  - figma-bridge
  - milestones
  - index
type: index
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
---

# figma-agent-bridge — Milestones

> Governed by [[figma-bridge/docs/principles|the principles]]. This is the **index / status
> tracker** — one row per milestone (goal + status + link). Each milestone file holds the
> scope; detailed working specs/plans live in its links. Reference, don't restate.
>
> The milestone lineage is the **clean-start (new spec)** track: M1 Foundation is kept as-is;
> the tool + value layers are rebuilt across M2–M3. The earlier old-spec Read/Build/Harvest
> milestones are **superseded** (see below).

## Status legend

| Status | Meaning |
|--------|---------|
| **planned** | Scoped but not yet specified or built. |
| **spec** | A binding spec/design exists; implementation not started. |
| **in progress** | Under active implementation. |
| **done** | Shipped and review-closed. |

## Milestones

| # | Milestone | Goal (one line) | Status | Doc |
|---|---|---|---|---|
| M1 | Foundation | Three-layer architecture (server ↔ relay ↔ plugin) + test infra — **kept** by the clean start. | **done** | [[figma-bridge/docs/milestones/M1-foundation\|M1-foundation]] |
| M2 | Parse, Read & Simple Write | Parsers + read-model + all reads + simple single-target writes + the round-trip-proof slice. | **done** | [[figma-bridge/docs/milestones/M2-read-write\|M2-read-write]] |
| M3 | Compose, Edit & Batch | `create_tree`/clone/structure, `batch`, design-system authoring, components/instances. | **done** | [[figma-bridge/docs/milestones/M3-compose-edit\|M3-compose-edit]] |
| M4 | Plugin & Distribution | One-install Claude Code plugin — marketplace + published plugin package (server bundle + skills/agents/hooks + Figma payload); the user installs + opens the Figma plugin and everything works. | **in progress** | [[figma-bridge/docs/milestones/M4-plugin\|M4-plugin]] |

**M1–M3 complete — the full clean-start surface shipped.** *Record at M3 close: the surface was 47 facade tools, with live-Figma manual verification (the suite is mock-plugin-over-real-relay / headless) and the Variables runtime re-introspection still outstanding.* The surface has grown since; [[figma-bridge/docs/specs/tool-surface|tool-surface.md]] is authoritative for the facade count and for what is exposed.

## Superseded (old-spec lineage)

Built on the superseded spec; **rebuilt** by M2/M3 above (their shipped tools are the "old
surface" the clean start replaces). Kept for history, not active:

- **Read & Parse** (old M2) — [[figma-bridge/docs/plans/2026-03-19-m2-read-parse]]
- **Build & Create** (old M3) — [[figma-bridge/docs/plans/2026-03-22-m3-build-create]] · [[figma-bridge/docs/plans/2026-03-22-m3-post-review-fixes]]
- **Tool-Surface Harvest** (old M4, 45 tools) — [[figma-bridge/docs/specs/tool-surface]] · [[figma-bridge/docs/plans/2026-06-22-tool-surface-harvest-brief]]
