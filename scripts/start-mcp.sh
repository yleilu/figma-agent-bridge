#!/bin/bash
# scripts/start-mcp.sh
# Starts relay (if not running) then MCP server.
# Server auto-discovers the relay port via ping/pong probe.

RELAY_PORT="${PORT:-18080}"

# Start relay if not already listening
if ! lsof -i :"$RELAY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
  nohup bun run packages/relay/src/index.ts > /dev/null 2>&1 &

  # Wait for relay to be ready (max 5 seconds)
  for i in $(seq 1 50); do
    if lsof -i :"$RELAY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

exec bun run packages/server/src/index.ts "$@"
