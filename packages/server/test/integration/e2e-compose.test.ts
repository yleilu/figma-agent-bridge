// e2e-compose.test.ts — M3 chunk A composable-construction tools over the REAL
// relay with the mock plugin (headless, CI). Same startRelay + createMockPlugin
// + createFigmaClient pattern as the other integration suites, so no Figma is
// needed. Asserts on the mock echo of the CONVERTED params (Figma objects, not
// atom strings) — the headless proof the server parsed and the plugin assigned.
//
// Covers:
//   - create_tree round-trip: nested children + a { ref } reuse + an { id }
//     clone (the converted nested structure reached the plugin, refs resolved).
//   - boolean_op → BooleanOperationNode.
//   - reorder_children set-mismatch warn (T7).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { handleCreateTree } from '@figma-agent-bridge/server/tools/create-tree'
import {
  handleCloneNode,
  handleReparentNode,
  handleReorderChildren,
  handleBooleanOp,
  handleFlatten,
} from '@figma-agent-bridge/server/tools/structure'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3103
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-compose-test'
const FK = 'fk-compose'

describe('M3 compose tools e2e (mock plugin over real relay)', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let scoped: ScopedFigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Compose Doc',
      pageName: 'Main',
      fileKey: FK,
    })
    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
    scoped = client.forFile(FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('create_tree round-trips nested children + { ref } reuse + { id } clone', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        tree: {
          type: 'FRAME',
          name: 'Toolbar',
          size: [400, 60],
          layout: {
            mode: 'H',
            gap: 8,
            pad: [8, 8, 8, 8],
          },
          fills: ['#FFFFFF'],
          children: [
            // a nested full child
            {
              type: 'TEXT',
              name: 'Label',
              size: [80, 24],
              text: {
                content: 'File',
                font: 'font(Inter,Regular,14)',
                color: '#111111',
              },
            },
            // ref-pool reuse (used twice → re-built fresh each time)
            { ref: 'btn' },
            { ref: 'btn' },
            // clone an existing node by id
            { id: '9:99' },
          ],
        },
        refs: {
          btn: {
            type: 'RECTANGLE',
            name: 'Button',
            size: [40, 40],
            fills: ['#3B82F6'],
            radius: '8',
          },
        },
      },
      scoped,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>

    // The root FRAME reached the plugin with its converted leaves.
    expect(data.root).toEqual({
      id: (data.ids as string[])[0],
      name: 'Toolbar',
      type: 'FRAME',
    })
    const fills = data.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID') // atom parsed server-side

    // The nested children survived the hop in order: full TEXT, two { ref }
    // markers, one { id } clone marker.
    const children = data.children as Record<
      string,
      unknown
    >[]
    expect(children).toHaveLength(4)
    expect(children[0].type).toBe('TEXT')
    // text atom parsed to a font object, not left as a string.
    const text = children[0].text as {
      font: { family: string }
    }
    expect(text.font.family).toBe('Inter')
    expect(children[1]).toEqual({ ref: 'btn' })
    expect(children[2]).toEqual({ ref: 'btn' })
    expect(children[3]).toEqual({ id: '9:99' })

    // The ref-pool was converted and forwarded (atom → Figma object) and
    // resolved by the plugin so the realized total counts both reuses + clone.
    const refs = data.refs as {
      btn: { type: string; fills: { type: string }[] }
    }
    expect(refs.btn.type).toBe('RECTANGLE')
    expect(refs.btn.fills[0].type).toBe('SOLID')
    // realized nodes: Toolbar + Label + (btn ×2) + clone = 5.
    expect(data.totalNodes).toBe(5)
  })

  it('create_tree rejects a cyclic { ref } pool with a clean {error} (no hang)', async () => {
    // refs.a → { ref: b }, refs.b → { ref: a }: resolving the tree would recurse
    // forever. The cycle guard must surface a clean create_tree {error}
    // ('Cyclic ref in pool: …'), never freeze (a hang here fails the test by
    // timeout, proving the guard works).
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        tree: {
          type: 'FRAME',
          name: 'Root',
          children: [{ ref: 'a' }],
        },
        refs: {
          a: { ref: 'b' },
          b: { ref: 'a' },
        },
      },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Cyclic ref in pool',
    )
  })

  it('create_tree rejects a self-referential { ref } pool with a clean {error}', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        tree: {
          type: 'FRAME',
          name: 'Root',
          children: [{ ref: 'loop' }],
        },
        refs: {
          loop: { ref: 'loop' },
        },
      },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Cyclic ref in pool',
    )
  })

  it('boolean_op combines nodes into a BooleanOperationNode', async () => {
    const result = await handleBooleanOp(
      { op: 'UNION', nodeIds: ['1:1', '1:2'] },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('BOOLEAN_OPERATION')
    expect(data.id).toBeDefined()
  })

  it('boolean_op surfaces an error when fewer than 2 nodes resolve', async () => {
    const result = await handleBooleanOp(
      { op: 'UNION', nodeIds: ['1:1'] },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('at least 2')
  })

  it('flatten produces a single VECTOR', async () => {
    const result = await handleFlatten(
      { nodeIds: ['1:1', '1:2'] },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('VECTOR')
  })

  it('clone_node returns one entry per clone (count)', async () => {
    const result = await handleCloneNode(
      { nodeId: '1:42', count: 3 },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as unknown[]
    expect(data).toHaveLength(3)
  })

  // An out-of-range index returns a clean, actionable {error} (parent has 3
  // children → valid 0..3), NOT a raw RangeError string from insertChild.
  it('clone_node surfaces a clean {error} for an out-of-range index', async () => {
    const result = await handleCloneNode(
      { nodeId: '1:42', parentId: '1:9', index: 99 },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('out of range')
    // The actionable bound is named, not a bare RangeError.
    expect(result.content[0].text).not.toContain(
      'RangeError',
    )
  })

  it('reparent_node echoes {id,…,parentId}', async () => {
    const result = await handleReparentNode(
      { nodeId: '1:42', parentId: '1:9' },
      scoped,
    )
    const data = JSON.parse(result.content[0].text) as {
      parentId: string
    }
    expect(data.parentId).toBe('1:9')
  })

  it('reorder_children warns on a set mismatch (T7), not an error', async () => {
    // The mock parent's child set is ['1:1','1:2','1:3']; this requests a ghost
    // id and omits 1:2 → a set mismatch → a warning, success not error.
    const result = await handleReorderChildren(
      { parentId: 'p:1', nodeIds: ['1:3', '1:1', 'ghost'] },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(result.content[0].text) as {
      parentId: string
      order: string[]
      warnings: string[]
    }
    expect(data.warnings).toHaveLength(1)
    expect(data.warnings[0]).toContain('id set differs')
    // The real plugin returns the FULL post-reorder child list: the requested
    // ids that are children (in order), then the omitted child (1:2) after.
    expect(data.order).toEqual(['1:3', '1:1', '1:2'])
  })

  it('reorder_children succeeds with no warning on an exact set', async () => {
    const result = await handleReorderChildren(
      { parentId: 'p:1', nodeIds: ['1:3', '1:2', '1:1'] },
      scoped,
    )
    const data = JSON.parse(result.content[0].text) as {
      order: string[]
      warnings: string[]
    }
    expect(data.warnings).toEqual([])
    expect(data.order).toEqual(['1:3', '1:2', '1:1'])
  })
})
