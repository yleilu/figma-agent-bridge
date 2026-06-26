// metadata.test.ts — handleGetReactions / handleGetPluginData / handleGetAnnotations.
//
// These reads are degrade-aware (T7): the plugin returns a {warnings:[...]}
// degrade rather than throwing when an API is unavailable / a node is missing,
// and the server surfaces the warning, never throwing. Asserts on REAL output.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleGetReactions,
  handleGetPluginData,
  handleGetAnnotations,
  handleSetPluginData,
  handleSetReactions,
  handleSetAnnotations,
} from '@figma-agent-bridge/server/tools/metadata'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  connected?: boolean
  reply?: unknown
  sent?: Sent[]
}): FigmaClient => ({
  joinChannel: async () => 'ch',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleGetReactions', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleGetReactions(
      { nodeId: '1:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.GET_REACTIONS and emits results', async () => {
    const sent: Sent[] = []
    const result = await handleGetReactions(
      { nodeId: '1:42' },
      stubClient({
        sent,
        reply: {
          nodeId: '1:42',
          reactions: [
            {
              trigger: { type: 'ON_CLICK' },
              actions: [{ type: 'NODE' }],
            },
          ],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_REACTIONS)
    expect(sent[0].params).toEqual({ nodeId: '1:42' })
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results).toHaveLength(1)
  })

  it('surfaces a degrade warning without throwing', async () => {
    const result = await handleGetReactions(
      { nodeId: 'bad' },
      stubClient({
        reply: {
          nodeId: 'bad',
          reactions: [],
          warnings: ['Node not found: bad'],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      warnings?: string[]
    }
    expect(out.results).toHaveLength(0)
    expect(out.warnings).toContain('Node not found: bad')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleGetReactions(
      { nodeId: '1:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to get reactions from plugin.',
    )
  })
})

describe('handleGetPluginData', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleGetPluginData(
      { nodeId: '1:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards with namespace → sharedPluginData present', async () => {
    const sent: Sent[] = []
    const result = await handleGetPluginData(
      { nodeId: '1:42', namespace: 'ns' },
      stubClient({
        sent,
        reply: {
          nodeId: '1:42',
          pluginData: { foo: 'bar' },
          sharedPluginData: { baz: 'qux' },
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_PLUGIN_DATA)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      namespace: 'ns',
    })
    const out = YAML.parse(result.content[0].text) as {
      pluginData: Record<string, string>
      sharedPluginData?: Record<string, string>
    }
    expect(out.pluginData).toEqual({ foo: 'bar' })
    expect(out.sharedPluginData).toEqual({ baz: 'qux' })
  })

  it('without namespace → only pluginData', async () => {
    const result = await handleGetPluginData(
      { nodeId: '1:42' },
      stubClient({
        reply: {
          nodeId: '1:42',
          pluginData: { foo: 'bar' },
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      pluginData: Record<string, string>
      sharedPluginData?: Record<string, string>
    }
    expect(out.pluginData).toEqual({ foo: 'bar' })
    expect(out.sharedPluginData).toBeUndefined()
  })

  it('forwards a node-not-found degrade (empty pluginData + warning), never throwing', async () => {
    const result = await handleGetPluginData(
      { nodeId: 'nope' },
      stubClient({
        reply: {
          nodeId: 'nope',
          pluginData: {},
          warnings: ['Node not found: nope'],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      pluginData: Record<string, string>
      warnings?: string[]
    }
    expect(result.content[0].text).not.toContain('Error')
    expect(out.pluginData).toEqual({})
    expect(out.warnings).toContain('Node not found: nope')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleGetPluginData(
      { nodeId: '1:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to get plugin data from plugin.',
    )
  })
})

describe('handleGetAnnotations', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleGetAnnotations(
      {},
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.GET_ANNOTATIONS and emits Rule-A results', async () => {
    const sent: Sent[] = []
    const result = await handleGetAnnotations(
      { nodeId: '1:42' },
      stubClient({
        sent,
        reply: {
          results: [
            { label: 'Check spacing', categoryId: 'cat:1' },
          ],
          truncated: false,
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_ANNOTATIONS)
    const out = YAML.parse(result.content[0].text) as {
      results: { label: string }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results[0].label).toBe('Check spacing')
  })

  it('surfaces a degrade warning + empty results, never throwing', async () => {
    const result = await handleGetAnnotations(
      {},
      stubClient({
        reply: {
          results: [],
          truncated: false,
          warnings: [
            'Annotations API unavailable in this editor; returning empty.',
          ],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      warnings?: string[]
    }
    expect(out.results).toHaveLength(0)
    expect(out.warnings).toContain(
      'Annotations API unavailable in this editor; returning empty.',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleGetAnnotations(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to get annotations from plugin.',
    )
  })
})

// ─── set_plugin_data (twin of get_plugin_data) ────────────────────────────────

describe('handleSetPluginData', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSetPluginData(
      { nodeId: '1:1', key: 'k', value: 'v' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SET_PLUGIN_DATA with key/value (+namespace) and emits {id}', async () => {
    const sent: Sent[] = []
    const result = await handleSetPluginData(
      {
        nodeId: '1:42',
        key: 'k',
        value: 'v',
        namespace: 'ns',
      },
      stubClient({ sent, reply: { id: '1:42' } }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_PLUGIN_DATA)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      key: 'k',
      value: 'v',
      namespace: 'ns',
    })
    const out = JSON.parse(result.content[0].text) as {
      id: string
    }
    expect(out.id).toBe('1:42')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleSetPluginData(
      { nodeId: 'nope', key: 'k', value: 'v' },
      stubClient({
        reply: { error: 'Node not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Node not found',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleSetPluginData(
      { nodeId: '1:1', key: 'k', value: 'v' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to set plugin data.',
    )
  })
})

// ─── set_reactions (T7; twin of get_reactions) ────────────────────────────────

describe('handleSetReactions', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSetReactions(
      { nodeId: '1:1', reactions: [] },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SET_REACTIONS and emits {id,warnings}', async () => {
    const sent: Sent[] = []
    const reactions = [
      { trigger: { type: 'ON_CLICK' }, actions: [] },
    ]
    const result = await handleSetReactions(
      { nodeId: '1:42', reactions },
      stubClient({
        sent,
        reply: { id: '1:42', warnings: [] },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_REACTIONS)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      reactions,
    })
    const out = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(out.id).toBe('1:42')
    expect(out.warnings).toEqual([])
  })

  it('T7 degrade: surfaces {warnings} as success, NEVER an error', async () => {
    const result = await handleSetReactions(
      { nodeId: '1:42', reactions: [] },
      stubClient({
        reply: {
          id: '1:42',
          warnings: [
            'setReactionsAsync unavailable in this Figma version; reactions not set',
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(out.warnings).toHaveLength(1)
    expect(result.content[0].text).not.toContain('Error:')
  })

  it('surfaces a plugin-side {error} (node-not-found) as an error', async () => {
    const result = await handleSetReactions(
      { nodeId: 'nope', reactions: [] },
      stubClient({
        reply: { error: 'Node not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleSetReactions(
      { nodeId: '1:1', reactions: [] },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to set reactions.',
    )
  })
})

// ─── set_annotations (T7 editorType-gated; twin of get_annotations) ───────────

describe('handleSetAnnotations', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSetAnnotations(
      { nodeId: '1:1', annotations: [] },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SET_ANNOTATIONS and emits {id,warnings}', async () => {
    const sent: Sent[] = []
    const annotations = [{ label: 'Check spacing' }]
    const result = await handleSetAnnotations(
      { nodeId: '1:42', annotations },
      stubClient({
        sent,
        reply: { id: '1:42', warnings: [] },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_ANNOTATIONS)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      annotations,
    })
    const out = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(out.id).toBe('1:42')
  })

  it('T7 degrade: surfaces {warnings} as success, NEVER an error', async () => {
    const result = await handleSetAnnotations(
      { nodeId: '1:42', annotations: [] },
      stubClient({
        reply: {
          id: '1:42',
          warnings: [
            'Annotations API unavailable in this editor; annotations not set',
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(out.warnings).toHaveLength(1)
    expect(result.content[0].text).not.toContain('Error:')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleSetAnnotations(
      { nodeId: '1:1', annotations: [] },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to set annotations.',
    )
  })
})
