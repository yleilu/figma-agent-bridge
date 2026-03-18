import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  APP_NAME,
  APP_VERSION,
  validatePort,
} from '@figma-agent-bridge/shared'
import { createFigmaClient } from './figma-client'
import { findRelayPort } from './find-relay'
import {
  handleConnect,
  handleStatus,
} from './tools/session'

const server = new McpServer({
  name: APP_NAME,
  version: APP_VERSION,
})

let relayUrl = process.env.RELAY_URL

if (!relayUrl) {
  const envPort = process.env.PORT
  let port: number

  if (envPort !== undefined) {
    port = Number(envPort)
    validatePort(port)
  } else {
    port = await findRelayPort()
  }

  relayUrl = `ws://localhost:${port}`
}

const client = createFigmaClient(relayUrl)

server.tool(
  'connect',
  { channel: z.string().min(1) },
  async ({ channel }) => handleConnect({ channel }, client),
)

server.tool('status', {}, async () => handleStatus(client))

const transport = new StdioServerTransport()

await server.connect(transport)
