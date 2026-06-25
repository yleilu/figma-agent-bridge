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
