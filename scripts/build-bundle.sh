#!/usr/bin/env bash
# Bundle the server (server + relay, deps inlined) into one Bun JS file for the Claude Code
# plugin. Runs under the user's Bun (no compiled binary). Version is baked in via the inlined
# package.json import (APP_VERSION). WORKER_URL is NOT baked (read from process.env at runtime).
set -euo pipefail
OUT="${1:-plugin/bin/server.js}"
mkdir -p "$(dirname "$OUT")"
bun build packages/server/src/index.ts --target=bun --outfile="$OUT"
echo "built $OUT ($(du -h "$OUT" | awk '{print $1}'))"
