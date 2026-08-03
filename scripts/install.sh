#!/usr/bin/env bash
# Public installer for the figma-agent-bridge Claude Code plugin (end users).
# curl -fsSL https://raw.githubusercontent.com/yleilu/figma-agent-bridge/main/scripts/install.sh | bash
#
# What this does: ensures Bun is on PATH, then adds the marketplace and
# installs the plugin. It does NOT touch Figma-side setup — that's a
# separate manual step.
#
# Contributors/devs: use scripts/install-local.sh instead (installs from
# your local clone and force-refreshes the plugin cache).
set -euo pipefail

MARKET="figma-agent-bridge"          # marketplace name (.claude-plugin/marketplace.json "name")
PLUGIN="figma-agent-bridge"          # plugin name (marketplace.json plugins[].name)
GITHUB_REPO="yleilu/figma-agent-bridge"

command -v claude >/dev/null || {
  echo "ERROR: the 'claude' CLI is not on PATH." >&2
  echo "Install Claude Code first, then re-run this script." >&2
  exit 1
}

echo "=== checking for Bun ==="
# Tracks whether THIS run put Bun on the machine. An agent host keeps the PATH
# it started with, so a session that started before Bun existed cannot launch
# the MCP server — /reload-plugins is not enough, it needs a full restart.
BUN_INSTALLED_NOW=0
if command -v bun >/dev/null; then
  echo "Bun is already installed, skipping."
else
  case "${OSTYPE:-}" in
    linux*|darwin*)
      echo "Bun not found. Installing..."
      curl -fsSL https://bun.sh/install | bash

      if ! command -v bun >/dev/null; then
        # Fresh curl-install won't be on PATH in this shell process until
        # the user's rc file is re-sourced; check the default install path.
        export PATH="$HOME/.bun/bin:$PATH"
      fi

      if ! command -v bun >/dev/null; then
        echo "ERROR: Bun was installed but is not resolvable yet." >&2
        echo "Restart your shell and re-run this script." >&2
        exit 1
      fi

      BUN_INSTALLED_NOW=1
      echo "Bun installed."
      ;;
    *)
      echo "Bun not found, and this looks like a native Windows shell (not WSL)." >&2
      echo "The bash installer won't work here. Run this in PowerShell instead:" >&2
      echo "" >&2
      echo "  irm bun.sh/install.ps1 | iex" >&2
      echo "" >&2
      echo "Then re-run this script." >&2
      exit 1
      ;;
  esac
fi

echo "=== adding marketplace ==="
claude plugin marketplace add "$GITHUB_REPO"

echo "=== installing plugin ==="
claude plugin install "${PLUGIN}@${MARKET}"

if [ "$BUN_INSTALLED_NOW" -eq 1 ]; then
  cat <<EOF

=== installed ===
Bun was installed during this run, so QUIT AND REOPEN Claude Code before using
the plugin. A running session keeps the PATH it started with — it cannot see
the new Bun, and the MCP server will fail to launch. /reload-plugins is NOT
enough here.

Figma-side setup is a separate step, not covered by this script.
EOF
else
  cat <<EOF

=== installed ===
In your Claude Code session, run:  /reload-plugins   (activates without a restart)

Figma-side setup is a separate step, not covered by this script.
EOF
fi
