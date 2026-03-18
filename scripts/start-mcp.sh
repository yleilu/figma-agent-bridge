#!/bin/bash
# scripts/start-mcp.sh
# Starts relay (if not running) then MCP server

if [ -n "$PORT" ]; then
  RELAY_PORT="$PORT"

  # Check if relay is already running on explicit port
  if ! lsof -i :"$RELAY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
    PORT="$RELAY_PORT" nohup bun run packages/relay/src/index.ts > /dev/null 2>&1 &

    # Wait for relay to be ready (max 5 seconds)
    for i in $(seq 1 50); do
      if lsof -i :"$RELAY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
  fi
else
  # Auto-assign: start relay and capture its port from stdout
  RELAY_PORT_FILE=$(mktemp)
  bun run packages/relay/src/index.ts > "$RELAY_PORT_FILE" 2>&1 &
  RELAY_PID=$!

  # Wait for relay to print its port (max 5 seconds)
  for i in $(seq 1 50); do
    if grep -q "Relay listening on port" "$RELAY_PORT_FILE" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  RELAY_PORT=$(grep -oE '[0-9]+' "$RELAY_PORT_FILE" | tail -1)
  rm -f "$RELAY_PORT_FILE"

  if [ -z "$RELAY_PORT" ]; then
    echo "Failed to start relay" >&2
    exit 1
  fi
fi

export PORT="$RELAY_PORT"
exec bun run packages/server/src/index.ts "$@"
