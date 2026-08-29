#!/usr/bin/env bash
# R4 · local-path marketplace (dev-ops.md §3.6): install/refresh THIS working tree's Claude Code
# plugin (skills + agents + hooks + MCP config + the freshly built server bundle and fig-plugin
# payload) into your local Claude Code (~/.claude, scope=user) for testing on this machine.
# Idempotent: safe to re-run after edits; only touches OUR plugin, never the whole plugin cache.
#
# Why it stages a scratch marketplace instead of adding the repo root: the committed
# .claude-plugin/marketplace.json is npm-sourced (claude-plugin.md §3), so adding the repo root
# directly would resolve the plugin from the npm registry — the published version, not this tree.
# The scratch marketplace is a byte-for-byte copy of that file with the entry's source rewritten to
# the local path "./plugin", next to a copy of the assembled package.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKET="figma-agent-bridge"   # marketplace name (.claude-plugin/marketplace.json "name")
PLUGIN="figma-agent-bridge"   # plugin name (marketplace.json plugins[].name)
STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/figma-agent-bridge/local-marketplace"
cd "$REPO_ROOT"

command -v claude >/dev/null || { echo "ERROR: the 'claude' CLI is not on PATH." >&2; exit 1; }

echo "=== build the package (server bundle + fig-plugin payload) ==="
bun run build

echo "=== stage the local-path marketplace at ${STAGE} ==="
rm -rf "$STAGE"
mkdir -p "$STAGE/.claude-plugin"
cp -R "$REPO_ROOT/plugin" "$STAGE/plugin"
MARKET_SRC="$REPO_ROOT/.claude-plugin/marketplace.json" \
MARKET_OUT="$STAGE/.claude-plugin/marketplace.json" \
bun -e '
  const fs = require("fs")
  const { MARKET_SRC, MARKET_OUT } = process.env
  const market = JSON.parse(fs.readFileSync(MARKET_SRC, "utf8"))
  market.plugins = market.plugins.map(p =>
    p.name === "figma-agent-bridge"
      ? { ...p, source: "./plugin", package: undefined, version: undefined }
      : p,
  )
  fs.writeFileSync(MARKET_OUT, `${JSON.stringify(market, null, 2)}\n`)
'

echo "=== refresh the local install (scope: user) ==="
claude plugin uninstall "${PLUGIN}@${MARKET}" --scope user --yes 2>/dev/null || true
claude plugin marketplace remove "$MARKET" --yes 2>/dev/null || true
# purge ONLY our stale cache dir (never the whole ~/.claude/plugins/cache)
rm -rf "$HOME"/.claude/plugins/cache/*"${PLUGIN}"* 2>/dev/null || true

claude plugin marketplace add "$STAGE"
claude plugin install "${PLUGIN}@${MARKET}" --scope user

cat <<EOF

=== installed (current dev version) ===
In your Claude Code session, run:  /reload-plugins   (activates without a restart)

Figma side (once): run the figma-setup skill, or import by hand:
  Figma -> Plugins -> Development -> Import from manifest ->
  ${REPO_ROOT}/packages/figma-plugin/manifest.json
EOF

# The install guard: this script wrote a fresh bundle and restarted NOTHING, so a
# server process started before the write keeps serving the code it loaded — and
# nothing in the protocol says so, because every dev build stamps the same version.
# The build fingerprint (I62) catches a stale BUNDLE; a `bun run packages/server`
# tree-runner honestly reports 'source' and is invisible to it, so both families
# are listed here. Reports only — it never kills anything and never fails the
# install (`|| true`): a second server may be deliberate, and a build script that
# killed processes it did not start would be worse than the trap it prevents.
bun run "$REPO_ROOT/scripts/stale-servers.ts" "$REPO_ROOT/plugin/bin/server.js" || true
