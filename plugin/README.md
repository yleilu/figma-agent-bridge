# figma-agent-bridge — Claude Code Plugin

Drive Figma from Claude Code: design, review, and file feedback with an AI agent.

## Install

### 1. Add to Claude Code

```
/plugin marketplace add yleilu/figma-agent-bridge
/plugin install figma-agent-bridge@figma-agent-bridge
```

The `SessionStart` hook downloads the right binary for your OS and architecture
into `${CLAUDE_PLUGIN_DATA}/bin/` on first run (SHA-256 verified, guarded).

### 2. Import the Figma plugin

Open Figma desktop and go to **Plugins → Development → Import plugin from manifest**.
Select `packages/figma-plugin/manifest.json` from this repository (or the installed
plugin directory). Open the plugin from the Figma canvas — it auto-connects to the
relay that the MCP server manages.

## Requirements

- Claude Code (latest)
- Figma desktop (not Figma in browser)
- macOS arm64 (darwin-arm64 binary ships by default; linux-x64 coming)

## Usage

Once installed, the `figma-agent-bridge` MCP server is available in every Claude
Code session. Ask Claude to read, create, or edit Figma frames — it routes calls
through the relay to the Figma plugin running in your open document.

## Architecture

```
Claude Code (MCP client)
  └── figma-mcp binary (MCP server + relay, dual-mode)
        └── WebSocket relay  ←→  Figma desktop plugin
```

The binary runs in two modes:

- Default (no flags): MCP stdio server — what Claude Code connects to.
- `--relay`: WebSocket relay server — auto-spawned by the MCP server on demand.

## Releases

Binaries are published to GitHub Releases on every `v*` tag. The bootstrap hook
downloads the binary matching your platform from the release assets, verifies the
SHA-256 checksum, and makes it executable before the MCP server starts.

## License

MIT
