// create-node.test.ts — the rebuilt create_node (single NodeSpec write).
//
// create_node sends COMMANDS.CREATE_NODE with { spec, parentId? } where `spec`
// is the NodeSpec converted on the grammar WRITE FACE via specToFigmaForCreate
// (atom leaves parsed; name ?? type fallback). It reports through
// formatMutationResult so a plugin {error} surfaces as an error and warnings
// ride along. Children are OUT OF SCOPE for M2 (single-node) — a spec carrying
// `children` returns a warning pointing at create_tree (M3); the handler does
// NOT recurse.

import { describe, expect, it } from 'bun:test'
import { handleCreateNode } from '@figma-agent-bridge/server/tools/create-node'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'

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
    return (
      opts.reply ?? {
        id: 'created:1',
        name: 'Card',
        type: 'FRAME',
        warnings: [],
      }
    )
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleCreateNode (rebuilt — single NodeSpec)', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateNode(
      { spec: { type: 'FRAME' } },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('sends COMMANDS.CREATE_NODE with {spec, parentId}', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      {
        spec: { type: 'FRAME', name: 'Card' },
        parentId: '1:2',
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe(COMMANDS.CREATE_NODE)
    expect(sent[0].params?.parentId).toBe('1:2')
    expect(sent[0].params?.spec).toBeDefined()
  })

  it('converts atom leaves on the write face (#FF0000 → SOLID paint)', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      {
        spec: {
          type: 'RECTANGLE',
          size: [10, 10],
          fills: ['#FF0000'],
        },
      },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as {
      fills: unknown[]
    }
    expect(spec.fills[0]).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
    })
  })

  it('applies the name ?? type create fallback', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      { spec: { type: 'ELLIPSE' } },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as { name: string }
    expect(spec.name).toBe('ELLIPSE')
  })

  it('warns (M2 single-node) and does NOT recurse when spec.children is present', async () => {
    const sent: Sent[] = []
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          children: [{ type: 'RECTANGLE' }],
        },
      },
      stubClient({ sent }),
    )
    // Server still creates the single parent node…
    expect(sent[0].command).toBe(COMMANDS.CREATE_NODE)
    // …but never forwards children (no recursion in M2).
    const spec = sent[0].params?.spec as Record<
      string,
      unknown
    >
    expect(spec).not.toHaveProperty('children')
    // …and surfaces a warning pointing at create_tree (M3).
    expect(result.content[0].text).toContain('create_tree')
  })

  it('surfaces a per-side stroke collapse warning on success (writer threads it)', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'RECTANGLE',
          stroke: 'stroke([2,0,2,0])',
        },
      },
      stubClient({}),
    )
    // Success path (not an Error) carrying the writer's collapse warning.
    expect(result.content[0].text).not.toStartWith('Error')
    expect(result.content[0].text).toContain(
      'Per-side stroke',
    )
    expect(result.content[0].text).toContain('collapsed')
  })

  it('surfaces a plugin-side {error} as an error (not success)', async () => {
    const result = await handleCreateNode(
      { spec: { type: 'FRAME' } },
      stubClient({
        reply: {
          error:
            'Parent not found or cannot have children: 1:2',
        },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Parent not found',
    )
  })

  it('surfaces plugin warnings on success', async () => {
    const result = await handleCreateNode(
      { spec: { type: 'FRAME' } },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'Card',
          type: 'FRAME',
          warnings: ['some plugin warning'],
        },
      }),
    )
    expect(result.content[0].text).toContain(
      'some plugin warning',
    )
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: FigmaClient = {
      joinChannel: async () => '',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
      disconnect: () => {},
      isConnected: () => true,
      currentChannel: () => 'ch',
    }
    const result = await handleCreateNode(
      { spec: { type: 'FRAME' } },
      client,
    )
    expect(result.content[0].text).toBe(
      'Error: plugin exploded',
    )
  })

  // An unsupported `type` is rejected cleanly at the SERVER boundary with an
  // {error} that lists valid types — NOT forwarded to the plugin where it would
  // throw a deep, generic "Unsupported node type" error.
  it('rejects an unsupported type with a clean validation error before sending', async () => {
    const sent: Sent[] = []
    const result = await handleCreateNode(
      { spec: { type: 'BUTTON' } },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(0)
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('BUTTON')
    // The message self-documents the valid surface.
    expect(result.content[0].text).toContain('FRAME')
  })

  it('still forwards a supported type', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      { spec: { type: 'RECTANGLE' } },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
  })
})
