import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createFigmaClient } from './figma-client'
import {
  handleConnect,
  handleStatus,
} from './tools/session'

const server = new McpServer({
  name: 'figma-agent-bridge',
  version: '0.0.1',
})

const port = process.env.PORT ?? '3000'

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
