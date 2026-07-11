# figma-agent-bridge — Claude Code Plugin

Drive Figma from Claude Code: design, review, and file feedback with an AI agent.

## Requirements (Claude Code)

This plugin runs its server with **[Bun](https://bun.sh)**. Most developers already have it; if not,
install it (one command) and reopen Claude Code:

```bash
# check, and install if missing (macOS / Linux):
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
# Windows (PowerShell):
#   powershell -c "irm bun.sh/install.ps1 | iex"
```

Claude Desktop users don't need this — the Desktop extension ships a self-contained binary.

## Install

### 1. Add to Claude Code

```
/plugin marketplace add yleilu/figma-agent-bridge
/plugin install figma-agent-bridge@figma-agent-bridge
```

The plugin ships a committed Bun JS bundle (`plugin/bin/server.js`). On first run
it starts the MCP server directly with the `bun` on your PATH — no download needed.

### 2. Import the Figma plugin

Open Figma desktop and go to **Plugins → Development → Import plugin from manifest**.
Select `packages/figma-plugin/manifest.json` from this repository (or the installed
plugin directory). Open the plugin from the Figma canvas — it auto-connects to the
relay that the MCP server manages.

## Requirements

- Claude Code (latest)
- Figma desktop (not Figma in browser)
- Bun (see Requirements (Claude Code) above)

## Usage

Once installed, the `figma-agent-bridge` MCP server is available in every Claude
Code session. Ask Claude to read, create, or edit Figma frames — it routes calls
through the relay to the Figma plugin running in your open document.

## Architecture

```
Claude Code (MCP client)
  └── plugin/bin/server.js (MCP server + relay, dual-mode, run via bun)
        └── WebSocket relay  ←→  Figma desktop plugin
```

The bundle runs in two modes:

- Default (no flags): MCP stdio server — what Claude Code connects to.
- `--relay`: WebSocket relay server — auto-spawned by the MCP server on demand.

## Releases

The compiled binary and `.mcpb` extension for Claude Desktop / Figma designer routes
are published to GitHub Releases on every `v*` tag. The Claude Code bundle
(`plugin/bin/server.js`) is committed directly in the plugin and arrives via git —
no separate download needed for the Claude Code route.

## Releasing

1. Bump the version in the root `package.json`.
2. `bun run stamp:version` — propagates the version into all packages.
3. `bun run build:bundle` — rebuilds `plugin/bin/server.js` from source.
4. Commit, tag (`v<version>`), and push — `release.yml` builds the designer binaries and `.mcpb` extensions.
   The Claude Code bundle (`plugin/bin/server.js`) is committed directly; no separate binary download needed.

## License

MIT
