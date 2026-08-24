// strict-params.test.ts — M22b: every tool schema rejects an unknown top-level
// param, and the strictness SURVIVES registration.
//
// Root cause this pins: a plain `z.object` STRIPS an unknown key before the
// handler runs, so `update_component {remove:[…]}` answered ok with an empty
// `warnings` and an unchanged property list — the param never existed and
// nothing said so (M22). B52 already made `search` strict after the same class
// inverted a reply. This file makes the treatment systemic, and it guards the
// second half of the trap (with-file.ts ~line 135): `server.tool(name, shape,
// cb)` re-wraps the SHAPE in a fresh plain `z.object`, which silently discards
// `.strict()`. A schema that reads strict and a wire that strips is worse than
// neither, so both halves are asserted here.

import { describe, it, expect } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { ChannelInfo } from '@figma-agent-bridge/shared'
import {
  connectParamsSchema,
  createFromSvgParamsSchema,
} from '@figma-agent-bridge/shared'
import * as toolParams from '@figma-agent-bridge/shared/tool-params'
import { textResult } from '@figma-agent-bridge/server/tools/shared'
import {
  registerFileTool,
  registerSessionTool,
} from '@figma-agent-bridge/server/tools/with-file'
import { registerBufferTool } from '@figma-agent-bridge/server/tools/with-buffer'
import { ChangeFeed } from '@figma-agent-bridge/server/change-feed/feed'

const stubClient = (
  over: Partial<FigmaClient> = {},
): FigmaClient =>
  ({
    joinChannel: () => Promise.resolve(''),
    sendCommand: () => Promise.resolve(null),
    forFile: (fileKey: string) => ({
      fileKey,
      sendCommand: () => Promise.resolve(null),
    }),
    notify: () => undefined,
    onRequest: () => undefined,
    disconnect: () => undefined,
    isConnected: () => true,
    joinedFiles: () => [],
    channelFor: () => 'ch-a',
    discover: () => Promise.resolve([] as ChannelInfo[]),
    isInstanceDead: () => false,
    onSocketClose: () => undefined,
    onFileDead: () => undefined,
    ...over,
  }) as FigmaClient

type Registered = {
  name: string
  config: { inputSchema?: unknown }
}

const captureServer = (sink: Registered[]): McpServer =>
  ({
    registerTool: (
      name: string,
      config: { inputSchema?: unknown },
    ) => {
      sink.push({ name, config })
    },
    // A registration that falls through to the DEPRECATED shape path is the
    // silent-strip bug itself, so the probe records it as such and the
    // assertions below fail on the schema identity.
    tool: (name: string, shape: unknown) => {
      sink.push({ name, config: { inputSchema: shape } })
    },
  }) as unknown as McpServer

const unknownKeysOf = (
  schema: unknown,
): string | undefined =>
  (
    (schema as { _def?: { unknownKeys?: string } })._def ??
    {}
  ).unknownKeys

/**
 * Every schema index.ts registers as a tool, by tool name. The three
 * registration paths are grouped because each one had to be fixed separately —
 * a strict schema means nothing on a path that re-wraps the shape.
 */
const FILE_TOOLS = {
  inspect: toolParams.inspectParamsSchema,
  get_styles: toolParams.getStylesParamsSchema,
  get_components: toolParams.getComponentsParamsSchema,
  list_fonts: toolParams.listFontsParamsSchema,
  get_reactions: toolParams.getReactionsParamsSchema,
  get_plugin_data: toolParams.getPluginDataParamsSchema,
  get_annotations: toolParams.getAnnotationsParamsSchema,
  search: toolParams.searchParamsSchema,
  get_node: toolParams.getNodeParamsSchema,
  get_nodes: toolParams.getNodesParamsSchema,
  list_pages: toolParams.listPagesParamsSchema,
  get_selection: toolParams.getSelectionParamsSchema,
  set_selection: toolParams.setSelectionParamsSchema,
  export: toolParams.exportParamsSchema,
  create_node: toolParams.createNodeParamsSchema,
  create_tree: toolParams.createTreeParamsSchema,
  create_component: toolParams.createComponentParamsSchema,
  update_component: toolParams.updateComponentParamsSchema,
  combine_variants: toolParams.combineVariantsParamsSchema,
  swap_component: toolParams.swapComponentParamsSchema,
  set_instance: toolParams.setInstanceParamsSchema,
  create_from_svg: createFromSvgParamsSchema,
  update_node: toolParams.updateNodeParamsSchema,
  bind_variable: toolParams.bindVariableParamsSchema,
  get_variables: toolParams.getVariablesParamsSchema,
  delete_node: toolParams.deleteNodeParamsSchema,
  set_focus: toolParams.setFocusParamsSchema,
  clone_node: toolParams.cloneNodeParamsSchema,
  reparent_node: toolParams.reparentNodeParamsSchema,
  reorder_children: toolParams.reorderChildrenParamsSchema,
  boolean_op: toolParams.booleanOpParamsSchema,
  flatten: toolParams.flattenParamsSchema,
  group_nodes: toolParams.groupNodesParamsSchema,
  transform_group: toolParams.transformGroupParamsSchema,
  create_page: toolParams.createPageParamsSchema,
  set_current_page: toolParams.setCurrentPageParamsSchema,
  duplicate_page: toolParams.duplicatePageParamsSchema,
  create_image: toolParams.createImageParamsSchema,
  set_plugin_data: toolParams.setPluginDataParamsSchema,
  set_reactions: toolParams.setReactionsParamsSchema,
  set_annotations: toolParams.setAnnotationsParamsSchema,
  create_variables: toolParams.createVariablesParamsSchema,
  update_variables: toolParams.updateVariablesParamsSchema,
  delete_variables: toolParams.deleteVariablesParamsSchema,
  create_styles: toolParams.createStylesParamsSchema,
  update_styles: toolParams.updateStylesParamsSchema,
  delete_styles: toolParams.deleteStylesParamsSchema,
  apply_style: toolParams.applyStyleParamsSchema,
  batch: toolParams.batchParamsSchema,
  search_components:
    toolParams.searchComponentsParamsSchema,
  reindex: toolParams.reindexParamsSchema,
  report_status: toolParams.reportStatusParamsSchema,
} as const

const SESSION_TOOLS = {
  connect: connectParamsSchema,
  status: toolParams.statusParamsSchema,
  record_feedback: toolParams.recordFeedbackParamsSchema,
  list_feedback: toolParams.listFeedbackParamsSchema,
  send_feedback: toolParams.sendFeedbackParamsSchema,
  discard_feedback: toolParams.discardFeedbackParamsSchema,
  github_auth_start: toolParams.githubAuthStartParamsSchema,
  github_auth_poll: toolParams.githubAuthPollParamsSchema,
} as const

const BUFFER_TOOLS = {
  pull_changes: toolParams.pullChangesParamsSchema,
} as const

const ALL_TOOLS = {
  ...FILE_TOOLS,
  ...SESSION_TOOLS,
  ...BUFFER_TOOLS,
}

describe('every tool params schema is strict (M22b)', () => {
  it('covers the whole registered surface', () => {
    // The registration count index.ts exposes: 52 `fileTool(…)` calls (the 51
    // facades of tool-surface.md plus `report_status`, which pushes display
    // state and never reaches COMMANDS), 8 session tools, 1 buffer tool.
    expect(Object.keys(FILE_TOOLS).length).toBe(52)
    expect(Object.keys(SESSION_TOOLS).length).toBe(8)
    expect(Object.keys(BUFFER_TOOLS).length).toBe(1)
  })

  it('marks every schema strict, so no unknown key is ever stripped', () => {
    for (const [name, schema] of Object.entries(
      ALL_TOOLS,
    )) {
      expect(`${name}:${unknownKeysOf(schema)}`).toBe(
        `${name}:strict`,
      )
    }
  })

  it('rejects an unknown top-level key on every tool, naming it', () => {
    for (const [name, schema] of Object.entries(
      ALL_TOOLS,
    )) {
      const parsed = (
        schema as {
          safeParse: (v: unknown) => {
            success: boolean
            error?: { issues: unknown[]; message: string }
          }
        }
      ).safeParse({
        fileKey: 'fk',
        totallyNotAParam: 1,
      })
      expect(`${name}:${parsed.success}`).toBe(
        `${name}:false`,
      )
      // The reply must NAME the key — zod's unrecognized_keys issue carries a
      // `keys` array and ZodError.message renders the issue list verbatim.
      expect(
        `${name}:${parsed.error?.message.includes('totallyNotAParam')}`,
      ).toBe(`${name}:true`)
    }
  })

  // The hazard strictness creates: plugin/hooks/identity is a PreToolUse hook
  // matching EVERY figma-bridge tool, and it stamps `sessionId` on every call
  // plus `agentId`/`agentType` on every subagent call. Zod used to strip those
  // on the eight connection-addressed tools, which never declared them. A
  // strict schema that still did not declare them would reject every hooked
  // call — `status`, `connect` and the feedback tools would stop working the
  // moment the plugin's hooks are installed. So every tool declares them.
  it('declares the reserved identity headers the PreToolUse hook stamps', () => {
    for (const [name, schema] of Object.entries(
      ALL_TOOLS,
    )) {
      const parsed = (
        schema as {
          safeParse: (v: unknown) => {
            success: boolean
            error?: { message: string }
          }
        }
      ).safeParse({
        // Every required param of every tool is absent here on purpose: what
        // matters is that the failure is NEVER an unrecognized identity key.
        sessionId: 'sess-1',
        agentId: 'agent-1',
        agentType: 'figma-designer',
      })
      const complaint = parsed.error?.message ?? ''
      expect(
        `${name}:${complaint.includes('unrecognized_keys')}`,
      ).toBe(`${name}:false`)
    }
  })
})

describe('strictness survives registration (the B52 trap)', () => {
  it('registerFileTool hands the SDK the schema object itself', () => {
    const sink: Registered[] = []
    registerFileTool(
      captureServer(sink),
      stubClient(),
      'update_component',
      toolParams.updateComponentParamsSchema,
      async () => textResult('ran'),
    )
    expect(sink[0].config.inputSchema).toBe(
      toolParams.updateComponentParamsSchema,
    )
  })

  it('registerSessionTool hands the SDK the schema object itself', () => {
    const sink: Registered[] = []
    registerSessionTool(
      captureServer(sink),
      'record_feedback',
      toolParams.recordFeedbackParamsSchema,
      async () => textResult('ran'),
    )
    expect(sink[0].config.inputSchema).toBe(
      toolParams.recordFeedbackParamsSchema,
    )
  })

  it('registerBufferTool hands the SDK the schema object itself', () => {
    const sink: Registered[] = []
    registerBufferTool(
      captureServer(sink),
      stubClient(),
      new ChangeFeed(),
      'pull_changes',
      toolParams.pullChangesParamsSchema,
      async () => textResult('ran'),
    )
    expect(sink[0].config.inputSchema).toBe(
      toolParams.pullChangesParamsSchema,
    )
  })

  it('so the registered schema still rejects the M22 param that used to vanish', () => {
    const sink: Registered[] = []
    registerFileTool(
      captureServer(sink),
      stubClient(),
      'update_component',
      toolParams.updateComponentParamsSchema,
      async () => textResult('ran'),
    )
    const registered = sink[0].config
      .inputSchema as typeof toolParams.updateComponentParamsSchema
    const result = registered.safeParse({
      fileKey: 'fk',
      componentId: '453:4107',
      remove: ['Show date#453:63'],
    })
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('remove')
  })
})
