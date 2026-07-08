import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  connectParamsSchema,
  createFromSvgParamsSchema,
} from '@figma-agent-bridge/shared'
// M2 param schemas live in tool-params (NOT the barrel — they shadow the
// green-window schemas.ts versions still imported above for the old tools).
import {
  getNodeParamsSchema,
  getNodesParamsSchema,
  inspectParamsSchema,
  searchParamsSchema,
  listPagesParamsSchema,
  getSelectionParamsSchema,
  setSelectionParamsSchema,
  createNodeParamsSchema,
  updateNodeParamsSchema,
  bindVariableParamsSchema,
  getVariablesParamsSchema,
  getStylesParamsSchema,
  getComponentsParamsSchema,
  listFontsParamsSchema,
  getReactionsParamsSchema,
  getPluginDataParamsSchema,
  getAnnotationsParamsSchema,
  exportParamsSchema,
  deleteNodeParamsSchema,
  setFocusParamsSchema,
  createPageParamsSchema,
  setCurrentPageParamsSchema,
  duplicatePageParamsSchema,
  createImageParamsSchema,
  setPluginDataParamsSchema,
  setReactionsParamsSchema,
  setAnnotationsParamsSchema,
  createTreeParamsSchema,
  cloneNodeParamsSchema,
  reparentNodeParamsSchema,
  reorderChildrenParamsSchema,
  booleanOpParamsSchema,
  flattenParamsSchema,
  createComponentParamsSchema,
  updateComponentParamsSchema,
  combineVariantsParamsSchema,
  swapComponentParamsSchema,
  setInstanceParamsSchema,
  createVariablesParamsSchema,
  updateVariablesParamsSchema,
  createStylesParamsSchema,
  updateStylesParamsSchema,
  applyStyleParamsSchema,
  batchParamsSchema,
  recordFeedbackParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'
import { createFigmaClient } from './figma-client'
import {
  handleConnect,
  handleStatus,
} from './tools/session'
import {
  handleInspect,
  handleGetNode,
  handleGetNodes,
  handleListPages,
} from './tools/read'
import {
  handleGetStyles,
  handleGetComponents,
  handleListFonts,
  handleBindVariable,
  handleGetVariables,
} from './tools/design-system'
import {
  handleCreateVariables,
  handleUpdateVariables,
  handleCreateStyles,
  handleUpdateStyles,
  handleApplyStyle,
} from './tools/design-system-authoring'
import {
  handleGetReactions,
  handleGetPluginData,
  handleGetAnnotations,
  handleSetPluginData,
  handleSetReactions,
  handleSetAnnotations,
} from './tools/metadata'
import {
  handleDeleteNode,
  handleSetFocus,
  handleCloneNode,
  handleReparentNode,
  handleReorderChildren,
  handleBooleanOp,
  handleFlatten,
} from './tools/structure'
import {
  handleCreatePage,
  handleSetCurrentPage,
  handleDuplicatePage,
} from './tools/pages'
import { handleCreateImage } from './tools/create-image'
import { handleUpdateNode } from './tools/update'
import { handleSearch } from './tools/search'
import { handleExport } from './tools/export'
import { handleCreateNode } from './tools/create-node'
import {
  handleGetSelection,
  handleSetSelection,
} from './tools/selection'
import { handleCreateTree } from './tools/create-tree'
import {
  handleCreateComponent,
  handleUpdateComponent,
  handleCombineVariants,
  handleSwapComponent,
  handleSetInstance,
} from './tools/components'
import { handleCreateFromSvg } from './tools/create-svg'
import { handleBatch } from './tools/batch'
import { handleRecordFeedback } from './tools/feedback'
import { wireFeedback } from './feedback-wiring'

if (process.argv.includes('--version')) {
  console.log(APP_VERSION)
  // eslint-disable-next-line n/no-process-exit -- CLI --version must exit immediately
  process.exit(0)
}

if (process.argv.includes('--relay')) {
  const { startRelay } =
    await import('@figma-agent-bridge/relay/relay')
  // startRelay is synchronous (Bun.serve binds immediately); no await needed.
  startRelay(Number(process.env.PORT ?? 18080))
} else {
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
  wireFeedback(client)

  server.tool(
    'connect',
    connectParamsSchema.shape,
    async ({ fileKey, fileName, channel }) =>
      handleConnect(
        { fileKey, fileName, channel },
        client,
        relayHttpUrl,
        port,
      ),
  )

  server.tool('status', {}, async () =>
    handleStatus(client, relayHttpUrl),
  )

  server.tool(
    'inspect',
    inspectParamsSchema.shape,
    async params => handleInspect(params, client),
  )

  server.tool(
    'get_styles',
    getStylesParamsSchema.shape,
    async params => handleGetStyles(params, client),
  )

  server.tool(
    'get_components',
    getComponentsParamsSchema.shape,
    async params => handleGetComponents(params, client),
  )

  server.tool(
    'list_fonts',
    listFontsParamsSchema.shape,
    async params => handleListFonts(params, client),
  )

  server.tool(
    'get_reactions',
    getReactionsParamsSchema.shape,
    async params => handleGetReactions(params, client),
  )

  server.tool(
    'get_plugin_data',
    getPluginDataParamsSchema.shape,
    async params => handleGetPluginData(params, client),
  )

  server.tool(
    'get_annotations',
    getAnnotationsParamsSchema.shape,
    async params => handleGetAnnotations(params, client),
  )

  server.tool(
    'search',
    searchParamsSchema.shape,
    async params => handleSearch(params, client),
  )

  server.tool(
    'get_node',
    getNodeParamsSchema.shape,
    async params => handleGetNode(params, client),
  )

  server.tool(
    'get_nodes',
    getNodesParamsSchema.shape,
    async ({ nodeIds, depth, fields, profile }) =>
      handleGetNodes(
        { nodeIds, depth, fields, profile },
        client,
      ),
  )

  server.tool(
    'list_pages',
    listPagesParamsSchema.shape,
    async params => handleListPages(params, client),
  )

  server.tool(
    'get_selection',
    getSelectionParamsSchema.shape,
    async () => handleGetSelection(client),
  )

  server.tool(
    'set_selection',
    setSelectionParamsSchema.shape,
    async ({ nodeIds }) =>
      handleSetSelection({ nodeIds }, client),
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
          spec: params.spec,
          parentId: params.parentId,
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
          tree: params.tree,
          parentId: params.parentId,
          refs: params.refs,
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
          name: params.name,
          description: params.description,
        },
        client,
      ),
  )

  server.tool(
    'update_component',
    updateComponentParamsSchema.shape,
    async params => handleUpdateComponent(params, client),
  )

  server.tool(
    'combine_variants',
    combineVariantsParamsSchema.shape,
    async params => handleCombineVariants(params, client),
  )

  server.tool(
    'swap_component',
    swapComponentParamsSchema.shape,
    async params => handleSwapComponent(params, client),
  )

  server.tool(
    'set_instance',
    setInstanceParamsSchema.shape,
    async params => handleSetInstance(params, client),
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

  server.tool(
    'update_node',
    updateNodeParamsSchema.shape,
    async params => handleUpdateNode(params, client),
  )

  server.tool(
    'bind_variable',
    bindVariableParamsSchema.shape,
    async params => handleBindVariable(params, client),
  )

  server.tool(
    'get_variables',
    getVariablesParamsSchema.shape,
    async params => handleGetVariables(params, client),
  )

  server.tool(
    'delete_node',
    deleteNodeParamsSchema.shape,
    async params => handleDeleteNode(params, client),
  )

  server.tool(
    'set_focus',
    setFocusParamsSchema.shape,
    async params => handleSetFocus(params, client),
  )

  server.tool(
    'clone_node',
    cloneNodeParamsSchema.shape,
    async params => handleCloneNode(params, client),
  )

  server.tool(
    'reparent_node',
    reparentNodeParamsSchema.shape,
    async params => handleReparentNode(params, client),
  )

  server.tool(
    'reorder_children',
    reorderChildrenParamsSchema.shape,
    async params => handleReorderChildren(params, client),
  )

  server.tool(
    'boolean_op',
    booleanOpParamsSchema.shape,
    async params => handleBooleanOp(params, client),
  )

  server.tool(
    'flatten',
    flattenParamsSchema.shape,
    async params => handleFlatten(params, client),
  )

  server.tool(
    'create_page',
    createPageParamsSchema.shape,
    async params => handleCreatePage(params, client),
  )

  server.tool(
    'set_current_page',
    setCurrentPageParamsSchema.shape,
    async params => handleSetCurrentPage(params, client),
  )

  server.tool(
    'duplicate_page',
    duplicatePageParamsSchema.shape,
    async params => handleDuplicatePage(params, client),
  )

  server.tool(
    'create_image',
    createImageParamsSchema.shape,
    async params => handleCreateImage(params, client),
  )

  server.tool(
    'set_plugin_data',
    setPluginDataParamsSchema.shape,
    async params => handleSetPluginData(params, client),
  )

  server.tool(
    'set_reactions',
    setReactionsParamsSchema.shape,
    async params => handleSetReactions(params, client),
  )

  server.tool(
    'set_annotations',
    setAnnotationsParamsSchema.shape,
    async params => handleSetAnnotations(params, client),
  )

  server.tool(
    'create_variables',
    createVariablesParamsSchema.shape,
    async params => handleCreateVariables(params, client),
  )

  server.tool(
    'update_variables',
    updateVariablesParamsSchema.shape,
    async params => handleUpdateVariables(params, client),
  )

  server.tool(
    'create_styles',
    createStylesParamsSchema.shape,
    async params => handleCreateStyles(params, client),
  )

  server.tool(
    'update_styles',
    updateStylesParamsSchema.shape,
    async params => handleUpdateStyles(params, client),
  )

  server.tool(
    'apply_style',
    applyStyleParamsSchema.shape,
    async params => handleApplyStyle(params, client),
  )

  server.tool(
    'batch',
    batchParamsSchema.shape,
    async params => handleBatch(params, client),
  )

  server.tool(
    'record_feedback',
    recordFeedbackParamsSchema.shape,
    async params => handleRecordFeedback(params, client),
  )

  const transport = new StdioServerTransport()

  await server.connect(transport)
}
