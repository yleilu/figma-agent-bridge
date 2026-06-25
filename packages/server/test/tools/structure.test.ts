// structure.test.ts — handleDeleteNode / handleSetFocus.
//
// Both are mutation handlers routed through formatMutationResult: a null reply
// → failure text, a {error} reply → an error, otherwise JSON.stringify. Asserts
// on REAL handler output.

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleDeleteNode,
  handleSetFocus,
} from '@figma-agent-bridge/server/tools/structure'

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

describe('handleDeleteNode', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleDeleteNode(
      { nodeId: '1:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.DELETE_NODE with {nodeId}', async () => {
    const sent: Sent[] = []
    await handleDeleteNode(
      { nodeId: '1:42' },
      stubClient({
        sent,
        reply: { id: '1:42', name: 'Card', type: 'FRAME' },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.DELETE_NODE)
    expect(sent[0].params).toEqual({ nodeId: '1:42' })
  })

  it('emits the deleted {id,name,type}', async () => {
    const result = await handleDeleteNode(
      { nodeId: '1:42' },
      stubClient({
        reply: { id: '1:42', name: 'Card', type: 'FRAME' },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      name: string
      type: string
    }
    expect(out).toEqual({
      id: '1:42',
      name: 'Card',
      type: 'FRAME',
    })
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleDeleteNode(
      { nodeId: 'nope' },
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
    const result = await handleDeleteNode(
      { nodeId: '1:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to delete node.',
    )
  })
})

describe('handleSetFocus', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:1'] },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SET_FOCUS with {nodeIds}', async () => {
    const sent: Sent[] = []
    await handleSetFocus(
      { nodeIds: ['1:1', '1:2'] },
      stubClient({
        sent,
        reply: {
          viewport: { center: { x: 0, y: 0 }, zoom: 1 },
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_FOCUS)
    expect(sent[0].params).toEqual({
      nodeIds: ['1:1', '1:2'],
    })
  })

  it('emits the {viewport}', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:1'] },
      stubClient({
        reply: {
          viewport: { center: { x: 5, y: 6 }, zoom: 2 },
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      viewport: {
        center: { x: number; y: number }
        zoom: number
      }
    }
    expect(out.viewport.zoom).toBe(2)
    expect(out.viewport.center).toEqual({ x: 5, y: 6 })
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:1'] },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to set focus.',
    )
  })
})
