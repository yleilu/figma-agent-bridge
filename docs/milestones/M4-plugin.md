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

**Status:** **implementation shipped on `dev`** (merge `d095fab`, 2026-07-08) — dual-mode binary,
manifests, SHA-256 bootstrap, release CI, 4 skills + 2 agents; lint + full suite green, and the
install *mechanism* validated locally with a real compiled binary. **Deferred** (see below): the
GitHub Release + CI run + VM clean-room install and the `skill-creator` agent evals.

## Scope — two plans

- **Plan A — Packaging, binary & bootstrap.** Repo-as-marketplace, a **dual-mode compiled
  binary** (`--relay` self-spawns the shared relay), guarded SHA-256 `SessionStart` bootstrap
  into `${CLAUDE_PLUGIN_DATA}/bin/`, release CI, and a VM clean-room install test.
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
  compiles in the Worker URL. Plan B adds the plugin-layer *when-to-record* skill on top.

## Out of scope (deferred)

- **Release + CI + VM validation** — cutting the GitHub Release (the CI builds binaries on a
  `v*` tag), the clean-VM install test (incl. the `SessionStart`-hook-vs-MCP-launch ordering
  check), and the `skill-creator` agent evals. **Deferred with the dev-workflow / CI overhaul**
  (to be sorted separately). The install *mechanism* is already validated locally with a real binary.
- Windows/Linux binaries; the live Worker **Send** path (the URL compiles in, but the
  distributed-binary shared-secret is unresolved — see claude-plugin.md §11).

The Figma plugin ships by **manifest import** — this is the permanent distribution path; Figma
Community publish is **not pursued**.
