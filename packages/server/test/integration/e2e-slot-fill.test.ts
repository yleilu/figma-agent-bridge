// e2e-slot-fill.test.ts — M2b: create_node / create_tree with parentId targeting
// an instance's SLOT node must return a CLEAR STRUCTURED error when appendChild
// is blocked by Figma's instance-lock (T7), instead of propagating a raw runtime
// exception. The mock cannot reproduce the real instance-lock, so this suite:
//   1. Uses `badparent:` parentId prefix to model a parent whose appendChild
//      throws (the mock mirrors the real plugin's T7 wrap contract).
//   2. Asserts the reply carries the CLEAR STRUCTURED error (not a throw).
//   3. Asserts a normal parent still works (no regression).
//   4. Asserts there is NO blanket instance-type rejection (a SLOT-descendant
//      parentId NOT prefixed `badparent:` must succeed, confirming the T9
//      composition path stays open).

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
import { handleCreateNode } from '@figma-agent-bridge/server/tools/create-node'
import { handleCreateTree } from '@figma-agent-bridge/server/tools/create-tree'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3132
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-slot-fill-test'
const FK = 'fk-slot-fill'

describe('M2b slot-fill e2e (T7 instance-lock wrap)', () => {
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
      documentName: 'Slot Fill Doc',
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

  // --- create_node ---

  it('create_node: un-appendable parent (badparent:) returns clear structured error, not a throw', async () => {
    const result = await handleCreateNode(
      {
        spec: { type: 'FRAME', name: 'Content' },
        parentId: 'badparent:I123;456',
      },
      scoped,
    )
    const { text } = result.content[0]
    // formatMutationResult wraps plugin result.error as the typed envelope.
    const data = JSON.parse(text) as {
      error: string
      code: string
    }
    // The error message must mention the slot / SLOT / parent type (T7 honesty)
    expect(data.error).toMatch(
      /Cannot append into this parent|only a component SLOT|To fill a slot/,
    )
    expect(data.code).toBe('PLUGIN_ERROR')
  })

  it('create_node: normal appendable parent still works (no regression)', async () => {
    const result = await handleCreateNode(
      {
        spec: { type: 'FRAME', name: 'Card' },
        parentId: 'page:1',
      },
      scoped,
    )
    const { text } = result.content[0]
    const data = JSON.parse(text) as Record<string, unknown>
    expect(data.error).toBeUndefined()
    expect(data.type).toBe('FRAME')
    expect(data.name).toBe('Card')
  })

  it('create_node: instance-parent WITHOUT badparent prefix is NOT blanket-rejected (T9 slot path stays open)', async () => {
    // A parentId that looks like an instance compound id but is NOT prefixed
    // `badparent:` must succeed — the guard is append-time only, not type-based.
    // This models the real SLOT child of an instance (the sanctioned path).
    const result = await handleCreateNode(
      {
        spec: { type: 'RECTANGLE', name: 'Slot Content' },
        parentId: 'I123;slot:456',
      },
      scoped,
    )
    const { text } = result.content[0]
    // Assert the SUCCESS, not the absence of a prose prefix: since the typed
    // envelope landed, every error is JSON starting with `{`, so a
    // `not.toMatch(/^Error:/)` here could never fail and guarded nothing.
    const data = JSON.parse(text) as Record<string, unknown>
    expect(data.error).toBeUndefined()
    expect(data.code).toBeUndefined()
    expect(data.name).toBe('Slot Content')
    expect(data.parentId).toBe('I123;slot:456')
  })

  // --- create_tree ---

  it('create_tree: un-appendable parent (badparent:) returns clear structured error, not a throw', async () => {
    const result = await handleCreateTree(
      {
        tree: { type: 'FRAME', name: 'Content' },
        parentId: 'badparent:I123;456',
      },
      scoped,
    )
    const { text } = result.content[0]
    const data = JSON.parse(text) as {
      error: string
      code: string
    }
    expect(data.error).toMatch(
      /Cannot append into this parent|only a component SLOT|To fill a slot/,
    )
    expect(data.code).toBe('PLUGIN_ERROR')
  })

  it('create_tree: normal appendable parent still works (no regression)', async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'Container',
          children: [{ type: 'TEXT', name: 'Label' }],
        },
        parentId: 'page:1',
      },
      scoped,
    )
    const { text } = result.content[0]
    const data = JSON.parse(text) as Record<string, unknown>
    expect(data.error).toBeUndefined()
    expect((data.root as { type: string }).type).toBe(
      'FRAME',
    )
    // Container + Label — every created node is addressable.
    expect(data.ids).toHaveLength(2)
  })

  it('create_tree: instance-parent WITHOUT badparent prefix is NOT blanket-rejected (T9 slot path stays open)', async () => {
    const result = await handleCreateTree(
      {
        tree: { type: 'FRAME', name: 'Slot Content' },
        parentId: 'I123;slot:456',
      },
      scoped,
    )
    const { text } = result.content[0]
    // Same as the create_node slot case: assert the success shape, because a
    // `^Error:` pattern can no longer match a JSON envelope.
    const data = JSON.parse(text) as Record<string, unknown>
    expect(data.error).toBeUndefined()
    expect(data.code).toBeUndefined()
    expect((data.root as { name: string }).name).toBe(
      'Slot Content',
    )
    expect(data.ids).toHaveLength(1)
  })
})
