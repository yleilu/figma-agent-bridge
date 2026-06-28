#!/usr/bin/env bash
# reload-plugin.sh — race-free reload of the Figma plugin after a code change.
#
# Builds the plugin, waits until dist/code.js is fully written AND stable, then
# (re)launches it via Figma's Quick Actions command palette (Cmd+/ -> type the
# plugin name -> Enter). The wait avoids the ENOENT race where Figma loads
# dist/code.js mid-rebuild (vite empties dist before writing).
#
# Why Quick Actions and not the Plugins menu: Figma does NOT act on System Events
# clicks of nested submenu items (Plugins -> Development -> <plugin>) — verified.
# Top-level menu items and keystrokes DO work, so the keyboard command palette is
# the reliable headless launch route. Running a plugin while one is open relaunches
# it, so this works for both first-open and reload.
#
# Requires: Figma DESKTOP running + Accessibility permission for the terminal.
# The relaunched plugin auto-reconnects to its last channel (channel-id persisted
# in clientStorage; kept across an unintended close) — see docs/specs/overview.md
# "Connection lifecycle". Override the plugin name with PLUGIN_NAME=... .
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/packages/figma-plugin/dist/code.js"

echo "[reload] building plugin..."
( cd "$REPO" && bun run --filter @figma-agent-bridge/figma-plugin build )

echo "[reload] waiting for dist/code.js to settle (no mid-build reload)..."
prev=""
stable=0
for _ in $(seq 1 40); do
  if [ -s "$DIST" ]; then
    cur="$(stat -f%m "$DIST" 2>/dev/null || echo "")"
    if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then
      stable=$((stable + 1))
      [ "$stable" -ge 2 ] && break
    else
      stable=0
    fi
    prev="$cur"
  fi
  sleep 0.4
done
if [ ! -s "$DIST" ]; then
  echo "[reload] ERROR: $DIST missing/empty after build" >&2
  exit 1
fi
echo "[reload] dist stable ($(stat -f%z "$DIST") bytes)"

PLUGIN_NAME="${PLUGIN_NAME:-Agent Bridge}"
echo "[reload] launching \"$PLUGIN_NAME\" via Quick Actions (Cmd+/)..."
# Keystrokes go to the FRONTMOST app — `activate` alone is unreliable, and if
# Figma isn't frontmost the keys LEAK into the terminal. Force frontmost + GUARD.
result=$(osascript \
  -e 'on run argv' \
  -e '  set pluginName to item 1 of argv' \
  -e '  tell application "Figma" to activate' \
  -e '  delay 1.2' \
  -e '  tell application "System Events"' \
  -e '    set frontmost of process "Figma" to true' \
  -e '    delay 0.7' \
  -e '    if frontmost of process "Figma" then' \
  -e '      tell process "Figma"' \
  -e '        keystroke "/" using {command down}' \
  -e '        delay 1.0' \
  -e '        keystroke pluginName' \
  -e '        delay 1.4' \
  -e '        key code 36' \
  -e '      end tell' \
  -e '      return "OK"' \
  -e '    else' \
  -e '      return "ABORT"' \
  -e '    end if' \
  -e '  end tell' \
  -e 'end run' \
  "$PLUGIN_NAME")

if [ "$result" != "OK" ]; then
  echo "[reload] ERROR: Figma was not frontmost; did not send keys (prevented terminal leak). Bring Figma forward and retry." >&2
  exit 1
fi
echo "[reload] launched; verify connection via the relay /channels (auto-connect takes a few seconds)."
