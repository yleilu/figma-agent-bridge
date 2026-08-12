// e2e-wrapper-bind.test.ts — an inline var()/style() wrapper binds on write (I39).
//
// End to end over the relay: the wrapper's NAME survives the write converter,
// reaches the plugin inside the converted payload, and is applied there after
// the literal — on create AND on update. An unresolvable name degrades to the
// literal plus one warning; the write still succeeds.
//
// The round-trip case is the point of the whole change: what `get_node` emits
// (`var(surface/card-bg)#FFFFFF`) is written straight back and re-binds, so a
// read-modify-write no longer silently flattens a token to a literal.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import YAML from 'yaml'
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
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import { handleGetNode } from '@figma-agent-bridge/server/tools/read'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3134
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-wrapper-bind'
const FK = 'fk-wrapper-bind'

type Binding = {
  kind: string
  name: string
  field: string
  index?: number
}

type Reply = {
  warnings?: string[]
  appliedBindings?: Binding[]
  spec?: { bindings?: Binding[] }
  bindings?: Binding[]
}

const reply = (text: string): Reply =>
  JSON.parse(text.split('\n\nWarning:')[0]) as Reply

describe('inline wrapper bindings e2e (I39)', () => {
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

  // ── create ────────────────────────────────────────────────────────────────

  it('create_node: a var() fill lands the paint AND binds the token by name', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          name: 'Card',
          fills: ['var(Brand/Primary)#FF00AA'],
        },
      },
      scoped,
    )
    const data = reply(result.content[0].text)
    // the binding intent crossed the wire with the NAME intact…
    expect(data.bindings).toEqual([
      {
        kind: 'var',
        name: 'Brand/Primary',
        field: 'fills',
        index: 0,
      },
    ])
    // …and the plugin applied it, with nothing to warn about
    expect(data.appliedBindings).toEqual([
      {
        kind: 'var',
        name: 'Brand/Primary',
        field: 'fills',
        index: 0,
      },
    ])
    expect(data.warnings).toEqual([])
  })

  it('create_node: a style() font binds the text style on the same write', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'TEXT',
          name: 'Title',
          text: {
            content: 'Monthly report',
            font: 'style(Heading)font(Inter,Bold,32)',
          },
        },
      },
      scoped,
    )
    const data = reply(result.content[0].text)
    expect(data.appliedBindings).toEqual([
      { kind: 'style', name: 'Heading', field: 'text' },
    ])
    expect(data.warnings).toEqual([])
  })

  it('create_node: an unresolvable name degrades — the literal lands, one warning, no error', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          fills: ['var(ghost/token)#141B2E'],
        },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).not.toContain('"error"')
    const data = reply(text)
    // the intent still crossed the wire — the plugin, not the server, is what
    // could not resolve it
    expect(data.bindings).toEqual([
      {
        kind: 'var',
        name: 'ghost/token',
        field: 'fills',
        index: 0,
      },
    ])
    expect(data.appliedBindings).toEqual([])
    expect(data.warnings).toEqual([
      'var(ghost/token): no variable with that name — literal applied unbound',
    ])
  })

  it('create_tree: a wrapper on a CHILD reaches the plugin and BINDS there', async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'Card',
          children: [
            {
              type: 'RECTANGLE',
              name: 'Swatch',
              fills: ['var(Brand/Primary)#FF00AA'],
            },
          ],
        },
      },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as unknown as {
      children?: { bindings?: Binding[] }[]
      appliedBindings?: Binding[]
    }
    // the child's intent crossed the wire…
    expect(data.children?.[0].bindings).toEqual([
      {
        kind: 'var',
        name: 'Brand/Primary',
        field: 'fills',
        index: 0,
      },
    ])
    // …and the tree builder applied it on that child, not just the root
    expect(data.appliedBindings).toEqual([
      {
        kind: 'var',
        name: 'Brand/Primary',
        field: 'fills',
        index: 0,
      },
    ])
  })

  it("create_tree: a CHILD's unresolvable name degrades in the root's warnings", async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          children: [
            {
              type: 'RECTANGLE',
              fills: ['var(ghost/token)#FF00AA'],
            },
          ],
        },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).not.toContain('"error"')
    expect(text).toContain(
      'var(ghost/token): no variable with that name — literal applied unbound',
    )
  })

  // ── update ────────────────────────────────────────────────────────────────

  it('update_node: a style() fill applies the style after the literal', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { fills: ['style(Brand/Primary)#3B82F6'] },
      },
      scoped,
    )
    const data = reply(result.content[0].text)
    expect(data.spec?.bindings).toEqual([
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
      },
    ])
    expect(data.appliedBindings).toEqual([
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
      },
    ])
    expect(data.warnings).toEqual([])
  })

  it('update_node: an unresolvable style name degrades with a warning, not an error', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { fills: ['style(Ghost/Style)#3B82F6'] },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).not.toContain('"error"')
    const data = reply(text)
    expect(data.appliedBindings).toEqual([])
    expect(data.warnings).toEqual([
      'style(Ghost/Style): no paint style with that name — literal applied unbound',
    ])
  })

  it('update_node: a per-corner radius keeps its four corners and never binds', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { radius: 'var(radius/medium)[8,8,0,0]' },
      },
      scoped,
    )
    const data = reply(result.content[0].text)
    expect(
      (data.spec as { radius?: unknown })?.radius,
    ).toEqual([8, 8, 0, 0])
    expect(data.spec?.bindings).toBeUndefined()
    expect(data.appliedBindings).toEqual([])
    expect(data.warnings).toContain(
      'var(radius/medium) on a per-corner radius: a single binding cannot express per-corner values — literal applied unbound',
    )
  })

  it('update_node: a wrapper on a field with no binding route warns from the server', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          effects: [
            'var(shadow/lg)shadow(0,4,12,#0000001A)',
          ],
        },
      },
      scoped,
    )
    const data = reply(result.content[0].text)
    expect(data.spec?.bindings).toBeUndefined()
    expect(data.warnings).toContain(
      'var(shadow/lg) on effects: this surface has no binding route for that field — literal applied unbound',
    )
  })

  // ── round-trip ────────────────────────────────────────────────────────────

  it('what a read emits, a write re-binds — the wrapper round-trips', async () => {
    const read = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as {
      fills: string[]
    }
    // the read surfaced the binding as a NAME on the leaf
    expect(spec.fills[0]).toBe(
      'var(surface/card-bg)#FFFFFF',
    )

    // …and writing that exact atom back re-establishes it
    const written = await handleUpdateNode(
      { nodeId: '1:42', patch: { fills: spec.fills } },
      scoped,
    )
    const data = reply(written.content[0].text)
    expect(data.appliedBindings).toEqual([
      {
        kind: 'var',
        name: 'surface/card-bg',
        field: 'fills',
        index: 0,
      },
    ])
    expect(data.warnings).toEqual([])
  })
})
