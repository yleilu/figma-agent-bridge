#!/usr/bin/env bash
# Fail if plugin/bin/server.js is stale vs a fresh build of the current source + version.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/server-bundle-XXXXXX")"
trap 'rm -f "$TMP"' EXIT
# Delegate to the single build definition (build errors go to stderr and surface in CI).
bash scripts/build-bundle.sh "$TMP" >/dev/null
if ! diff -q "$TMP" plugin/bin/server.js >/dev/null 2>&1; then
  echo "ERROR: plugin/bin/server.js is stale — run 'bun run build:bundle' and commit it." >&2
  exit 1
fi
echo "bundle is fresh"
