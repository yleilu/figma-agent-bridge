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
import { handleBindVariable } from '@figma-agent-bridge/server/tools/design-system'
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

  // B47 — the reference and the wrapper-on-a-literal part company exactly
  // here. A styled ARRAY field IS the reference, so a name that resolves to
  // nothing leaves nothing to write and is rejected before the plugin is asked;
  // a scalar slot still carries its literal, so it degrades as it always has.
  it('update_node: an unresolvable style on a styled ARRAY field is rejected, never written', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { fills: ['style(Ghost/Style)#3B82F6'] },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(JSON.parse(text)).toEqual({
      error:
        'style(Ghost/Style) matches no paint style in this file, and a reference has no literal half to fall back on — check the name, create the style, or write the fills as literals',
      code: 'INVALID_PARAM',
    })
  })

  it('update_node: an unresolvable style on the SCALAR text.color slot still degrades with a warning', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          text: {
            content: 'Hi',
            color: 'style(Ghost/Style)#3B82F6',
          },
        },
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

  // ── B44: the layout spacing scalars round-trip the same way ────────────────
  //
  // The bind was REAL and the read denied it: `bind_variable
  // {field:'itemSpacing'}` answered `ok, warnings:[]` — byte-identical to a
  // no-op — the gap moved to the variable's value, `search
  // match:{variableId}` indexed the node, and `get_node` still said `gap: 8`.
  // So the token was unauditable and the next read-modify-write destroyed it.
  describe('a bound layout scalar (B44)', () => {
    type LayoutRead = {
      layout: {
        mode: string
        gap?: number | string
        pad?: (number | string)[]
      }
    }
    const readLayout = async (): Promise<LayoutRead> => {
      const read = await handleGetNode(
        { nodeId: '1:42', profile: 'layout' },
        scoped,
      )
      return YAML.parse(read.content[0].text) as LayoutRead
    }

    it('bind_variable on itemSpacing becomes a var() the read can SEE', async () => {
      const before = await readLayout()
      expect(before.layout.gap).toBe(12)

      await handleBindVariable(
        {
          nodeId: '1:42',
          field: 'itemSpacing',
          variableId: 'var:spacing-8',
        },
        scoped,
      )

      const after = await readLayout()
      expect(after.layout.gap).toBe('var(space/8)12')
    })

    it('writing the read emission back verbatim keeps the binding', async () => {
      await handleBindVariable(
        {
          nodeId: '1:42',
          field: 'itemSpacing',
          variableId: 'var:spacing-8',
        },
        scoped,
      )
      const emitted = await readLayout()

      // The whole struct, exactly as it was read — no editing.
      const written = await handleUpdateNode(
        {
          nodeId: '1:42',
          patch: { layout: emitted.layout },
        },
        scoped,
      )
      const data = reply(written.content[0].text)
      expect(data.warnings).toEqual([])
      expect(data.appliedBindings).toContainEqual({
        kind: 'var',
        name: 'space/8',
        field: 'itemSpacing',
      })

      // …and the next read says the same thing the first one did.
      const again = await readLayout()
      expect(again.layout).toEqual(emitted.layout)
    })

    it('binds pad per SIDE and leaves the others literal', async () => {
      const written = await handleUpdateNode(
        {
          nodeId: '1:42',
          patch: {
            layout: {
              mode: 'V',
              pad: [
                'var(space/8)8',
                16,
                'var(space/8)8',
                16,
              ],
            },
          },
        },
        scoped,
      )
      expect(
        reply(written.content[0].text).warnings,
      ).toEqual([])

      const after = await readLayout()
      expect(after.layout.pad).toEqual([
        'var(space/8)8',
        16,
        'var(space/8)8',
        16,
      ])
    })

    it('an unresolvable spacing token degrades — the gap lands, one warning', async () => {
      const written = await handleUpdateNode(
        {
          nodeId: '1:42',
          patch: {
            layout: { mode: 'H', gap: 'var(space/nope)24' },
          },
        },
        scoped,
      )
      const data = reply(written.content[0].text)
      expect(data.warnings).toEqual([
        'var(space/nope): no variable with that name — literal applied unbound',
      ])
      const after = await readLayout()
      expect(after.layout.gap).toBe(24)
    })
  })

  // ─── B58: taking the token back off ────────────────────────────────────────
  //
  // Writing a literal over a bound field does NOT unbind it — proven live, a
  // token-bound gap given `{gap: 16}` still read back `var(space/16)16`. That
  // made the SPACE_BETWEEN guard's advice a circle: it told callers to write a
  // literal gap, the binding survived, and the guard refused again. `clear` is
  // the door that was missing.
  //
  // FIDELITY BOUNDARY: the mock models the binding as state and the reader
  // renders it, so this proves the SERVER round trip — the flag reaches the
  // plugin and an unbound read comes back unbound. That `setBoundVariable(f,
  // null)` really clears it in Figma is live-only.
  it('bind_variable clear: true takes a layout token off, and the read shows it gone', async () => {
    const bound = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          layout: { mode: 'V', gap: 'var(space/8)8' },
        },
      },
      scoped,
    )
    expect(bound.content[0].text).not.toContain('Error:')

    const withToken = await handleGetNode(
      { nodeId: '1:42' },
      scoped,
    )
    const boundSpec = YAML.parse(
      withToken.content[0].text,
    ) as { layout?: { gap?: unknown } }
    expect(String(boundSpec.layout?.gap)).toContain(
      'var(space/8)',
    )

    const cleared = await handleBindVariable(
      {
        nodeId: '1:42',
        field: 'itemSpacing',
        clear: true,
      },
      scoped,
    )
    expect(cleared.content[0].text).not.toContain('Error:')

    const after = await handleGetNode(
      { nodeId: '1:42' },
      scoped,
    )
    const plainSpec = YAML.parse(after.content[0].text) as {
      layout?: { gap?: unknown }
    }
    // The VALUE stays; only the token is gone — that is what unbinding means.
    expect(String(plainSpec.layout?.gap)).not.toContain(
      'var(',
    )
    expect(Number(plainSpec.layout?.gap)).toBe(8)
  })

  it('bind_variable refuses to clear a paint binding, and says why', async () => {
    const result = await handleBindVariable(
      { nodeId: '1:42', field: 'fills', clear: true },
      scoped,
    )
    expect(result.content[0].text).toContain('per paint')
  })
})
