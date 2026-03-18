import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  APP_NAME,
  APP_VERSION,
  validatePort,
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

const port = Number(process.env.PORT ?? '3000')
validatePort(port)

const client = createFigmaClient(
  process.env.RELAY_URL ?? `ws://localhost:${port}`,
)

server.tool(
  'connect',
  { channel: z.string().min(1) },
  async ({ channel }) => handleConnect({ channel }, client),
)

server.tool('status', {}, async () => handleStatus(client))

const transport = new StdioServerTransport()

await server.connect(transport)
