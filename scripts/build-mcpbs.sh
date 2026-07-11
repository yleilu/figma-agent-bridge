#!/usr/bin/env bash
# Build the designer-facing Claude Desktop .mcpb bundles (macOS arm64/x64 + Windows x64).
set -euo pipefail
if [ -z "${WORKER_URL:-}" ]; then echo "ERROR: WORKER_URL is required (the prod feedback Worker URL, baked into the binary)" >&2; exit 1; fi
for target in bun-darwin-arm64 bun-darwin-x64 bun-windows-x64; do
  echo "=== $target ==="
  bash scripts/build-mcpb.sh "$target"
done
echo "=== built $(ls -1 dist/*.mcpb 2>/dev/null | wc -l | tr -d ' ') .mcpb bundles ==="
