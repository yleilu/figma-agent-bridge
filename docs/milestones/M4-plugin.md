---
title: M4 — Claude Code Plugin & Distribution
created: 2026-07-08T11:00:00+08:00
tags:
  - figma-bridge
  - milestones
  - M4
  - plugin
type: index
related:
  - "[[figma-bridge/docs/milestones/README]]"
  - "[[figma-bridge/docs/specs/claude-plugin]]"
  - "[[figma-bridge/docs/specs/version-handshake]]"
---

# M4 — Claude Code Plugin & Distribution

**Goal:** Ship figma-agent-bridge as a **one-install Claude Code plugin** — a user runs
`/plugin install` and opens the Figma plugin, and everything works with no knowledge of MCP,
relay, channels, or ports. Governed by [[figma-bridge/docs/principles|the principles]] (esp.
**B2**); specced in [[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]].

**This page is the historical record of M4** — it describes the milestone as it was scoped and
delivered, not the current design. Where the two differ, the specs govern
([[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]] for packaging,
[[figma-bridge/docs/specs/dev-ops|dev-ops.md]] for the install routes and the Figma leg).

**Status:** **implementation shipped on `dev`** (merge `d095fab`, 2026-07-08) — the dual-mode
server bundle, manifests, the npm-sourced marketplace entry, release CI, 4 skills + 2 agents;
lint + full suite green, and the install *mechanism* validated locally against a packed tarball
of the plugin package. **Deferred** (see below): the GitHub Release + CI run + VM clean-room
install and the `skill-creator` agent evals.

## Scope — two plans

- **Plan A — Packaging & delivery.** Repo-as-marketplace with an **npm-sourced plugin entry**, a
  **dual-mode server bundle** (`--relay` self-spawns the shared relay) shipped inside the
  published plugin package, release CI, and a VM clean-room install test.
  → `docs/scratch/plans/2026-07-08-plugin-packaging.md`
- **Plan B — Skills & agents.** The `figma-design`, `figma-feedback`, `figma-reviewer`, and
  `figma-connection` skills, plus the `figma-designer` and `figma-reviewer` agents (authored
  from claude-plugin.md §6, eval'd via `skill-creator`).
  → `docs/scratch/plans/2026-07-08-plugin-skills-agents.md`

## Prerequisite — done

- **Version / protocol handshake** ([[figma-bridge/docs/specs/version-handshake|version-handshake.md]],
  **B2**) — shipped on `dev` (semver `major.minor` compare, live-verified). M4 is **decoupled**
  from its mechanism; its only version touch-point is Plan B's `figma-connection` diagnosis skill.

## Bundled (already built)

- The **feedback mechanism** (`record_feedback` tool, plugin Feedback UI, CloudFlare Worker —
  [[figma-bridge/docs/specs/feedback-system|feedback-system.md]]) is built; M4 **packages** it and
  bakes in the Worker URL. Plan B adds the plugin-layer *when-to-record* skill on top.

## Out of scope (deferred)

- **Release + CI + VM validation** — cutting the GitHub Release (the CI builds and publishes the
  plugin package on a `v*` tag), the clean-VM install test, and the `skill-creator` agent evals.
  **Deferred with the dev-workflow / CI overhaul** (to be sorted separately). The install
  *mechanism* is already validated locally.
- The live Worker **Send** path — the Worker URL is a build-time constant of the server bundle,
  but the shared secret for a *distributed* artifact is unresolved (see claude-plugin.md §10).

M4 packaged the Figma plugin as a **manifest-import payload** and scoped a Figma Community publish
out of the milestone. The Figma-leg options and their support status are owned by
[[figma-bridge/docs/specs/dev-ops|dev-ops.md]] §3.8, and the deferred plan for Community
distribution is tracked in [[figma-bridge/docs/deferred-capabilities|deferred-capabilities.md]].
