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
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  reply?: unknown
  sent?: Sent[]
}): ScopedFigmaClient => ({
  fileKey: 'fk-test',
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
})

describe('handleCreateNode (rebuilt — single NodeSpec)', () => {
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

  it('forwards an INSTANCE component ref by LOCAL id (by-id create path)', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      {
        spec: {
          type: 'INSTANCE',
          component: {
            id: '2:10',
            properties: { Label: 'Save' },
          },
        },
      },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as {
      type: string
      component: unknown
    }
    expect(spec.type).toBe('INSTANCE')
    // The writer passes `component` through verbatim so the plugin can resolve
    // the local main component via getNodeByIdAsync and createInstance().
    expect(spec.component).toEqual({
      id: '2:10',
      properties: { Label: 'Save' },
    })
  })

  it('forwards an INSTANCE component ref by published KEY (by-key create path)', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      {
        spec: {
          type: 'INSTANCE',
          component: { key: 'btn-key-123' },
        },
      },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as {
      component: unknown
    }
    // The plugin imports the published component via importComponentByKeyAsync.
    expect(spec.component).toEqual({ key: 'btn-key-123' })
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

  // B27: the create path sends the FOUR sides through rather than a collapsed
  // top weight. `stroke([0,0,1,0])` is a bottom rule — the commonest divider in
  // table and list design — and collapsing it to the top side made it weight 0,
  // i.e. invisible.
  it('sends per-side stroke weights through on create', async () => {
    const sent: Sent[] = []
    const result = await handleCreateNode(
      {
        spec: {
          type: 'RECTANGLE',
          stroke: 'stroke([0,0,1,0])',
        },
      },
      stubClient({ sent }),
    )
    expect(result.content[0].text).not.toStartWith('Error')
    const spec = sent[0].params?.spec as Record<
      string,
      unknown
    >
    expect(spec.strokeWeights).toEqual([0, 0, 1, 0])
    expect(spec.strokeWeight).toBeUndefined()
  })

  it('surfaces a server-side writer warning on success (writer threads it)', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          layout: { mode: 'V', rows: 2 },
        },
      },
      stubClient({}),
    )
    // Success path (not an Error) carrying the writer's warning.
    expect(result.content[0].text).not.toStartWith('Error')
    expect(result.content[0].text).toContain('GRID-only')
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
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Parent not found')
    expect(data.code).toBe('NODE_NOT_FOUND')
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
    const client: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
    }
    const result = await handleCreateNode(
      { spec: { type: 'FRAME' } },
      client,
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'plugin exploded',
      code: 'PLUGIN_ERROR',
    })
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
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.code).toBe('UNSUPPORTED_NODE_TYPE')
    expect(data.error).toContain('BUTTON')
    // The message self-documents the valid surface.
    expect(data.error).toContain('FRAME')
  })

  // Issue #3: TEXT_PATH (figma.createTextPath) is real but was never specced/wired
  // (vectorNodeId/startSegment/startPosition), so it is honest-rejected at the
  // SERVER boundary just like any unsupported type — never forwarded to the plugin.
  // Deferred to the spec-completeness phase; see docs/deferred-capabilities.md.
  it('rejects TEXT_PATH with a clean validation error before sending (deferred)', async () => {
    const sent: Sent[] = []
    const result = await handleCreateNode(
      { spec: { type: 'TEXT_PATH' } },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(0)
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.code).toBe('UNSUPPORTED_NODE_TYPE')
    expect(data.error).toContain('TEXT_PATH')
    // The message self-documents the valid surface.
    expect(data.error).toContain('FRAME')
  })

  it('still forwards a supported type', async () => {
    const sent: Sent[] = []
    await handleCreateNode(
      { spec: { type: 'RECTANGLE' } },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
  })

  // B45 (live): `vectorPaths:["path(M 12 0 L 24 24 L 0 24 Z)"]` was ACCEPTED —
  // warnings:[], and the created node read back `vectorPaths: []`. An atom
  // that does not parse is INVALID_PARAM, raised before the plugin is
  // contacted (expression-formats.md).
  it('rejects a fill-rule-less path atom before the plugin is contacted', async () => {
    const sent: Sent[] = []
    const result = await handleCreateNode(
      {
        spec: {
          type: 'VECTOR',
          vectorPaths: ['path(M 12 0 L 24 24 L 0 24 Z)'],
        },
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(0)
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.code).toBe('INVALID_PARAM')
    expect(data.error).toContain(
      'path(NONZERO,"M 0 0 L 24 24")',
    )
  })
})
