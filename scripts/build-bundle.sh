#!/usr/bin/env bash
# Build the published package's server: bundle server + relay (deps inlined) into one Bun JS
# file at plugin/bin/server.js. That path is a BUILD OUTPUT, never committed — the package is
# assembled at release. A `#!/usr/bin/env bun` shebang is prepended so the package's `bin`
# entry is executable by `bunx`. Version is baked in via the inlined package.json import
# (APP_VERSION).
#
# WORKER_URL (the anonymous-feedback Cloudflare Worker) is baked in ONLY when the variable is
# set and non-empty — release.yml passes it from the FEEDBACK_WORKER_URL secret. Baking
# substitutes the `process.env.WORKER_URL` property access itself, so it OVERRIDES the runtime
# environment: an unconditional --define would freeze an empty string into the bundle and make
# the URL impossible to set at runtime. When the variable is absent we emit no --define at all,
# leaving the runtime `process.env.WORKER_URL` read intact — that is what keeps from-source and
# local-dev builds configurable by environment.
set -euo pipefail
OUT="${1:-plugin/bin/server.js}"
mkdir -p "$(dirname "$OUT")"

DEFINES=()

# I62 — stamp WHICH BUILD this bundle is. The same value goes into the fig-plugin
# bundles (packages/figma-plugin/vite.config.*.ts), so a pair whose stamps disagree is
# a pair that came out of two different builds. Advisory only — see
# packages/shared/src/build-id.ts.
BUILD_ID="$(bash "$(dirname "$0")/build-id.sh")"
BUILD_ID_LITERAL="$(BUILD_ID="$BUILD_ID" bun -e 'process.stdout.write(JSON.stringify(process.env.BUILD_ID))')"
DEFINES+=(--define "FIGMA_BRIDGE_BUILD=$BUILD_ID_LITERAL")
echo "BUILD_ID: $BUILD_ID"

if [ -n "${WORKER_URL:-}" ]; then
  # A --define value is parsed as a JS expression, so it must arrive as a *quoted* string
  # literal; Bun's JSON encoder does the quoting and escaping.
  WORKER_URL_LITERAL="$(bun -e 'process.stdout.write(JSON.stringify(process.env.WORKER_URL))')"
  DEFINES+=(--define "process.env.WORKER_URL=$WORKER_URL_LITERAL")
  echo "WORKER_URL: baked ($WORKER_URL)"
else
  echo "WORKER_URL: not baked (unset or empty) — read from process.env at runtime"
fi

bun build packages/server/src/index.ts --target=bun --banner='#!/usr/bin/env bun' \
  ${DEFINES[@]+"${DEFINES[@]}"} --outfile="$OUT"
chmod +x "$OUT"
echo "built $OUT ($(du -h "$OUT" | awk '{print $1}'))"
