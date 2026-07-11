#!/usr/bin/env bash
# Build a Claude Desktop .mcpb extension bundling the server binary for one target.
set -euo pipefail
if [ -z "${WORKER_URL:-}" ]; then echo "ERROR: WORKER_URL is required (the prod feedback Worker URL, baked into the binary)" >&2; exit 1; fi
DIST="$(pwd)/dist"
TARGET="${1:-bun-darwin-arm64}"
OSARCH="${TARGET#bun-}"                              # e.g. darwin-arm64 | windows-x64
VERSION="$(bun -e "console.log(require('./package.json').version)")"
case "$OSARCH" in
  windows-*) PLATFORM=win32;  EXT=".exe" ;;
  darwin-*)  PLATFORM=darwin; EXT="" ;;
  linux-*)   PLATFORM=linux;  EXT="" ;;
  *) echo "unsupported target: $TARGET" >&2; exit 1 ;;
esac

# 1) build the binary (build-binary.sh requires WORKER_URL — passed through by the caller)
bash scripts/build-binary.sh "$TARGET"

# 2) stage manifest.json + server/<binary>
STAGE="dist/mcpb/${OSARCH}"
rm -rf "$STAGE"; mkdir -p "$STAGE/server"
cp "dist/figma-mcp-${OSARCH}${EXT}" "$STAGE/server/figma-mcp${EXT}"
cat > "$STAGE/manifest.json" <<EOF
{
  "manifest_version": "0.3",
  "name": "figma-agent-bridge",
  "display_name": "Figma Agent Bridge",
  "version": "${VERSION}",
  "description": "Drive Figma from Claude — design, review, and file feedback.",
  "author": { "name": "Lei", "email": "l@tristone.io" },
  "homepage": "https://github.com/yleilu/figma-agent-bridge",
  "server": {
    "type": "binary",
    "entry_point": "server/figma-mcp${EXT}",
    "mcp_config": { "command": "\${__dirname}/server/figma-mcp${EXT}" }
  },
  "compatibility": { "platforms": ["${PLATFORM}"] }
}
EOF

# 3) zip → dist/figma-agent-bridge-<osarch>.mcpb
OUT="${DIST}/figma-agent-bridge-${OSARCH}.mcpb"
rm -f "$OUT"
( cd "$STAGE" && zip -qr "$OUT" . )
echo "built ${OUT} ($(du -h "$OUT" | awk '{print $1}'))"
