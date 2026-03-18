import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
} from '@figma-agent-bridge/shared'
import { createFigmaClient } from './figma-client'
import {
  handleConnect,
  handleStatus,
} from './tools/session'

const server = new McpServer({
  name: APP_NAME,
  version: APP_VERSION,
})

const port =
  process.env.PORT !== undefined
    ? Number(process.env.PORT)
    : DEFAULT_PORT

const relayUrl =
  process.env.RELAY_URL ?? `ws://localhost:${port}`
const client = createFigmaClient(relayUrl)

server.tool(
  'connect',
  { channel: z.string().min(1) },
  async ({ channel }) => handleConnect({ channel }, client),
)

server.tool('status', {}, async () => handleStatus(client))

const transport = new StdioServerTransport()

await server.connect(transport)
