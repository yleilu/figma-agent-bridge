#!/usr/bin/env bash
# Install/refresh THIS repo's Claude Code plugin (skills + agents + MCP config + the current
# Bun bundle) into your local Claude Code (~/.claude, scope=user) for testing on this machine.
# Idempotent: safe to re-run after edits; only touches OUR plugin, never the whole plugin cache.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKET="figma-agent-bridge"   # marketplace name (.claude-plugin/marketplace.json "name")
PLUGIN="figma-agent-bridge"   # plugin name (marketplace.json plugins[].name)
cd "$REPO_ROOT"

command -v claude >/dev/null || { echo "ERROR: the 'claude' CLI is not on PATH." >&2; exit 1; }

echo "=== build the current Bun bundle ==="
bun run build:bundle

echo "=== refresh the local install (scope: user) ==="
claude plugin uninstall "${PLUGIN}@${MARKET}" --scope user --yes 2>/dev/null || true
claude plugin marketplace remove "$MARKET" --yes 2>/dev/null || true
# purge ONLY our stale cache dir (never the whole ~/.claude/plugins/cache)
rm -rf "$HOME"/.claude/plugins/cache/*"${PLUGIN}"* 2>/dev/null || true

claude plugin marketplace add "$REPO_ROOT"
claude plugin install "${PLUGIN}@${MARKET}" --scope user

cat <<EOF

=== installed (current dev version) ===
In your Claude Code session, run:  /reload-plugins   (activates without a restart)

Figma side (once): Figma -> Plugins -> Development -> Import from manifest ->
  ${REPO_ROOT}/packages/figma-plugin/manifest.json
EOF
