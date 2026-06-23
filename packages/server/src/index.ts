import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  connectParamsSchema,
  inspectParamsSchema,
  inspectPageLayoutParamsSchema,
  inspectStylesParamsSchema,
  inspectComponentsParamsSchema,
  searchParamsSchema,
  getNodeParamsSchema,
  getNodesParamsSchema,
  listPagesParamsSchema,
  exportParamsSchema,
  createNodeParamsSchema,
  createTreeParamsSchema,
  createComponentParamsSchema,
  createFromSvgParamsSchema,
} from '@figma-agent-bridge/shared'
import type { CreateTreeNodeSpec } from '@figma-agent-bridge/shared'
import { createFigmaClient } from './figma-client'
import {
  handleConnect,
  handleStatus,
} from './tools/session'
import {
  handleInspect,
  handleInspectPageLayout,
  handleGetNode,
  handleGetNodes,
  handleListPages,
} from './tools/read'
import {
  handleInspectStyles,
  handleInspectComponents,
} from './tools/design-system'
import { handleSearch } from './tools/search'
import { handleExport } from './tools/export'
import {
  handleCreateNode,
  handleCreateTree,
} from './tools/create'
import { handleCreateComponent } from './tools/create-component'
import { handleCreateFromSvg } from './tools/create-svg'

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
const relayHttpUrl = relayUrl
  .replace('wss://', 'https://')
  .replace('ws://', 'http://')
const client = createFigmaClient(relayUrl)

server.tool(
  'connect',
  connectParamsSchema.shape,
  async ({ channel }) =>
    handleConnect({ channel }, client, relayHttpUrl, port),
)

server.tool('status', {}, async () => handleStatus(client))

server.tool(
  'inspect',
  inspectParamsSchema.shape,
  async ({ nodeId }) => handleInspect({ nodeId }, client),
)

server.tool(
  'inspect_page_layout',
  inspectPageLayoutParamsSchema.shape,
  async () => handleInspectPageLayout(client),
)

server.tool(
  'inspect_styles',
  inspectStylesParamsSchema.shape,
  async ({ type }) => handleInspectStyles({ type }, client),
)

server.tool(
  'inspect_components',
  inspectComponentsParamsSchema.shape,
  async ({ query }) =>
    handleInspectComponents({ query }, client),
)

server.tool(
  'search',
  searchParamsSchema.shape,
  async params => handleSearch(params, client),
)

server.tool(
  'get_node',
  getNodeParamsSchema.shape,
  async ({ nodeId, depth }) =>
    handleGetNode({ nodeId, depth }, client),
)

server.tool(
  'get_nodes',
  getNodesParamsSchema.shape,
  async ({ nodeIds, depth }) =>
    handleGetNodes({ nodeIds, depth }, client),
)

server.tool(
  'list_pages',
  listPagesParamsSchema.shape,
  async () => handleListPages(client),
)

server.tool(
  'export',
  exportParamsSchema.shape,
  async params => handleExport(params, client),
)

server.tool(
  'create_node',
  createNodeParamsSchema.shape,
  async params =>
    handleCreateNode(
      {
        parentId: params.parentId,
        node: params.node,
      },
      client,
    ),
)

server.tool(
  'create_tree',
  createTreeParamsSchema.shape,
  async params =>
    handleCreateTree(
      {
        parentId: params.parentId,
        node: params.node as CreateTreeNodeSpec,
      },
      client,
    ),
)

server.tool(
  'create_component',
  createComponentParamsSchema.shape,
  async params =>
    handleCreateComponent(
      {
        nodeId: params.nodeId,
        nodeIds: params.nodeIds,
        combineAsVariants: params.combineAsVariants,
        slots: params.slots,
        componentProperties: params.componentProperties as
          | {
              name: string
              type: string
              default: string | boolean
            }[]
          | undefined,
      },
      client,
    ),
)

server.tool(
  'create_from_svg',
  createFromSvgParamsSchema.shape,
  async params =>
    handleCreateFromSvg(
      {
        parentId: params.parentId,
        svg: params.svg,
        name: params.name,
        size: params.size,
      },
      client,
    ),
)

const transport = new StdioServerTransport()

await server.connect(transport)
