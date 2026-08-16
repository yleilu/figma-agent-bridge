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
import YAML from 'yaml'
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
import { handleGetNode } from '@figma-agent-bridge/server/tools/read'
import { handleCloneNode } from '@figma-agent-bridge/server/tools/structure'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import { handleBindVariable } from '@figma-agent-bridge/server/tools/design-system'
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

  // --- B41: reading back what a create into a SLOT handed you ---
  //
  // Figma does not re-home a node appended into a slot, so `create_node`
  // answers the PRE-APPEND id while the file addresses the node by its
  // canonical instance chain. The plugin's enrichment now pairs the live
  // subtree with the export instead of joining them by id, so the wrappers
  // reach the descendants either way; these pin the SERVER half of that
  // contract — a read whose root id is not the id it asked for is a normal
  // read, and the descendant's wrapper survives to the projection.

  it('create into a slot answers an ALIAS id, and the read resolves it canonically', async () => {
    const created = await handleCreateNode(
      {
        spec: { type: 'FRAME', name: 'Chip' },
        parentId: 'slotparent:I298:7517;298:7516',
      },
      scoped,
    )
    const madeId = (
      JSON.parse(created.content[0].text) as {
        id: string
      }
    ).id
    expect(madeId).toBe('slot-alias:1')

    const read = await handleGetNode(
      { nodeId: madeId, depth: 1 },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as Record<
      string,
      unknown
    >
    // The read answers the id the FILE uses, not the one it was handed.
    expect(spec.id).toBe('I298:7517;298:7516;298:7523')
    expect(spec.readErrors).toBeUndefined()
  })

  it('the slot descendant keeps its var() wrapper (B41)', async () => {
    const read = await handleGetNode(
      { nodeId: 'slot-alias:1', depth: 1 },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as {
      children: { fills: string[] }[]
    }
    // The literal was never wrong; the NAME is what used to vanish.
    expect(spec.children[0].fills[0]).toMatch(
      /^var\(probe\/cyan\)/,
    )
  })

  it('control: the CLONE of that content reads identically', async () => {
    const cloned = await handleCloneNode(
      { nodeId: 'slot-alias:1' },
      scoped,
    )
    const cloneId = (
      JSON.parse(cloned.content[0].text) as {
        id: string
      }[]
    )[0].id
    expect(cloneId).toBe('I298:7517;298:7516;298:7530')

    const read = await handleGetNode(
      { nodeId: cloneId, depth: 1 },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as {
      children: { fills: string[] }[]
    }
    expect(spec.children[0].fills[0]).toMatch(
      /^var\(probe\/cyan\)/,
    )
  })

  // --- WRITING to an instance sublayer, by the compound id a read gave you ---
  //
  // `I<instance>;<child>` is what every read hands back for a node under an
  // instance, so it is what a write gets called with. The plugin resolved it
  // with a bare `getNodeByIdAsync`, which reaches for Figma's network: live
  // 2026-08-17 the same `update_node` on `I298:7524;298:7511` failed with
  // "Unable to establish connection to Figma after 10 seconds" and then
  // succeeded on retry. Intermittent is the worst answer under apply-or-warn —
  // the caller cannot tell a refused write from an unreached node.
  //
  // Headless, these pin the contract either side of the plugin: the compound id
  // survives the whole server path unmangled, and the answer is the SAME every
  // time. The plugin's own traversal needs the live battery.

  const SUBLAYER = 'I1:42;1:7'

  it('update_node applies to a sublayer addressed by its compound id', async () => {
    // Called twice, because the defect was a coin flip: the second call has to
    // answer exactly what the first did.
    const answers: string[] = []
    for (let i = 0; i < 2; i++) {
      const result = await handleUpdateNode(
        { nodeId: SUBLAYER, patch: { fills: ['#FF0000'] } },
        scoped,
      )
      answers.push(result.content[0].text)
    }
    expect(new Set(answers).size).toBe(1)
    const reply = JSON.parse(answers[0]) as Record<
      string,
      unknown
    >
    expect(reply.error).toBeUndefined()
    expect(reply.code).toBeUndefined()
    // The patch reached the plugin as a converted spec — same as a plain id.
    expect(
      (
        reply.spec as {
          fills: { type: string; color: unknown }[]
        }
      ).fills[0],
    ).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
    })
  })

  it('bind_variable reaches the same sublayer', async () => {
    const result = await handleBindVariable(
      {
        nodeId: SUBLAYER,
        variableId: 'VariableID:1:1',
        field: 'fills',
      },
      scoped,
    )
    expect(result.content[0].text).not.toContain(
      'Node not found',
    )
    expect(result.content[0].text).not.toContain(
      'internet connection',
    )
  })

  it('a compound id that names nothing is a clean, repeatable refusal', async () => {
    // Not "sometimes a connection error": a write to an id the document does
    // not hold must say so, the same way, every time.
    const answers = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const result = await handleUpdateNode(
        {
          nodeId: 'I9:99;9:9',
          patch: { fills: ['#FF0000'] },
        },
        scoped,
      )
      answers.add(result.content[0].text)
    }
    expect(answers.size).toBe(1)
    const [only] = [...answers]
    expect(only).toContain('Node not found')
    expect(only).not.toContain('internet connection')
  })
})
