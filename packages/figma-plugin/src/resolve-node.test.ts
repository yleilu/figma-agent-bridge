// resolve-node.test.ts — every id a read emits is an id a read resolves (B53).
//
// The fixture is the 2026-08-17 QA repro, transcribed from the run's own saved
// reply (`readbacks/deep-plot-allocation.json`) rather than invented:
//
//   INSTANCE  305:8637              "Chart card"
//     ├─ I305:8637;304:8411         "Header"     master-derived
//     └─ I305:8637;305:8427         "Plot area"  master-derived SLOT
//          └─ "Plot"                             slot-override content
//               ├─ "Total value"
//               └─ "Legend" → "Legend row" INSTANCE → "Dot" / "Label"
//
// The two sides disagree about the ids of everything under the SLOT. The live
// numbers are the ones the run's own `readError` quoted: the `Legend row` whose
// export id ends `305:8902` answers `305:8898`, and its children are addressed
// `I305:8898;304:823x`, which names no node. Only the INEQUALITY is load-
// bearing — the offset differs per node (4 on an instance, 1 on a plain node,
// per B53's `305:8853` vs `…;305:8854`).

import { describe, expect, it } from 'bun:test'
import {
  createNodeResolver,
  findLiveById,
  leadingInstanceId,
} from './resolve-node'
import type { LiveNode, RawNode } from './canonical-ids'

/**
 * A handle Figma composed from a stale parent id: every NODE read throws.
 *
 * `then` and any symbol answer undefined, because Figma throws on its own
 * properties and not on the ones the JS runtime probes — a handle that threw on
 * `then` could not be returned from an async function at all.
 */
const unreadable = (id: string): LiveNode =>
  new Proxy({} as LiveNode, {
    get: (_t, prop) => {
      if (prop === 'id') return id
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined
      }
      throw new Error(
        'in get_' +
          String(prop) +
          ': The node (instance sublayer or table cell) with id "' +
          id +
          '" does not exist',
      )
    },
    has: () => true,
  })

const DOT_LIVE = unreadable('I305:8898;304:8234')
const LABEL_LIVE = unreadable('I305:8898;304:8235')

const liveTree = (): LiveNode => ({
  id: '305:8637',
  name: 'Chart card',
  children: [
    { id: 'I305:8637;304:8411', name: 'Header' },
    {
      id: 'I305:8637;305:8427',
      name: 'Plot area',
      children: [
        {
          // Slot-override content answers its PRE-APPEND plain id.
          id: '305:8880',
          name: 'Plot',
          children: [
            { id: '305:8882', name: 'Total value' },
            {
              id: '305:8896',
              name: 'Legend',
              children: [
                {
                  id: '305:8898',
                  name: 'Legend row',
                  children: [DOT_LIVE, LABEL_LIVE],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
})

const exportedTree = (): RawNode => ({
  id: '305:8637',
  name: 'Chart card',
  children: [
    { id: 'I305:8637;304:8411', name: 'Header' },
    {
      id: 'I305:8637;305:8427',
      name: 'Plot area',
      children: [
        {
          id: 'I305:8637;305:8427;305:8881',
          name: 'Plot',
          children: [
            {
              id: 'I305:8637;305:8427;305:8883',
              name: 'Total value',
            },
            {
              id: 'I305:8637;305:8427;305:8897',
              name: 'Legend',
              children: [
                {
                  id: 'I305:8637;305:8427;305:8902',
                  name: 'Legend row',
                  children: [
                    {
                      id: 'I305:8637;305:8427;305:8902;304:8234',
                      name: 'Dot',
                    },
                    {
                      id: 'I305:8637;305:8427;305:8902;304:8235',
                      name: 'Label',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
})

/** The resolver plus a count of how often each dependency was asked. */
const harness = (
  options: { exportFails?: boolean } = {},
) => {
  const root = liveTree()
  const doc = exportedTree()
  const calls = { getNodeById: 0, exportOf: 0 }
  const resolver = createNodeResolver({
    getNodeById: async id => {
      calls.getNodeById++
      return id === '305:8637' ? root : null
    },
    exportOf: async () => {
      calls.exportOf++
      if (options.exportFails === true) {
        throw new Error('exportAsync refused')
      }
      return doc
    },
  })
  return { resolver, root, doc, calls }
}

describe('leadingInstanceId', () => {
  it('names the instance a compound id leads with', () => {
    expect(
      leadingInstanceId('I305:8637;305:8427;305:8881'),
    ).toBe('305:8637')
  })

  it('is undefined for a plain id', () => {
    expect(leadingInstanceId('305:8637')).toBeUndefined()
  })

  it('is undefined for an I with nothing before the separator', () => {
    expect(leadingInstanceId('I;305:8427')).toBeUndefined()
  })
})

describe('findLiveById', () => {
  it('finds a node by the id its handle answers', () => {
    const found = findLiveById(liveTree(), '305:8880')
    expect(found?.name).toBe('Plot')
  })

  it('walks past a handle that throws on every read', () => {
    // The unreadable Dot sits between the walk and nothing else, but a sibling
    // subtree must still be reachable — one stale handle costs one node.
    const root = liveTree()
    expect(findLiveById(root, '305:8882')?.name).toBe(
      'Total value',
    )
  })

  it('is undefined when no handle answers the id', () => {
    expect(
      findLiveById(
        liveTree(),
        'I305:8637;305:8427;305:8881',
      ),
    ).toBeUndefined()
  })
})

describe('createNodeResolver — the two id families', () => {
  it('a plain id goes straight to getNodeById, with no export', async () => {
    const { resolver, root, calls } = harness()
    expect(await resolver.resolve('305:8637')).toBe(root)
    expect(calls.exportOf).toBe(0)
  })

  it('a MASTER-DERIVED sublayer resolves by walking, with no export', async () => {
    const { resolver, calls } = harness()
    const found = await resolver.resolve(
      'I305:8637;305:8427',
    )
    expect(found?.name).toBe('Plot area')
    // The walk answered, so the oracle was never needed. This is the 2-segment
    // case that already worked, and it must not start paying for an export.
    expect(calls.exportOf).toBe(0)
  })

  it('SLOT-OVERRIDE content resolves by the id the read emits', async () => {
    const { resolver } = harness()
    // No live handle answers this id — the walk alone returns nothing (see the
    // findLiveById case above). The export names it, so the resolve does too.
    const found = await resolver.resolve(
      'I305:8637;305:8427;305:8881',
    )
    expect(found?.name).toBe('Plot')
    expect(found?.id).toBe('305:8880')
  })

  it('resolves a descendant of slot content at every level', async () => {
    const { resolver } = harness()
    expect(
      (
        await resolver.resolve(
          'I305:8637;305:8427;305:8883',
        )
      )?.name,
    ).toBe('Total value')
    expect(
      (
        await resolver.resolve(
          'I305:8637;305:8427;305:8897',
        )
      )?.name,
    ).toBe('Legend')
    expect(
      (
        await resolver.resolve(
          'I305:8637;305:8427;305:8902',
        )
      )?.id,
    ).toBe('305:8898')
  })

  it('resolves a node inside a slot-hosted INSTANCE to its own handle', async () => {
    const { resolver } = harness()
    // Four segments, and the handle Figma composed for it throws on every read.
    // It is still the node that id names, and the read face falls back to the
    // export for what the handle cannot say.
    expect(
      await resolver.resolve(
        'I305:8637;305:8427;305:8902;304:8235',
      ),
    ).toBe(LABEL_LIVE)
  })

  it('is null for a compound id neither side names', async () => {
    const { resolver } = harness()
    expect(
      await resolver.resolve('I305:8637;305:8427;9:99'),
    ).toBeNull()
  })

  it('is null when the leading instance is gone', async () => {
    const { resolver, calls } = harness()
    expect(
      await resolver.resolve('I9:99;305:8427'),
    ).toBeNull()
    expect(calls.exportOf).toBe(0)
  })

  it('is null when the instance cannot export itself', async () => {
    const { resolver } = harness({ exportFails: true })
    expect(
      await resolver.resolve(
        'I305:8637;305:8427;305:8881',
      ),
    ).toBeNull()
  })
})

describe('createNodeResolver — the export is paid for once', () => {
  it('one export serves every id of one instance', async () => {
    const { resolver, calls } = harness()
    await Promise.all([
      resolver.resolve('I305:8637;305:8427;305:8881'),
      resolver.resolve('I305:8637;305:8427;305:8883'),
      resolver.resolve('I305:8637;305:8427;305:8897'),
      resolver.resolve('I305:8637;305:8427;305:8902'),
    ])
    // Concurrent entries share the in-flight export, not just a settled one —
    // get_nodes resolves its whole list at once.
    expect(calls.exportOf).toBe(1)
  })

  it('reset drops the cache, so the next dispatch re-exports', async () => {
    const { resolver, calls } = harness()
    await resolver.resolve('I305:8637;305:8427;305:8881')
    resolver.reset()
    await resolver.resolve('I305:8637;305:8427;305:8881')
    expect(calls.exportOf).toBe(2)
  })
})

describe('createNodeResolver — exportedNode', () => {
  it('serves the exported subtree for a canonical id', async () => {
    const { resolver } = harness()
    const raw = await resolver.exportedNode(
      'I305:8637;305:8427;305:8902;304:8235',
    )
    expect(raw?.name).toBe('Label')
  })

  it('carries the node children, so a sliced read is a subtree', async () => {
    const { resolver } = harness()
    const raw = await resolver.exportedNode(
      'I305:8637;305:8427;305:8881',
    )
    expect(
      (raw?.children as RawNode[]).map(c => c.id),
    ).toEqual([
      'I305:8637;305:8427;305:8883',
      'I305:8637;305:8427;305:8897',
    ])
  })

  it('is undefined for a plain id — that node reads itself', async () => {
    const { resolver, calls } = harness()
    expect(
      await resolver.exportedNode('305:8637'),
    ).toBeUndefined()
    expect(calls.exportOf).toBe(0)
  })
})
