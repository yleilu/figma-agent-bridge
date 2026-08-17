// e2e-slot-deep.test.ts — B53: every id a read EMITS is an id a read RESOLVES,
// three levels deep (INSTANCE → SLOT → created subtree).
//
// The 2026-08-17 dashboard build broke on exactly this shape. `get_node` on a
// chart card listed a child `I305:8637;305:8427;305:8881`, and `get_node` on
// that same id answered NODE_NOT_FOUND. `search` then lost `component` on the
// 12 rows whose ids were of that shape, because the server hydrates a result
// page with a `get_nodes` over the ids the scan reported — so a broken resolve
// silently emptied a join that still reported success.
//
// The plugin resolved a compound id by matching LIVE ids under the leading
// instance. Slot-override content answers a plain pre-append id, so no live
// handle ever answered the id the export had emitted. It now resolves through
// the same export the read is built from (resolve-node.ts).
//
// These pin the SERVER half plus the CONTRACT. The mock models the document
// (see its three-level section), not the plugin's traversal — the plugin's own
// resolve is unit-tested in figma-plugin/src/resolve-node.test.ts and confirmed
// by the live battery.

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
import {
  handleGetNode,
  handleGetNodes,
} from '@figma-agent-bridge/server/tools/read'
import { handleSearch } from '@figma-agent-bridge/server/tools/search'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3138
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-slot-deep-test'
const FK = 'fk-slot-deep'

const CARD = '305:8637'
const SLOT = 'I305:8637;305:8427'
const PLOT = 'I305:8637;305:8427;305:8881'
const TOTAL = 'I305:8637;305:8427;305:8883'
const LEGEND = 'I305:8637;305:8427;305:8897'
const ROW = 'I305:8637;305:8427;305:8902'
const LABEL = 'I305:8637;305:8427;305:8902;304:8235'

type Spec = Record<string, unknown>

/** Every id in a read, in document order. */
const idsIn = (spec: Spec): string[] => {
  const out: string[] = []
  const walk = (node: Spec): void => {
    if (typeof node.id === 'string') {
      out.push(node.id)
    }
    const kids = node.children
    if (!Array.isArray(kids)) {
      return
    }
    for (const kid of kids) {
      if (typeof kid === 'object' && kid !== null) {
        walk(kid as Spec)
      }
    }
  }
  walk(spec)
  return out
}

const nodeIn = (
  spec: Spec,
  id: string,
): Spec | undefined => {
  if (spec.id === id) {
    return spec
  }
  const kids = spec.children
  if (!Array.isArray(kids)) {
    return undefined
  }
  for (const kid of kids) {
    if (typeof kid === 'object' && kid !== null) {
      const hit = nodeIn(kid as Spec, id)
      if (hit !== undefined) {
        return hit
      }
    }
  }
  return undefined
}

describe('B53 — three-level slot nesting', () => {
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
      documentName: 'Deep Slot Doc',
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

  const readCard = async (): Promise<Spec> => {
    const read = await handleGetNode(
      { nodeId: CARD, depth: 4, profile: 'full' },
      scoped,
    )
    return YAML.parse(read.content[0].text) as Spec
  }

  // --- the property the row is about ---------------------------------------

  it('every id a depth-4 read emits resolves through get_node', async () => {
    const ids = idsIn(await readCard())
    // Liveness: a walk that found nothing would pass an all-clear loop.
    expect(ids).toContain(PLOT)
    expect(ids).toContain(LABEL)
    expect(ids.length).toBeGreaterThanOrEqual(8)

    const refused: string[] = []
    for (const id of ids) {
      const read = await handleGetNode(
        { nodeId: id },
        scoped,
      )
      const spec = YAML.parse(read.content[0].text) as Spec
      if (spec.id !== id) {
        refused.push(id + ' → ' + String(spec.id))
      }
    }
    expect(refused).toEqual([])
  })

  it('every id a depth-4 read emits resolves through get_nodes, in one call', async () => {
    const ids = idsIn(await readCard())
    expect(ids).toContain(ROW)
    expect(ids.length).toBeGreaterThanOrEqual(8)

    const read = await handleGetNodes(
      { nodeIds: ids },
      scoped,
    )
    const out = YAML.parse(read.content[0].text) as {
      results?: Spec[]
      errors?: Spec[]
    }
    expect(out.errors ?? []).toEqual([])
    expect((out.results ?? []).map(r => r.id)).toEqual(ids)
  })

  it('the id the parent read lists is the id the child read answers', async () => {
    // The self-contradiction B53 opens with: one tool listing a child it then
    // refuses. Same two calls, asserted as one property.
    const card = await readCard()
    const slot = nodeIn(card, SLOT) as Spec
    const listed = (slot.children as Spec[])[0].id as string
    expect(listed).toBe(PLOT)

    const read = await handleGetNode(
      { nodeId: listed },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as Spec
    expect(spec.id).toBe(listed)
    expect(spec.name).toBe('Plot')
  })

  // --- one vocabulary, not two ---------------------------------------------

  it('the emitted ids are ONE grammar: a segment per instance boundary', async () => {
    const card = await readCard()
    const segments = (id: string): number =>
      id.split(';').length
    // Plot, its child and its grandchild all sit inside the same SLOT, so all
    // three carry three segments. The ledger read this as a chain beside a skip
    // form; it is neither, because the chain does not track tree depth.
    expect(segments(PLOT)).toBe(3)
    expect(segments(TOTAL)).toBe(3)
    expect(segments(LEGEND)).toBe(3)
    expect(segments(ROW)).toBe(3)
    // A fourth segment appears only where the walk crosses another INSTANCE.
    expect(segments(LABEL)).toBe(4)
    expect(idsIn(card)).toEqual([
      CARD,
      'I305:8637;304:8411',
      SLOT,
      PLOT,
      TOTAL,
      LEGEND,
      ROW,
      'I305:8637;305:8427;305:8902;304:8234',
      LABEL,
    ])
  })

  // --- what the depths actually carry ---------------------------------------

  it('a THREE-segment node keeps its style() and var() wrappers', async () => {
    const read = await handleGetNode(
      { nodeId: TOTAL, profile: 'full' },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as {
      fills: string[]
      text: { font: string }
      readError?: string
    }
    expect(spec.fills[0]).toMatch(/^var\(text\/hi\)/)
    expect(spec.text.font).toContain(
      'style(Heading/KPI value)',
    )
    expect(spec.readError).toBeUndefined()
  })

  it('a FOUR-segment node reads, and SAYS what its handle could not answer', async () => {
    // B41's residual, not B53's: the handle Figma composed for this node is
    // built from the alias, so no live read lands on it. The row must still
    // come back, carrying the export's var() and its own readError — the same
    // row the parent read shows, not a refusal.
    const read = await handleGetNode(
      { nodeId: LABEL, profile: 'full' },
      scoped,
    )
    const spec = YAML.parse(read.content[0].text) as {
      id: string
      fills: string[]
      readError?: string
    }
    expect(spec.id).toBe(LABEL)
    expect(spec.fills[0]).toMatch(/^var\(text\/mid\)/)
    expect(spec.readError).toContain('I305:8898;304:8235')
  })

  // --- the join that inverted a QA verdict ----------------------------------

  it('search serves component on a three-segment INSTANCE id', async () => {
    const result = await handleSearch(
      {
        scope: 'node',
        nodeId: CARD,
        match: { type: 'INSTANCE' },
        fields: ['id', 'name', 'type', 'component'],
      },
      scoped,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Spec[]
      warnings?: string[]
    }
    const row = out.results.find(r => r.id === ROW)
    expect(row).toBeDefined()
    // The failure mode was a row that came back WITHOUT the joined field while
    // the search still reported success. An id-join over these rows read four
    // definitions as never-instanced and scored the build a fail.
    expect(row?.component).toEqual({
      id: '304:8285',
      key: 'legend-row-violet-key',
    })
    expect(out.warnings ?? []).toEqual([])
  })

  it('search serves characters on the deep rows too', async () => {
    const result = await handleSearch(
      {
        scope: 'node',
        nodeId: CARD,
        match: { type: 'TEXT' },
        fields: ['id', 'name', 'characters'],
      },
      scoped,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Spec[]
      warnings?: string[]
    }
    expect(out.results.map(r => r.id).sort()).toEqual(
      [TOTAL, LABEL].sort(),
    )
    expect(out.warnings ?? []).toEqual([])
  })

  // --- writing to what the read named ---------------------------------------

  it('update_node applies to a three-segment slot-override id', async () => {
    // Called twice: the defect this family carries is intermittent-looking, so
    // one green call proves nothing.
    const answers: string[] = []
    for (let i = 0; i < 2; i++) {
      const result = await handleUpdateNode(
        { nodeId: ROW, patch: { opacity: 0.5 } },
        scoped,
      )
      answers.push(result.content[0].text)
    }
    expect(answers[0]).toBe(answers[1])
    expect(answers[0]).not.toContain('Node not found')
    expect(answers[0]).not.toContain('internet connection')
  })

  it('a compound id under this card that names nothing is still refused', async () => {
    // The fix must not turn "not found" into a shrug: an id the file does not
    // hold has to keep saying so.
    const result = await handleUpdateNode(
      {
        nodeId: 'I305:8637;305:8427;9:99',
        patch: { opacity: 0.5 },
      },
      scoped,
    )
    expect(result.content[0].text).toContain(
      'Node not found',
    )
  })
})
