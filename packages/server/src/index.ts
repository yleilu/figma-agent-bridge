import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  APP_NAME,
  APP_VERSION,
  COMMANDS,
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
  deleteVariablesParamsSchema,
  createStylesParamsSchema,
  updateStylesParamsSchema,
  applyStyleParamsSchema,
  batchParamsSchema,
  statusParamsSchema,
  recordFeedbackParamsSchema,
  searchComponentsParamsSchema,
  reindexParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'
import {
  createFigmaClient,
  toHttpUrl,
} from './figma-client'
import {
  registerFileTool,
  registerSessionTool,
} from './tools/with-file'
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
  handleDeleteVariables,
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
import { IndexManager } from './component-index/manager'
import {
  handleSearchComponents,
  handleReindex,
} from './tools/component-index'

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
  const relayHttpUrl = toHttpUrl(relayUrl)
  const client = createFigmaClient(relayUrl)
  wireFeedback(client)

  const indexManager = new IndexManager()

  client.onRequest(COMMANDS.DOCUMENT_CHANGED, params => {
    const { fileId } = params
    if (typeof fileId === 'string') {
      indexManager.markStale(fileId)
    }
    return { ok: true }
  })

  // --- Session tools (NOT file-addressed) ------------------------------------
  // These address the connection, not a per-call file, so they take the REAL
  // client and are NOT gated by requireFile.
  registerSessionTool(
    server,
    'connect',
    connectParamsSchema,
    p => handleConnect(p, client, relayHttpUrl, port),
  )

  registerSessionTool(
    server,
    'status',
    statusParamsSchema,
    () => handleStatus(client, relayHttpUrl),
  )

  registerSessionTool(
    server,
    'record_feedback',
    recordFeedbackParamsSchema,
    p => handleRecordFeedback(p, client),
  )

  // --- File-addressed tools (B3) ---------------------------------------------
  // Every tool below is registered through registerFileTool: the wrapper reads
  // `fileKey` from the validated params, gates via requireFile, and hands the
  // handler a file-scoped client (identity fields moved into meta). A scoped
  // handler cannot reach server.tool any other way, so a forgotten wrapper is a
  // compile error, not a silent WRONG_FILE.
  registerFileTool(
    server,
    client,
    'inspect',
    inspectParamsSchema,
    handleInspect,
  )
  registerFileTool(
    server,
    client,
    'get_styles',
    getStylesParamsSchema,
    handleGetStyles,
  )
  registerFileTool(
    server,
    client,
    'get_components',
    getComponentsParamsSchema,
    handleGetComponents,
  )
  registerFileTool(
    server,
    client,
    'list_fonts',
    listFontsParamsSchema,
    handleListFonts,
  )
  registerFileTool(
    server,
    client,
    'get_reactions',
    getReactionsParamsSchema,
    handleGetReactions,
  )
  registerFileTool(
    server,
    client,
    'get_plugin_data',
    getPluginDataParamsSchema,
    handleGetPluginData,
  )
  registerFileTool(
    server,
    client,
    'get_annotations',
    getAnnotationsParamsSchema,
    handleGetAnnotations,
  )
  registerFileTool(
    server,
    client,
    'search',
    searchParamsSchema,
    handleSearch,
  )
  registerFileTool(
    server,
    client,
    'get_node',
    getNodeParamsSchema,
    handleGetNode,
  )
  registerFileTool(
    server,
    client,
    'get_nodes',
    getNodesParamsSchema,
    handleGetNodes,
  )
  registerFileTool(
    server,
    client,
    'list_pages',
    listPagesParamsSchema,
    handleListPages,
  )
  registerFileTool(
    server,
    client,
    'get_selection',
    getSelectionParamsSchema,
    handleGetSelection,
  )
  registerFileTool(
    server,
    client,
    'set_selection',
    setSelectionParamsSchema,
    handleSetSelection,
  )
  registerFileTool(
    server,
    client,
    'export',
    exportParamsSchema,
    handleExport,
  )
  registerFileTool(
    server,
    client,
    'create_node',
    createNodeParamsSchema,
    handleCreateNode,
  )
  registerFileTool(
    server,
    client,
    'create_tree',
    createTreeParamsSchema,
    handleCreateTree,
  )
  registerFileTool(
    server,
    client,
    'create_component',
    createComponentParamsSchema,
    handleCreateComponent,
  )
  registerFileTool(
    server,
    client,
    'update_component',
    updateComponentParamsSchema,
    handleUpdateComponent,
  )
  registerFileTool(
    server,
    client,
    'combine_variants',
    combineVariantsParamsSchema,
    handleCombineVariants,
  )
  registerFileTool(
    server,
    client,
    'swap_component',
    swapComponentParamsSchema,
    handleSwapComponent,
  )
  registerFileTool(
    server,
    client,
    'set_instance',
    setInstanceParamsSchema,
    handleSetInstance,
  )
  registerFileTool(
    server,
    client,
    'create_from_svg',
    createFromSvgParamsSchema,
    handleCreateFromSvg,
  )
  registerFileTool(
    server,
    client,
    'update_node',
    updateNodeParamsSchema,
    handleUpdateNode,
  )
  registerFileTool(
    server,
    client,
    'bind_variable',
    bindVariableParamsSchema,
    handleBindVariable,
  )
  registerFileTool(
    server,
    client,
    'get_variables',
    getVariablesParamsSchema,
    handleGetVariables,
  )
  registerFileTool(
    server,
    client,
    'delete_node',
    deleteNodeParamsSchema,
    handleDeleteNode,
  )
  registerFileTool(
    server,
    client,
    'set_focus',
    setFocusParamsSchema,
    handleSetFocus,
  )
  registerFileTool(
    server,
    client,
    'clone_node',
    cloneNodeParamsSchema,
    handleCloneNode,
  )
  registerFileTool(
    server,
    client,
    'reparent_node',
    reparentNodeParamsSchema,
    handleReparentNode,
  )
  registerFileTool(
    server,
    client,
    'reorder_children',
    reorderChildrenParamsSchema,
    handleReorderChildren,
  )
  registerFileTool(
    server,
    client,
    'boolean_op',
    booleanOpParamsSchema,
    handleBooleanOp,
  )
  registerFileTool(
    server,
    client,
    'flatten',
    flattenParamsSchema,
    handleFlatten,
  )
  registerFileTool(
    server,
    client,
    'create_page',
    createPageParamsSchema,
    handleCreatePage,
  )
  registerFileTool(
    server,
    client,
    'set_current_page',
    setCurrentPageParamsSchema,
    handleSetCurrentPage,
  )
  registerFileTool(
    server,
    client,
    'duplicate_page',
    duplicatePageParamsSchema,
    handleDuplicatePage,
  )
  registerFileTool(
    server,
    client,
    'create_image',
    createImageParamsSchema,
    handleCreateImage,
  )
  registerFileTool(
    server,
    client,
    'set_plugin_data',
    setPluginDataParamsSchema,
    handleSetPluginData,
  )
  registerFileTool(
    server,
    client,
    'set_reactions',
    setReactionsParamsSchema,
    handleSetReactions,
  )
  registerFileTool(
    server,
    client,
    'set_annotations',
    setAnnotationsParamsSchema,
    handleSetAnnotations,
  )
  registerFileTool(
    server,
    client,
    'create_variables',
    createVariablesParamsSchema,
    handleCreateVariables,
  )
  registerFileTool(
    server,
    client,
    'update_variables',
    updateVariablesParamsSchema,
    handleUpdateVariables,
  )
  registerFileTool(
    server,
    client,
    'delete_variables',
    deleteVariablesParamsSchema,
    handleDeleteVariables,
  )
  registerFileTool(
    server,
    client,
    'create_styles',
    createStylesParamsSchema,
    handleCreateStyles,
  )
  registerFileTool(
    server,
    client,
    'update_styles',
    updateStylesParamsSchema,
    handleUpdateStyles,
  )
  registerFileTool(
    server,
    client,
    'apply_style',
    applyStyleParamsSchema,
    handleApplyStyle,
  )
  registerFileTool(
    server,
    client,
    'batch',
    batchParamsSchema,
    handleBatch,
  )

  // Component-index tools carry the extra indexManager arg (Task 7 reconciles
  // their bodies onto the scoped client + requireFile).
  registerFileTool(
    server,
    client,
    'search_components',
    searchComponentsParamsSchema,
    (params, scoped) =>
      handleSearchComponents(params, scoped, indexManager),
  )
  registerFileTool(
    server,
    client,
    'reindex',
    reindexParamsSchema,
    (params, scoped) =>
      handleReindex(params, scoped, indexManager),
  )

  const transport = new StdioServerTransport()

  await server.connect(transport)
}
