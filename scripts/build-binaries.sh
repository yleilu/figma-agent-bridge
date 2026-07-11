#!/usr/bin/env bash
# Build the designer-facing Bun binaries (macOS arm64/x64 + Windows x64) from one host.
set -euo pipefail
for target in bun-darwin-arm64 bun-darwin-x64 bun-windows-x64; do
  echo "=== $target ==="
  bash scripts/build-binary.sh "$target"
done
echo "=== built $(ls -1 dist/figma-mcp-* 2>/dev/null | grep -v '\.sha256$' | wc -l | tr -d ' ') binaries ==="
