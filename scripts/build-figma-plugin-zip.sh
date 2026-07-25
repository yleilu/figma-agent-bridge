#!/usr/bin/env bash
# Package the built fig-plugin into dist/figma-plugin.zip — the release's hand-import archive
# (F2, docs/specs/dev-ops.md §3.8). Its ROOT holds manifest.json and dist/ directly (no wrapping
# folder), so unzipping yields the importable pair immediately.
# Source defaults to the payload build:package assembled (byte-identical to what the published
# package carries), falling back to the fig-plugin build output when only build:plugin has run.
set -euo pipefail
SRC="${1:-}"
if [ -z "$SRC" ]; then
  if [ -f "plugin/figma-plugin/manifest.json" ]; then
    SRC="plugin/figma-plugin"
  else
    SRC="packages/figma-plugin"
  fi
fi
for f in "$SRC/manifest.json" "$SRC/dist/code.js" "$SRC/dist/ui.html"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f is missing — run 'bun run build:plugin && bun run build:package' first." >&2
    exit 1
  fi
done
OUT="$(pwd)/dist/figma-plugin.zip"
mkdir -p "$(dirname "$OUT")" # zip does NOT create a missing parent — it exits 15
rm -f "$OUT"
( cd "$SRC" && zip -qr "$OUT" manifest.json dist )
echo "built $OUT ($(du -h "$OUT" | awk '{print $1}')) from $SRC"
