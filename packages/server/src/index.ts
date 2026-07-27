import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  connectParamsSchema,
  createFromSvgParamsSchema,
  genId,
} from '@figma-agent-bridge/shared'
import { COUNT_DEBOUNCE_MS } from '@figma-agent-bridge/shared/change-feed'
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
  groupNodesParamsSchema,
  transformGroupParamsSchema,
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
  deleteStylesParamsSchema,
  applyStyleParamsSchema,
  batchParamsSchema,
  statusParamsSchema,
  recordFeedbackParamsSchema,
  searchComponentsParamsSchema,
  reindexParamsSchema,
  pullChangesParamsSchema,
  reportStatusParamsSchema,
  listFeedbackParamsSchema,
  sendFeedbackParamsSchema,
  discardFeedbackParamsSchema,
  githubAuthStartParamsSchema,
  githubAuthPollParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'
import type { ZodRawShape } from 'zod'
import {
  createFigmaClient,
  toHttpUrl,
} from './figma-client'
import type { ScopedFigmaClient } from './figma-client'
import {
  registerFileTool,
  registerSessionTool,
} from './tools/with-file'
import type { FileHandlerParams } from './tools/with-file'
import {
  registerBufferTool,
  handlePullChanges,
} from './tools/with-buffer'
import {
  ChangeFeed,
  isImmediateWrite,
} from './change-feed/feed'
import { attachChangeFeed } from './change-feed/attach'
import { createCountMirror } from './change-feed/count-mirror'
import { sessionIdentity } from './change-feed/session-identity'
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
  handleDeleteStyles,
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
  handleGroupNodes,
  handleTransformGroup,
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
import {
  handleListFeedback,
  handleSendFeedback,
  handleDiscardFeedback,
} from './tools/feedback-send'
import {
  handleGithubAuthStart,
  handleGithubAuthPoll,
} from './tools/github-auth'
import { IndexManager } from './component-index/manager'
import {
  handleSearchComponents,
  handleReindex,
} from './tools/component-index'
import { handleReportStatus } from './tools/report-status'

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

  const indexManager = new IndexManager()

  // change-feed.md — the count + state mirror the presence hook reads. It is
  // written on the PUSH path, which carries no sessionId, so the writer keys on
  // the REMEMBERED identity and falls back to the `_unattributed` sentinel.
  const countMirror = createCountMirror({
    writer: genId('srv'),
    debounceMs: COUNT_DEBOUNCE_MS,
    sessionId: () => sessionIdentity.current(),
  })
  // Adoption: a session's first Figma tool call may come AFTER the user has
  // already edited — the server writes the sentinel at a nonzero count, then
  // learns the id and migrates.
  sessionIdentity.onAdopt(id => {
    void countMirror.migrate(id)
  })

  // change-feed.md — the per-fileKey buffer, its push handler and the two
  // server-side broken-baseline arms. attachChangeFeed OWNS the
  // document_changed registration: the component index's slice of that frame
  // rides inside it via markIndexStale.
  //
  // The spec's write-trigger rows map one-to-one: `open`, `arm` and `drain`
  // are immediate BY REASON (isImmediateWrite names them), and `ingest` falls
  // through to the mirror's leading-edge / state-change / return-to-quiet
  // conditions. The count is DERIVED from the map sizes, never a separately
  // maintained counter that could drift under drain/push interleaving;
  // context slots never count.
  const feed = new ChangeFeed((buffer, reason) => {
    void countMirror.write(
      buffer.fileKey,
      buffer.nodes.size + buffer.styles.size,
      buffer.state,
      { immediate: isImmediateWrite(reason) },
    )
  })
  attachChangeFeed(client, feed, fileKey => {
    indexManager.markStale(fileKey)
  })

  // The sentinel has no session to end — no SessionEnd hook can retire it, so
  // this process unlinks its own on a clean exit. A kill leaves it behind,
  // which is why the reader expires one older than SENTINEL_TTL_MS.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      countMirror.shutdown()
      // eslint-disable-next-line n/no-process-exit -- a signal handler must terminate
      process.exit(0)
    })
  }
  process.on('exit', () => {
    countMirror.shutdown()
  })

  // The baseline hook, bound once and threaded into every file-addressed tool
  // by `fileTool` below. A re-join after a disconnect does NOT open a clean
  // baseline — openBaseline preserves the armed buffer, which is what keeps a
  // server↔relay gap from silently reporting "0 pending edits".
  const onJoined = (
    fileKey: string,
    epoch: string | null,
  ): void => {
    feed.openBaseline(fileKey, epoch)
  }

  /** registerFileTool with `server`, `client` and the baseline hook bound. */
  const fileTool = <S extends ZodRawShape, R>(
    name: string,
    schema: { shape: S },
    handler: (
      params: FileHandlerParams<S>,
      scoped: ScopedFigmaClient,
    ) => Promise<R>,
  ): void => {
    registerFileTool(
      server,
      client,
      name,
      schema,
      handler,
      onJoined,
    )
  }

  // --- Session tools (NOT file-addressed) ------------------------------------
  // These address the connection, not a per-call file, so they take the REAL
  // client and are NOT gated by requireFile.
  registerSessionTool(
    server,
    'connect',
    connectParamsSchema,
    p =>
      handleConnect(
        p,
        client,
        relayHttpUrl,
        port,
        onJoined,
      ),
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
    p => handleRecordFeedback(p),
  )

  registerSessionTool(
    server,
    'list_feedback',
    listFeedbackParamsSchema,
    p => handleListFeedback(p),
  )

  registerSessionTool(
    server,
    'send_feedback',
    sendFeedbackParamsSchema,
    p => handleSendFeedback(p),
  )

  registerSessionTool(
    server,
    'discard_feedback',
    discardFeedbackParamsSchema,
    p => handleDiscardFeedback(p),
  )

  registerSessionTool(
    server,
    'github_auth_start',
    githubAuthStartParamsSchema,
    () =>
      handleGithubAuthStart(OAUTH_CLIENT_ID, OAUTH_SCOPE),
  )

  registerSessionTool(
    server,
    'github_auth_poll',
    githubAuthPollParamsSchema,
    () => handleGithubAuthPoll(),
  )

  // --- File-addressed tools (B3) ---------------------------------------------
  // Every tool below is registered through registerFileTool (via the `fileTool`
  // binding above): the wrapper reads `fileKey` from the validated params, gates
  // via requireFile, opens the change-feed baseline on a join, and hands the
  // handler a file-scoped client (identity fields moved into meta). A scoped
  // handler cannot reach server.tool any other way, so a forgotten wrapper is a
  // compile error, not a silent WRONG_FILE.
  fileTool('inspect', inspectParamsSchema, handleInspect)
  fileTool(
    'get_styles',
    getStylesParamsSchema,
    handleGetStyles,
  )
  fileTool(
    'get_components',
    getComponentsParamsSchema,
    handleGetComponents,
  )
  fileTool(
    'list_fonts',
    listFontsParamsSchema,
    handleListFonts,
  )
  fileTool(
    'get_reactions',
    getReactionsParamsSchema,
    handleGetReactions,
  )
  fileTool(
    'get_plugin_data',
    getPluginDataParamsSchema,
    handleGetPluginData,
  )
  fileTool(
    'get_annotations',
    getAnnotationsParamsSchema,
    handleGetAnnotations,
  )
  fileTool('search', searchParamsSchema, handleSearch)
  fileTool('get_node', getNodeParamsSchema, handleGetNode)
  fileTool(
    'get_nodes',
    getNodesParamsSchema,
    handleGetNodes,
  )
  fileTool(
    'list_pages',
    listPagesParamsSchema,
    handleListPages,
  )
  fileTool(
    'get_selection',
    getSelectionParamsSchema,
    handleGetSelection,
  )
  fileTool(
    'set_selection',
    setSelectionParamsSchema,
    handleSetSelection,
  )
  fileTool('export', exportParamsSchema, handleExport)
  fileTool(
    'create_node',
    createNodeParamsSchema,
    handleCreateNode,
  )
  fileTool(
    'create_tree',
    createTreeParamsSchema,
    handleCreateTree,
  )
  fileTool(
    'create_component',
    createComponentParamsSchema,
    handleCreateComponent,
  )
  fileTool(
    'update_component',
    updateComponentParamsSchema,
    handleUpdateComponent,
  )
  fileTool(
    'combine_variants',
    combineVariantsParamsSchema,
    handleCombineVariants,
  )
  fileTool(
    'swap_component',
    swapComponentParamsSchema,
    handleSwapComponent,
  )
  fileTool(
    'set_instance',
    setInstanceParamsSchema,
    handleSetInstance,
  )
  fileTool(
    'create_from_svg',
    createFromSvgParamsSchema,
    handleCreateFromSvg,
  )
  fileTool(
    'update_node',
    updateNodeParamsSchema,
    handleUpdateNode,
  )
  fileTool(
    'bind_variable',
    bindVariableParamsSchema,
    handleBindVariable,
  )
  fileTool(
    'get_variables',
    getVariablesParamsSchema,
    handleGetVariables,
  )
  fileTool(
    'delete_node',
    deleteNodeParamsSchema,
    handleDeleteNode,
  )
  fileTool(
    'set_focus',
    setFocusParamsSchema,
    handleSetFocus,
  )
  fileTool(
    'clone_node',
    cloneNodeParamsSchema,
    handleCloneNode,
  )
  fileTool(
    'reparent_node',
    reparentNodeParamsSchema,
    handleReparentNode,
  )
  fileTool(
    'reorder_children',
    reorderChildrenParamsSchema,
    handleReorderChildren,
  )
  fileTool(
    'boolean_op',
    booleanOpParamsSchema,
    handleBooleanOp,
  )
  fileTool('flatten', flattenParamsSchema, handleFlatten)
  fileTool(
    'group_nodes',
    groupNodesParamsSchema,
    handleGroupNodes,
  )
  fileTool(
    'transform_group',
    transformGroupParamsSchema,
    handleTransformGroup,
  )
  fileTool(
    'create_page',
    createPageParamsSchema,
    handleCreatePage,
  )
  fileTool(
    'set_current_page',
    setCurrentPageParamsSchema,
    handleSetCurrentPage,
  )
  fileTool(
    'duplicate_page',
    duplicatePageParamsSchema,
    handleDuplicatePage,
  )
  fileTool(
    'create_image',
    createImageParamsSchema,
    handleCreateImage,
  )
  fileTool(
    'set_plugin_data',
    setPluginDataParamsSchema,
    handleSetPluginData,
  )
  fileTool(
    'set_reactions',
    setReactionsParamsSchema,
    handleSetReactions,
  )
  fileTool(
    'set_annotations',
    setAnnotationsParamsSchema,
    handleSetAnnotations,
  )
  fileTool(
    'create_variables',
    createVariablesParamsSchema,
    handleCreateVariables,
  )
  fileTool(
    'update_variables',
    updateVariablesParamsSchema,
    handleUpdateVariables,
  )
  fileTool(
    'delete_variables',
    deleteVariablesParamsSchema,
    handleDeleteVariables,
  )
  fileTool(
    'create_styles',
    createStylesParamsSchema,
    handleCreateStyles,
  )
  fileTool(
    'update_styles',
    updateStylesParamsSchema,
    handleUpdateStyles,
  )
  fileTool(
    'delete_styles',
    deleteStylesParamsSchema,
    handleDeleteStyles,
  )
  fileTool(
    'apply_style',
    applyStyleParamsSchema,
    handleApplyStyle,
  )
  fileTool('batch', batchParamsSchema, handleBatch)

  // Component-index tools carry the extra indexManager arg (Task 7 reconciles
  // their bodies onto the scoped client + requireFile).
  fileTool(
    'search_components',
    searchComponentsParamsSchema,
    (params, scoped) =>
      handleSearchComponents(params, scoped, indexManager),
  )
  fileTool(
    'reindex',
    reindexParamsSchema,
    (params, scoped) =>
      handleReindex(params, scoped, indexManager),
  )

  // report_status (status-monitor.md): a fire-and-forget, file-scoped status
  // push — never reaches code.ts/figma.* (not in COMMANDS). Identity rides on
  // the scoped client (scoped.identity), surfaced by forFile (Task 5).
  fileTool(
    'report_status',
    reportStatusParamsSchema,
    (p, scoped) => handleReportStatus(p, scoped),
  )

  // pull_changes (change-feed.md) — a NON-FACADE meta-tool. It reaches
  // server.tool through registerBufferTool, the third registration wrapper:
  // it dispatches nothing to Figma, so it must not run the command gate.
  registerBufferTool(
    server,
    client,
    feed,
    'pull_changes',
    pullChangesParamsSchema,
    handlePullChanges,
  )

  const transport = new StdioServerTransport()

  await server.connect(transport)
}
