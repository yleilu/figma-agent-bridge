#!/usr/bin/env bash
# Print the BUILD IDENTITY this build stamps into both bundles (I62).
#
# Under the CI-only versioning rule every dev build of both sides stamps the same
# `version`, so the major.minor handshake cannot tell a fresh bundle from a weeks-old
# one — which on 2026-08-27 cost a QA round a category verdict (see
# packages/shared/src/build-id.ts). This string is what the version cannot carry.
#
# Shape: <short-sha>[+]@<UTC minute>, e.g. `b29a238+@2026-08-29T15:40Z`.
#   short-sha  WHICH SOURCE the build came from
#   +          the tree was DIRTY, so the sha does not fully describe it
#   UTC minute WHICH BUILD, which is the half that matters when the sha is dirty
#              (a dirty tree produces a different bundle every save under one sha)
#
# Outside a git checkout the sha half degrades to `nogit`; the timestamp still
# separates one build from the next, which is the whole job.
#
# FIGMA_BRIDGE_BUILD_ID overrides the computation, so a release pipeline can stamp
# its own identity without this script guessing at CI's checkout shape.
set -euo pipefail

if [ -n "${FIGMA_BRIDGE_BUILD_ID:-}" ]; then
  printf '%s' "$FIGMA_BRIDGE_BUILD_ID"
  exit 0
fi

SHA="nogit"
if git rev-parse --git-dir >/dev/null 2>&1; then
  SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    SHA="${SHA}+"
  fi
fi

printf '%s@%s' "$SHA" "$(date -u '+%Y-%m-%dT%H:%MZ')"
