#!/usr/bin/env bash
# Guard: the committed plugin/bin/server.js must carry the current version-of-record.
# (A diff-vs-fresh-build check proved non-deterministic across environments — a fresh
# `bun build` is not byte-stable — so this version check is used instead: env-independent,
# and it catches the main drift, a version bump without a bundle rebuild. Rebuild + commit
# the bundle on any version bump or server-source change: `bun run build:bundle`.)
set -euo pipefail
VER="$(bun -e "console.log(require('./package.json').version)")"
if ! grep -q "$VER" plugin/bin/server.js; then
  echo "ERROR: plugin/bin/server.js does not carry version $VER — run 'bun run build:bundle' and commit it." >&2
  exit 1
fi
echo "bundle version ok ($VER)"
