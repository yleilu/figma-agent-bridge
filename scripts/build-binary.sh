#!/usr/bin/env bash
# Compile the MCP server into a standalone binary for one os-arch, with the
# production feedback Worker URL baked in, plus a SHA-256 sidecar.
set -euo pipefail
TARGET="${1:-bun-darwin-arm64}"                 # e.g. bun-darwin-arm64 | bun-linux-x64
OSARCH="${TARGET#bun-}"                          # darwin-arm64
if [ -z "${WORKER_URL:-}" ]; then echo "ERROR: WORKER_URL is required (the prod feedback Worker URL, baked in)" >&2; exit 1; fi
SUFFIX=""
case "$TARGET" in *windows*) SUFFIX=".exe" ;; esac
OUT="dist/figma-mcp-${OSARCH}${SUFFIX}"
mkdir -p dist
bun build packages/server/src/index.ts \
  --compile --target "$TARGET" \
  --define "process.env.WORKER_URL='${WORKER_URL}'" \
  --outfile "$OUT"
shasum -a 256 "$OUT" | awk -v f="$(basename "$OUT")" '{print $1"  "f}' > "${OUT}.sha256"
echo "built $OUT ($(shasum -a 256 "$OUT" | awk '{print $1}'))"
