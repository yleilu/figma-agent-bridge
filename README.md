---
title: figma-agent-bridge
created: 2026-06-22T17:00:00+08:00
tags:
  - spec
  - figma-bridge
  - readme
type: spec
related:
  - '[[figma-bridge/docs/principles]]'
  - '[[figma-bridge/docs/architecture]]'
  - '[[figma-bridge/docs/specs/tool-surface]]'
  - '[[figma-bridge/docs/specs/expression-formats]]'
---

<p align="center">
  <img src="packages/branding/assets/logo-128.png" width="88" alt="Agent Bridge" />
</p>

# figma-agent-bridge

> Governed by [the principles](docs/principles.md).

An MCP bridge that lets an AI agent **read and build Figma designs**. The agent talks
MCP to a server, the server relays commands over a WebSocket to the **Agent Bridge**
Figma plugin, and the plugin executes them against the live document — then returns
results back up the same pipe.

## Install

Three routes. All of them run the server on your own [Bun](https://bun.sh) — **there is no
toolchain-free route** — and all of them need the Figma **desktop** app, because the Figma plugin
arrives by manifest import. Prerequisites, steps, verification, and teardown for each are in
[docs/specs/dev-ops.md](docs/specs/dev-ops.md) §3.

| Route                             | Who it is for                                             | What you install                                                                                                            |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code plugin** _(primary)_ | anyone driving Figma from Claude Code                     | the marketplace plugin — server bundle, skills, agents, hooks, and the Figma plugin payload ([plugin/README.md](plugin/README.md)) |
| **Manual / from source**          | contributors working on this repository                   | a clone, built and registered by hand — see [Quickstart](#quickstart)                                                       |
| **Standalone MCP server**         | any other MCP client, or a hand-wired Claude Code entry    | the published `figma-agent-bridge` package's `bin` entry, run with `bunx` — the raw tool surface, no skills or agents        |

## Three layers

The whole discipline is that concerns never leak across them ([principles](docs/principles.md), [architecture](docs/architecture.md)):

- **Bridge** — reliable, standardized transport (MCP server transport + WebSocket relay + the Agent Bridge Figma plugin). Cares only about connection reliability and a uniform result/error contract.
- **Tool** — the agent-facing capability surface over Figma: symmetric reads/writes, compact formatting, batching. Holds no opinions.
- **Plugin** — the Claude Code plugin (skills, agents, commands). Where all preferences and opinionated workflows live. _(Not the Figma plugin — that is part of the bridge.)_

## Tech stack

Bun monorepo (`packages/*`), TypeScript throughout, MCP SDK on the server, a
WebSocket relay for transport, and a Vite + React Figma plugin.

| Package                            | Role                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| `@figma-agent-bridge/server`       | MCP server — the tool surface                                  |
| `@figma-agent-bridge/relay`        | WebSocket relay between server and Figma plugin                |
| `@figma-agent-bridge/figma-plugin` | Agent Bridge Figma plugin (Vite + React UI, executes commands) |
| `@figma-agent-bridge/shared`       | Shared types, expression grammar/parser                        |
| `@figma-agent-bridge/cli`          | CLI entry                                                      |

## Quickstart

```sh
# Install (Bun workspaces)
bun install

# Run relay + MCP server together (relay auto-started, port auto-discovered)
./scripts/start-mcp.sh

# …or run them via root scripts
bun run dev:relay  # relay only
bun run dev:server # server only
bun run dev        # relay + plugin watch builds (ui, code, relay)

# Build the Figma plugin
bun run build:plugin
```

Then load `packages/figma-plugin/manifest.json` in Figma (Plugins → Development →
Import plugin from manifest) and point your MCP client at the server.

Repo scripts: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run format`.

## Documentation map

- [docs/principles.md](docs/principles.md) — the governing document; every other doc is subordinate to it.
- [docs/architecture.md](docs/architecture.md) — the _how_: transport, error envelope, package layout.
- [docs/milestones.md](docs/milestones.md) — milestone roadmap.
- Specs — [overview](docs/specs/overview.md), [tool-surface](docs/specs/tool-surface.md), [expression-formats](docs/specs/expression-formats.md).
- Reference — [figma-plugin-api](docs/reference/figma-plugin-api.md), [api-coverage](docs/reference/api-coverage.md).
- [docs/plans/](docs/plans/) — milestone and harvest plans.
- [docs/decisions/](docs/decisions/) — decision records.
- [docs/research/](docs/research/) — research notes.
