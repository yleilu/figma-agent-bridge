// e2e-styled-fields.test.ts — a styled field is a reference, not a list (B47),
// end to end over the relay.
//
// The write face is asked for the four things the contract promises: the two
// legal forms both land the style and no literals; the mixes a slot cannot hold
// are refused BEFORE the plugin is asked; a name that resolves to nothing (or
// to a style of the wrong type) is refused on the same terms; and the read a
// styled node produces is writable back verbatim as a no-op.

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
import { handleBatch } from '@figma-agent-bridge/server/tools/batch'
import { handleUpdateComponent } from '@figma-agent-bridge/server/tools/components'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3136
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-styled-fields'
const FK = 'fk-styled-fields'

type Binding = {
  kind: string
  name: string
  field: string
  index?: number
}

const body = (text: string): Record<string, unknown> =>
  JSON.parse(text.split('\n\nWarning:')[0]) as Record<
    string,
    unknown
  >

const envelope = (
  text: string,
): { error?: string; code?: string } =>
  JSON.parse(text) as { error?: string; code?: string }

describe('styled fields e2e (B47)', () => {
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

  // ── the two legal write forms ─────────────────────────────────────────────

  it('the scalar reference applies the style and sends no paints', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { fills: 'style(Glass/Fill)' },
      },
      scoped,
    )
    const data = body(result.content[0].text)
    const spec = data.spec as Record<string, unknown>
    expect('fills' in spec).toBe(false)
    expect(data.appliedBindings).toEqual([
      { kind: 'style', name: 'Glass/Fill', field: 'fill' },
    ])
    expect(data.warnings).toEqual([])
  })

  it('the legacy lone-style-in-array write is accepted as the same reference', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { fills: ['style(Glass/Fill)#141B2E99'] },
      },
      scoped,
    )
    const data = body(result.content[0].text)
    expect('fills' in (data.spec as object)).toBe(false)
    expect(data.appliedBindings).toEqual([
      { kind: 'style', name: 'Glass/Fill', field: 'fill' },
    ])
    expect(data.warnings).toEqual([])
  })

  // The shape the 0.4.0 reader emitted for a MULTI-VALUE style: every entry
  // wrapped by the same name. It names one owner, so it is the reference — and
  // `AB/Blur` holds exactly these two effects, so it lands silently.
  it('the legacy MULTI-ENTRY read-back is accepted as the same reference, silently', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          effects: [
            'style(AB/Blur)bg-blur(24)',
            'style(AB/Blur)shadow(0,8,24,#00000066)',
          ],
        },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).not.toContain('"code"')
    const data = body(text)
    expect('effects' in (data.spec as object)).toBe(false)
    expect(data.appliedBindings).toEqual([
      { kind: 'style', name: 'AB/Blur', field: 'effect' },
    ])
    expect(data.warnings).toEqual([])
  })

  it('a literal array still writes literals and binds nothing', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { fills: ['#FF0000', '#00FF00'] },
      },
      scoped,
    )
    const data = body(result.content[0].text)
    expect(
      (data.spec as { fills?: unknown[] }).fills,
    ).toHaveLength(2)
    expect(data.appliedBindings).toEqual([])
  })

  // ── the four rejections ───────────────────────────────────────────────────

  it('rule 1 (style then literal) is refused before the plugin is asked', async () => {
    // A plugin that answers NOTHING: if this write (or the style read behind
    // it) were dispatched at all, the call would hang until the command
    // timeout instead of returning the rejection.
    plugin!.setSilent(true)
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          effects: [
            'style(AB/Blur)bg-blur(24)',
            'shadow(0,8,24,#00000066)',
          ],
        },
      },
      scoped,
    )
    const out = envelope(result.content[0].text)
    expect(out.code).toBe('INVALID_PARAM')
    expect(out.error).toBe(
      'a style owns the whole effects list — use a style containing every ' +
        'effect you want, or write them all as literals (a style cannot be ' +
        'combined with literal siblings)',
    )
  })

  it('rule 1 (literal then style) is refused identically', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          effects: [
            'shadow(0,8,24,#00000066)',
            'style(AB/Blur)bg-blur(24)',
          ],
        },
      },
      scoped,
    )
    expect(envelope(result.content[0].text).code).toBe(
      'INVALID_PARAM',
    )
  })

  it('rule 2 (two styles in one field) is refused', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          fills: [
            'style(Brand/Primary)#3B82F6',
            'style(Glass/Fill)#141B2E99',
          ],
        },
      },
      scoped,
    )
    const out = envelope(result.content[0].text)
    expect(out.code).toBe('INVALID_PARAM')
    expect(out.error).toContain('the whole fills list')
  })

  it('rule 2 cross-field (fills and text.color are one slot) is refused', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          fills: 'style(Glass/Fill)[#141B2E99]',
          text: {
            content: 'Hi',
            color: 'style(Brand/Primary)#3B82F6',
          },
        },
      },
      scoped,
    )
    expect(envelope(result.content[0].text).code).toBe(
      'INVALID_PARAM',
    )
  })

  it('rule 3 (a style of the wrong type for the slot) is refused', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { effects: 'style(Brand/Primary)' },
      },
      scoped,
    )
    const out = envelope(result.content[0].text)
    expect(out.code).toBe('INVALID_PARAM')
    expect(out.error).toContain(
      'style(Brand/Primary) is a paint style, but effects needs an effect style',
    )
  })

  it('rule 4 (a name that resolves to nothing) is refused', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          effects: 'style(Ghost/Blur)',
        },
      },
      scoped,
    )
    const out = envelope(result.content[0].text)
    expect(out.code).toBe('INVALID_PARAM')
    expect(out.error).toContain(
      'matches no effect style in this file',
    )
  })

  // The fifth write path: a slot's spec leaves by the same door, so it is
  // gated on the same terms. Named here rather than in the components e2e
  // because it is the contract that puts it there.
  it("an update_component slot's unresolvable reference is refused too", async () => {
    const result = await handleUpdateComponent(
      {
        componentId: 'c:1',
        slots: [
          { name: 'Content', fills: 'style(Ghost/Fill)' },
        ],
      },
      scoped,
    )
    const out = envelope(result.content[0].text)
    expect(out.code).toBe('INVALID_PARAM')
    expect(out.error).toContain(
      'matches no paint style in this file',
    )
  })

  it('an update_component slot with a good reference applies the style to the slot', async () => {
    const result = await handleUpdateComponent(
      {
        componentId: 'c:1',
        slots: [
          { name: 'Content', fills: 'style(Glass/Fill)' },
        ],
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).not.toContain('"code"')
    expect(text).not.toContain('rideAlong')
  })

  it("a child's unresolvable reference stops the whole create_tree", async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          children: [
            {
              type: 'RECTANGLE',
              fills: 'style(Ghost/Fill)',
            },
          ],
        },
      },
      scoped,
    )
    expect(envelope(result.content[0].text).code).toBe(
      'INVALID_PARAM',
    )
  })

  // ── warn-on-differ ────────────────────────────────────────────────────────

  it('a ride-along that differs from the style is named, and the style still lands', async () => {
    // `Card Shadow` holds one shadow; this write claims a blur rides with it.
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          effects:
            'style(Card Shadow)[shadow(0,4,12,#0000001A), bg-blur(24)]',
        },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).not.toContain('"code"')
    const data = body(text)
    expect(data.appliedBindings).toEqual([
      {
        kind: 'style',
        name: 'Card Shadow',
        field: 'effect',
      },
    ])
    expect(data.warnings).toContain(
      'style(Card Shadow) owns effects — it supplies ' +
        '[shadow(0,4,12,#0000001A)], so the 1 extra effect written beside it ' +
        'was not applied; add it to the style, or write every effect as a ' +
        'literal.',
    )
  })

  it('a reference that claims exactly what the style supplies says nothing', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          effects:
            'style(AB/Blur)[bg-blur(24), shadow(0,8,24,#00000066)]',
        },
      },
      scoped,
    )
    const data = body(result.content[0].text)
    expect(data.warnings).toEqual([])
  })

  // ── the round trip ────────────────────────────────────────────────────────

  it('write the style → read the reference → write it back verbatim = a silent no-op', async () => {
    await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { effects: 'style(AB/Blur)' },
      },
      scoped,
    )
    const read = await handleGetNode(
      { nodeId: '1:42' },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as {
      effects?: unknown
    }
    // The read emits the REFERENCE with the list the style resolves to — both
    // effects, always bracketed.
    expect(spec.effects).toBe(
      'style(AB/Blur)[bg-blur(24), shadow(0,8,24,#00000066)]',
    )
    const back = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { effects: spec.effects as string },
      },
      scoped,
    )
    const data = body(back.content[0].text)
    expect('effects' in (data.spec as object)).toBe(false)
    expect(data.appliedBindings).toEqual([
      { kind: 'style', name: 'AB/Blur', field: 'effect' },
    ])
    expect(data.warnings).toEqual([])
  })

  // ── batch keeps its partial-success contract ──────────────────────────────

  it('batch: a bad reference fails ITS entry and the rest of the batch still runs', async () => {
    const result = await handleBatch(
      {
        op: 'update_node',
        ops: [
          {
            nodeId: '1:42',
            patch: { fills: 'style(Ghost/Fill)' },
          },
          { nodeId: '1:43', patch: { opacity: 0.5 } },
        ],
      },
      scoped,
    )
    const out = JSON.parse(result.content[0].text) as {
      results: { index: number; ok: boolean }[]
      errors: { index: number; code: string }[]
    }
    expect(out.results[0].ok).toBe(false)
    expect(out.results[1].ok).toBe(true)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toMatchObject({
      index: 0,
      code: 'INVALID_PARAM',
    })
  })

  it('batch: a mix is rejected as that entry’s INVALID_PARAM, not a plugin failure', async () => {
    const result = await handleBatch(
      {
        op: 'update_node',
        ops: [
          {
            nodeId: '1:42',
            patch: {
              fills: [
                'style(Glass/Fill)#141B2E99',
                '#FFFFFF',
              ],
            },
          },
        ],
      },
      scoped,
    )
    const out = JSON.parse(result.content[0].text) as {
      errors: { code: string; error: string }[]
    }
    expect(out.errors[0].code).toBe('INVALID_PARAM')
    expect(out.errors[0].error).toContain(
      'the whole fills list',
    )
  })

  it('batch: a styled write that lands carries the binding to the plugin', async () => {
    const result = await handleBatch(
      {
        op: 'update_node',
        ops: [
          {
            nodeId: '1:42',
            patch: { fills: 'style(Glass/Fill)' },
          },
        ],
      },
      scoped,
    )
    const out = JSON.parse(result.content[0].text) as {
      results: {
        ok: boolean
        result?: { appliedBindings?: Binding[] }
      }[]
    }
    expect(out.results[0].ok).toBe(true)
    expect(out.results[0].result?.appliedBindings).toEqual([
      { kind: 'style', name: 'Glass/Fill', field: 'fill' },
    ])
  })
})
