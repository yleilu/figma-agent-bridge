<img src="packages/branding/assets/logo-128.png" width="88" alt="Figma Agent Bridge" />

# Figma Agent Bridge

[![CI](https://github.com/yleilu/figma-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/yleilu/figma-agent-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An MCP bridge that lets an AI agent **read and build Figma designs**. The agent talks
MCP to a server, the server relays commands over a WebSocket to the **Agent Bridge**
Figma plugin, and the plugin executes them against the live document — then returns
results back up the same pipe.

## Why this exists

figma-agent-bridge builds production-ready Figma files, not throwaway mockups. Every
node carries a name, a description, and structured context alongside it — so an agent
(or the next person to open the file) understands what a piece is and how to treat it
without re-deriving intent from scratch. It's a full 51-tool read/write facade covering
nodes, structure, the design system, and dev handoff, self-hosted with no rate limits —
and it works on any Figma plan, free tier included.

## Features

- **Everything organized, no orphan shapes** — every build pulls from your real
  components, variables, and styles, the way you'd build it by hand. Nothing gets
  dropped in as a disconnected one-off that breaks your system.
- **Continuous context, not one-shot reads** — every node carries a name, a visible
  description, and hidden structured context, surfaced in the same read, so intent
  travels with the file instead of getting lost between sessions.
- **Built for token efficiency** — whole-tree builds and bulk edits happen in one
  step, and even a massive file scans safely — paginated, cursor-based reads that
  never try to swallow more than an agent can hold.
- **Self-hosted, no rate limit** — runs on your own machine, so there's no call
  quota to hit mid-project. Works the same on a free Figma account as a paid one.

See [docs/specs/tool-surface.md](docs/specs/tool-surface.md) for the full tool catalogue.

## Install

> **Not live yet.** The Claude Code plugin resolves from the `figma-agent-bridge` npm
> package, which today is only a name-reservation stub (`0.0.1`) — its own description
> says the real package "ships from 0.3.0 onward." Routes 1–3 below are accurate to the
> design, not to what you can run today; route 4 (manual/from source) works right now,
> since it never touches the published package.

**Every route needs:** [Bun](https://bun.sh) and the Figma **desktop** app (plugins
arrive by manifest import, which the browser can't do).

**Windows (routes 1–2):** the MCP tools work the same as anywhere else, but the
plugin's five hooks — identity injection, the presence status block — are POSIX shell
scripts calling `jq`/`curl`. Native Windows has neither, so without a POSIX shell
providing them, those hooks quietly don't run; nothing errors, they just don't fire.
Routes 3 and 4 aren't affected.

### 1. Claude Desktop

1. Install Bun, then open (or reopen) Claude Desktop — a session that's already
   running won't see a freshly-installed `bun`.
2. Open Claude Desktop's plugin directory and add this repository as a marketplace:
   `yleilu/figma-agent-bridge`.
3. Install the listed plugin, **Figma Bridge**, from the resulting entry.
4. Restart or reload so the MCP server is picked up.

Then continue with **Figma-side setup** below.

### 2. Claude Code CLI

1. Install Bun, then open (or reopen) Claude Code — a session that's already running
   won't see a freshly-installed `bun`.
2. `claude plugin marketplace add yleilu/figma-agent-bridge`
3. `claude plugin install figma-agent-bridge@figma-agent-bridge`
4. Reload or restart the host.

(The same two steps work as in-session slash commands: `/plugin marketplace add
yleilu/figma-agent-bridge`, then `/plugin install figma-agent-bridge@figma-agent-bridge`.)

Then continue with **Figma-side setup** below.

### Figma-side setup (routes 1 and 2)

Once the plugin is installed, on either route:

1. Ask the agent to run the `figma-setup` skill — it materializes the Figma plugin
   and tells you the exact path to import.
2. In Figma: **Plugins → Development → Import plugin from manifest** → that path.
3. Open the plugin from a Figma design file — it connects on its own.

### 3. From Figma's plugin marketplace

Not applicable yet — this project isn't published to Figma's plugin marketplace
(org-private or public) at all today. See routes 1 and 2 for the current install
path.

### 4. Manual / from source — for contributors

Working on this repo directly, or running from a local clone:

1. Clone the repo, then `bun install`.
2. `bun run build:plugin` — builds the Figma plugin (its output isn't committed, so
   this step is required).
3. Register the server with your agent host, pointing at
   `packages/server/src/index.ts` in your clone, run with `bun` — use absolute paths
   for both the interpreter and the script.
4. In Figma: **Plugins → Development → Import plugin from manifest** →
   `packages/figma-plugin/manifest.json` in your clone.
5. Open the plugin from a Figma design file — it connects on its own.

Repo scripts: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run format`.

## Troubleshooting

- **The agent has the skills but can't call any Figma tools.** You're on Claude
  Desktop's regular chat surface — it loads the skills but doesn't guarantee the MCP
  tools are bridged. Switch to Desktop's **Code surface**.
- **`bun` isn't found right after installing it.** A session keeps the PATH it
  started with — install Bun *before* opening the agent host, or fully quit and
  reopen it (a plugin reload alone isn't enough).
- **The plugin doesn't show up after importing the manifest.** It only appears in a
  Figma **design file** — the manifest excludes FigJam, Slides, and Dev Mode.
- **Everything installed, but the Figma panel never connects.** The server attaches
  to whatever's already listening on its port (`18080`, loopback only) rather than
  always starting fresh — a stale or unrelated process already holding that port
  silently satisfies the check. Free up port `18080` (quit whatever's using it, or
  restart your machine) and try again.

## Status

Actively developed, pre-1.0 — breaking changes are possible.

## Acknowledgments

Structure and approach inspired by
[grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp).

## License

MIT — see [LICENSE](LICENSE).
