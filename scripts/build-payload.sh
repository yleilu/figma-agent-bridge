#!/usr/bin/env bash
# Assemble the published package's non-bundle payload (the server bundle is build-bundle.sh):
#
#   1. the built fig-plugin (manifest.json + dist/{code.js,ui.html}) → plugin/figma-plugin/
#   2. the repo-root LICENSE                                        → plugin/LICENSE
#
# Both destinations are BUILD OUTPUTS, never committed — figma-setup materialises the payload
# from the installed package, and the repo-root LICENSE stays the single source of truth for
# the copy the package carries (plugin/package.json lists it in `files`).
# The fig-plugin dist is not in git, so `bun run build:plugin` must have run first.
set -euo pipefail
SRC="${1:-packages/figma-plugin}"
DEST="${2:-plugin/figma-plugin}"
for f in "$SRC/manifest.json" "$SRC/dist/code.js" "$SRC/dist/ui.html"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f is missing — run 'bun run build:plugin' first." >&2
    exit 1
  fi
done
rm -rf "$DEST"
mkdir -p "$DEST/dist"
cp "$SRC/manifest.json" "$DEST/manifest.json"
cp "$SRC/dist/code.js" "$SRC/dist/ui.html" "$DEST/dist/"
echo "assembled $DEST (manifest.json + dist/{code.js,ui.html})"

LICENSE_SRC="${3:-LICENSE}"
LICENSE_DEST="${4:-plugin/LICENSE}"
if [ ! -f "$LICENSE_SRC" ]; then
  echo "ERROR: $LICENSE_SRC is missing — the package must carry a licence." >&2
  exit 1
fi
cp "$LICENSE_SRC" "$LICENSE_DEST"
echo "assembled $LICENSE_DEST (copy of $LICENSE_SRC)"
