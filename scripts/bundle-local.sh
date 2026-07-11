#!/usr/bin/env bash
# Build every product locally and print how to install + test the whole triplet.
set -euo pipefail
export WORKER_URL="${WORKER_URL:-https://example.invalid}"   # placeholder ok locally (feedback only)
echo "=== stamp version ==="
bun run stamp:version
echo "=== build CC bundle ==="
bun run build:bundle
echo "=== build server binaries + .mcpb bundles ==="
bun run build:mcpbs
echo "=== build figma plugin ==="
bun run --filter @figma-agent-bridge/figma-plugin build
VERSION="$(bun -e "console.log(require('./package.json').version)")"
ARCH="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
cat <<EOF

=== built version ${VERSION} ===
Server binaries + .mcpb bundles:
$(ls -1 dist/figma-mcp-* dist/*.mcpb 2>/dev/null || true)
Claude Code bundle: plugin/bin/server.js
Figma plugin: packages/figma-plugin/dist/{code.js,ui.html}  (manifest: packages/figma-plugin/manifest.json)

Install + test locally:
  1. Claude Code plugin:  /plugin marketplace add $(pwd)
                          /plugin install figma-agent-bridge@figma-agent-bridge
     (for a purely LOCAL test with no release yet, copy dist/figma-mcp-${OS}-${ARCH} into
      \${CLAUDE_PLUGIN_DATA}/bin/figma-mcp so the SessionStart bootstrap's version check passes.)
  2. Claude Desktop:      install dist/figma-agent-bridge-${OS}-${ARCH}.mcpb
                          (Settings -> Extensions -> Advanced -> Install Extension...)
  3. Figma plugin:        Figma -> Plugins -> Development -> Import from manifest ->
                          packages/figma-plugin/manifest.json
  4. Round-trip:          open the Figma plugin, connect, and drive it from your agent.
EOF
