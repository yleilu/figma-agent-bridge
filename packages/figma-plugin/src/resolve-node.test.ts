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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  aliasAddressMessage,
  createNodeResolver,
  declareDegradedRead,
  deadHandleMessage,
  detachedFromDocument,
  exportBudgetMessage,
  findLiveById,
  findLiveMatches,
  handleAnswers,
  isAliasHandle,
  leadingInstanceId,
  MAX_INSTANCE_EXPORTS,
  outerInstanceOf,
  parentAnswers,
  restatedRefusal,
  servedByAncestorExport,
  slicedReadMessage,
  staleHandleThrow,
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

// B89 — `search` handed out the id the LIVE HANDLE answers, and for slot
// content that is a pre-append id the rest of the surface rejects. One reply
// carried 129 of them; 55 screen nodes came back under an id `get_node` will
// not accept (`block/kpi-card` is `581:58274` in search and
// `I581:58099;…;581:58287` in get_node), and the write side refused 12 writes
// to ids search itself had just emitted. The warning was excellent and the
// defect was that a sibling tool rejected the answer. The oracle that can fix
// it is the one the read face already holds: the export names every node
// canonically, and this resolver already pays for that export.
describe('createNodeResolver — canonicalIdFor (B89)', () => {
  it('names an alias handle the way the FILE names it', async () => {
    const { resolver, root } = harness()
    // `Plot` is slot-override content: it answers its pre-append `305:8880`
    // while the export calls it `I305:8637;305:8427;305:8881`.
    const plot = findLiveById(root, '305:8880') as LiveNode
    expect(
      await resolver.canonicalIdFor(plot, '305:8637'),
    ).toBe('I305:8637;305:8427;305:8881')
  })

  it('pays for ONE export however many handles it is asked about', async () => {
    const { resolver, root, calls } = harness()
    for (const id of ['305:8880', '305:8882', '305:8896']) {
      const node = findLiveById(root, id) as LiveNode
      expect(
        await resolver.canonicalIdFor(node, '305:8637'),
      ).toBeDefined()
    }
    expect(calls.exportOf).toBe(1)
  })

  it('answers undefined for a handle the export does not describe', async () => {
    const { resolver } = harness()
    expect(
      await resolver.canonicalIdFor(
        { id: '999:1' },
        '305:8637',
      ),
    ).toBeUndefined()
  })

  it('DEGRADES on the budget rather than throwing — a scan must not die of it', async () => {
    // `resolve` throws on the budget, because a caller that cannot tell a
    // refusal from a miss would report a node as missing. A search row is the
    // opposite case: the row is already in hand, and the worst honest answer is
    // to keep the alias id and say so.
    const root = liveTree()
    const resolver = createNodeResolver({
      getNodeById: async () => root,
      exportOf: async () => exportedTree(),
      maxExports: 0,
    })
    const plot = findLiveById(root, '305:8880') as LiveNode
    expect(
      await resolver.canonicalIdFor(plot, '305:8637'),
    ).toBeUndefined()
  })

  it('answers undefined when the instance cannot export itself', async () => {
    const { resolver, root } = harness({ exportFails: true })
    const plot = findLiveById(root, '305:8880') as LiveNode
    expect(
      await resolver.canonicalIdFor(plot, '305:8637'),
    ).toBeUndefined()
  })
})

// B93 — SAME-COMPONENT NESTING. An instance of X placed inside a SLOT of
// another instance of X shares every local id with its host, and the pairing
// collapsed them: the page enumerated the inner instance's canonical chain in
// the outer's place, the alias gate blamed the outer instance as "content
// inside" the inner, and `clone_node` on the outer answered with the INNER's
// clone. With two DIFFERENT components none of it happens — live-verified,
// both arms, 2026-09-03.
//
// The fake models the collision itself, because the collision IS the bug: two
// live handles in one subtree answering one id. A fixture with distinct ids
// cannot see any of this, which is exactly why the two-arm discriminator was
// needed to find it.

/** Host and nested copy of ONE component, sharing every local id. */
const sameComponentNest = () => {
  const innerLabel: LiveNode = {
    id: 'I581:100;300:2',
    name: 'Label',
    type: 'TEXT',
  }
  const innerSlot: LiveNode = {
    id: 'I581:100;300:3',
    name: 'Body',
    type: 'SLOT',
    children: [],
  }
  const inner: LiveNode = {
    id: '581:100',
    name: 'Card',
    type: 'INSTANCE',
    children: [innerLabel, innerSlot],
  }
  const outerLabel: LiveNode = {
    id: 'I581:100;300:2',
    name: 'Label',
    type: 'TEXT',
  }
  const outerSlot: LiveNode = {
    id: 'I581:100;300:3',
    name: 'Body',
    type: 'SLOT',
    children: [inner],
  }
  const outer: LiveNode = {
    id: '581:100',
    name: 'Card',
    type: 'INSTANCE',
    children: [outerLabel, outerSlot],
  }
  innerLabel.parent = inner
  innerSlot.parent = inner
  inner.parent = outerSlot
  outerLabel.parent = outer
  outerSlot.parent = outer
  return {
    outer,
    outerLabel,
    outerSlot,
    inner,
    innerLabel,
    innerSlot,
  }
}

/** What the EXPORT calls the same tree: one id per chain position. */
const sameComponentExport = (): RawNode => ({
  id: '581:100',
  name: 'Card',
  children: [
    { id: 'I581:100;300:2', name: 'Label' },
    {
      id: 'I581:100;300:3',
      name: 'Body',
      children: [
        {
          id: 'I581:100;300:3;581:150',
          name: 'Card',
          children: [
            {
              id: 'I581:100;300:3;581:150;300:2',
              name: 'Label',
            },
            {
              id: 'I581:100;300:3;581:150;300:3',
              name: 'Body',
            },
          ],
        },
      ],
    },
  ],
})

describe('B93 — two handles, one id', () => {
  it('the walk answers the SHALLOWEST, not whichever the stack reached first', () => {
    const { outer, outerLabel } = sameComponentNest()
    // Depth-first off a stack descends the LAST child first, so it used to
    // reach the nested copy's Label before the host's own.
    expect(findLiveById(outer, 'I581:100;300:2')).toBe(
      outerLabel,
    )
  })

  it('names every handle that answers, so a caller can be told there were two', () => {
    const { outer, outerLabel, innerLabel } =
      sameComponentNest()
    expect(findLiveMatches(outer, 'I581:100;300:2')).toEqual(
      [outerLabel, innerLabel],
    )
  })

  it('is not confused by a tree whose ids are distinct (the control arm)', () => {
    const { outer } = sameComponentNest()
    expect(
      findLiveMatches(outer, 'I581:100;300:3'),
    ).toHaveLength(2)
    expect(
      findLiveMatches(outer, 'I999:1;300:2'),
    ).toEqual([])
  })

  it('lets the EXPORT settle an ambiguous id — it is the only oracle that knows chain position', async () => {
    const { outer, innerLabel } = sameComponentNest()
    const resolver = createNodeResolver({
      getNodeById: async id =>
        id === '581:100' ? outer : null,
      exportOf: async () => sameComponentExport(),
    })
    // The inner Label, addressed the way a read emits it. The live walk cannot
    // tell it from the host's own Label; the export can.
    expect(
      await resolver.resolve(
        'I581:100;300:3;581:150;300:2',
      ),
    ).toBe(innerLabel)
  })

  it('a WRITE through an ambiguous id is refused, naming the collision', async () => {
    const { outer } = sameComponentNest()
    const resolver = createNodeResolver({
      getNodeById: async id =>
        id === '581:100' ? outer : null,
      // No oracle: the host will not export, so nothing can disambiguate.
      exportOf: async () => undefined,
    })
    resolver.setStrict(true)
    await expect(
      resolver.resolve('I581:100;300:2'),
    ).rejects.toThrow('581:100')
    await expect(
      resolver.resolve('I581:100;300:2'),
    ).rejects.toThrow('two')
  })

  it('a READ through the same id takes the shallowest and does not throw', async () => {
    const { outer, outerLabel } = sameComponentNest()
    const resolver = createNodeResolver({
      getNodeById: async id =>
        id === '581:100' ? outer : null,
      exportOf: async () => undefined,
    })
    expect(await resolver.resolve('I581:100;300:2')).toBe(
      outerLabel,
    )
  })

  it('does not call a node an ALIAS because an ancestor answers its own id', () => {
    // The alias finding is "this node is content that kept a pre-append id
    // inside some instance". A host answering the SAME id as the node is an id
    // collision, and an unknown must never be reported as a finding — that is
    // how the gate came to blame the outer instance for being content inside
    // the inner.
    const { inner } = sameComponentNest()
    expect(isAliasHandle(inner)).toBe(false)
  })

  it('a WRITE to a plain id an ancestor also answers is refused, not silently aimed', async () => {
    // `clone_node` on the outer answered with the INNER's clone: one plain id,
    // two nodes, and Figma picked. A refusal naming the collision is the only
    // honest answer — the surface never acks a write onto a node nobody meant.
    const { inner } = sameComponentNest()
    const resolver = createNodeResolver({
      getNodeById: async () => inner,
      exportOf: async () => undefined,
    })
    resolver.setStrict(true)
    await expect(resolver.resolve('581:100')).rejects.toThrow(
      'two nodes',
    )
  })

  it('a READ of that same plain id still answers (reads are unaffected)', async () => {
    const { inner } = sameComponentNest()
    const resolver = createNodeResolver({
      getNodeById: async () => inner,
      exportOf: async () => undefined,
    })
    expect(await resolver.resolve('581:100')).toBe(inner)
  })

  it('leaves an ordinary plain id alone in write mode (the control arm)', async () => {
    const plain: LiveNode = { id: '1:2', type: 'FRAME' }
    const resolver = createNodeResolver({
      getNodeById: async () => plain,
      exportOf: async () => undefined,
    })
    resolver.setStrict(true)
    expect(await resolver.resolve('1:2')).toBe(plain)
  })
})

// B94 — Figma RE-MINTS a node on the way into an instance slot: a new node
// appears under the instance's chain and the handle that went in is DROPPED.
// The dropped handle keeps answering id, name and type, so `update_node` on the
// id a staged create had just answered came back `{id, name, warnings:[]}` and
// reached nothing. A phantom write, live 2026-09-03.
describe('B94 — a dropped handle cannot take a write', () => {
  /** What Figma leaves behind after a re-mint: answers itself, parents nothing. */
  const dropped = (id: string): LiveNode => ({
    id,
    name: 'Row content',
    type: 'FRAME',
    parent: null,
  })

  it('refuses a write to a handle Figma no longer holds', async () => {
    const resolver = createNodeResolver({
      getNodeById: async () => dropped('585:73446'),
      exportOf: async () => undefined,
    })
    resolver.setStrict(true)
    await expect(
      resolver.resolve('585:73446'),
    ).rejects.toThrow('re-minted')
  })

  it('refuses one Figma reports as removed, whatever its parent says', async () => {
    const resolver = createNodeResolver({
      getNodeById: async () => ({
        id: '585:73437',
        type: 'FRAME',
        removed: true,
        parent: { id: '0:1', type: 'PAGE' },
      }),
      exportOf: async () => undefined,
    })
    resolver.setStrict(true)
    await expect(
      resolver.resolve('585:73437'),
    ).rejects.toThrow('no longer holds')
  })

  it('a READ of the same id still answers — reads are unaffected', async () => {
    const ghost = dropped('585:73446')
    const resolver = createNodeResolver({
      getNodeById: async () => ghost,
      exportOf: async () => undefined,
    })
    expect(await resolver.resolve('585:73446')).toBe(ghost)
  })

  it('does NOT refuse a handle whose .parent merely THROWS (the B81 class)', () => {
    // B81's whole finding: probing `.parent` cost 48 refused writes and bent a
    // build's topology. A throw is an unknown, and an unknown is not a finding.
    const refusesParent = new Proxy({} as LiveNode, {
      get: (_t, prop) => {
        if (prop === 'id') return 'I1:2;3:4'
        if (prop === 'type') return 'FRAME'
        if (prop === 'removed') return undefined
        if (typeof prop === 'symbol' || prop === 'then') {
          return undefined
        }
        throw new Error(
          'in get_parent: The node (instance sublayer or table cell) does not exist',
        )
      },
      has: () => true,
    })
    expect(detachedFromDocument(refusesParent)).toBe(false)
  })

  it('never accuses a PAGE, which legitimately has no parent', () => {
    expect(
      detachedFromDocument({
        id: '0:1',
        type: 'PAGE',
        parent: null,
      }),
    ).toBe(false)
  })

  it('leaves an ordinary parented node alone', () => {
    expect(
      detachedFromDocument({
        id: '1:2',
        type: 'FRAME',
        parent: { id: '0:1', type: 'PAGE' },
      }),
    ).toBe(false)
  })
})

// `code.ts` cannot be imported outside Figma — the house source-scan pattern,
// with its own liveness assertion so an empty scan cannot look like a pass.
describe('B89 — search actually renames its alias rows', () => {
  const searchArm = (() => {
    const src = readFileSync(
      join(import.meta.dir, 'code.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    return src.slice(
      src.indexOf('case COMMANDS.SEARCH:'),
      src.indexOf('case COMMANDS.CREATE_NODE:'),
    )
  })()

  it('read the search arm (liveness)', () => {
    expect(searchArm).toContain('isAliasHandle(')
    expect(searchArm.length).toBeGreaterThan(1000)
  })

  it('asks the export for the canonical id of an alias row', () => {
    expect(searchArm).toContain('nodeResolver.canonicalIdFor(')
    expect(searchArm).toContain('outerInstanceOf(')
  })

  it('corrects the SCAN’s id too, so the repair pass keeps the live row', () => {
    // The repair compares a row's id against the export's own ids to decide
    // whether the export supersedes it. A renamed row that still carried its
    // alias in `scanned` would be superseded and come back twice.
    expect(searchArm).toContain('scanned[index].id = canonical')
  })

  it('warns only about what it could NOT rename', () => {
    expect(searchArm).toContain('are still pre-append ids')
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

describe('declareDegradedRead — a thin row never comes back silent', () => {
  // The review's IMPORTANT 1. When the resolve missed but the export named the
  // node, the reply carried export fields and NO readError — a loud
  // NODE_NOT_FOUND became quiet incompleteness, which is the defect B53 IS.

  it('stamps the reason on a row the enrichment left silent', () => {
    const doc: Record<string, unknown> = {
      id: 'I1:1;1:5;1:9',
      name: 'Label',
    }
    declareDegradedRead(doc, slicedReadMessage('I1:1;1:5;1:9'))
    expect(doc.readError).toContain('no live handle answered')
    expect(doc.readError).toContain('I1:1;1:5;1:9')
  })

  it('never overwrites a failure the enrichment already named', () => {
    // The enrichment's message names the actual throw, which is more specific
    // than "no handle answered".
    const doc: Record<string, unknown> = {
      id: 'x',
      readError: 'Error: in getSharedPluginData: …',
    }
    declareDegradedRead(doc, 'generic reason')
    expect(doc.readError).toBe(
      'Error: in getSharedPluginData: …',
    )
  })

  it('treats a descendant failure as already declared', () => {
    // `readErrors` says a node BELOW me failed. The row is not silent, so
    // stamping a second, vaguer claim on the root would only add noise.
    const doc: Record<string, unknown> = {
      id: 'x',
      readErrors: ['1:9: does not exist'],
    }
    declareDegradedRead(doc, 'generic reason')
    expect(doc.readError).toBeUndefined()
  })

  it('the sliced message names the id the caller asked for', () => {
    // Not the alias. The caller never saw the alias and cannot act on it.
    expect(slicedReadMessage('I305:8637;305:8427;305:8902')).toContain(
      'I305:8637;305:8427;305:8902',
    )
  })
})

describe('createNodeResolver — the export budget', () => {
  // One instance per id, so every resolve needs a NEW export. This is the shape
  // the cache cannot help with: `search` hydrates a result page with a
  // `get_nodes` over up to 50 ids, and the QA run's broken rows sat under
  // different cards.
  const manyInstances = (maxExports: number) => {
    const calls = { exportOf: 0 }
    // Each instance has a master-derived child (the walk answers it, free) and
    // a slot-override child (only the export names it).
    const liveOf = (n: number): LiveNode => ({
      id: n + ':1',
      children: [
        { id: 'I' + n + ':1;' + n + ':2', name: 'Header' },
        { id: n + ':7', name: 'Content ' + n },
      ],
    })
    const exportedOf = (n: number): RawNode => ({
      id: n + ':1',
      children: [
        { id: 'I' + n + ':1;' + n + ':2', name: 'Header' },
        {
          id: 'I' + n + ':1;' + n + ':5;' + n + ':9',
          name: 'Content ' + n,
        },
      ],
    })
    const deepId = (n: number): string =>
      'I' + n + ':1;' + n + ':5;' + n + ':9'
    const resolver = createNodeResolver({
      maxExports,
      getNodeById: async id => {
        const n = Number(id.split(':')[0])
        return Number.isNaN(n) ? null : liveOf(n)
      },
      exportOf: async node => {
        calls.exportOf++
        return exportedOf(
          Number(String(node.id).split(':')[0]),
        )
      },
    })
    return { resolver, calls, deepId }
  }

  it('resolves ids up to the budget', async () => {
    const { resolver, calls, deepId } = manyInstances(2)
    expect((await resolver.resolve(deepId(1)))?.id).toBe(
      '1:7',
    )
    expect((await resolver.resolve(deepId(2)))?.id).toBe(
      '2:7',
    )
    expect(calls.exportOf).toBe(2)
  })

  it('past the budget it degrades LOUDLY, naming the cap and the way out', async () => {
    const { resolver, calls, deepId } = manyInstances(2)
    await resolver.resolve(deepId(1))
    await resolver.resolve(deepId(2))
    // Not null, and not a quiet drop: a caller that read this as "no such node"
    // would report a node as missing because the command was busy (B39).
    expect(resolver.resolve(deepId(3))).rejects.toThrow(
      exportBudgetMessage(deepId(3), 2),
    )
    // …and the refusal costs nothing, which is the point of refusing.
    expect(calls.exportOf).toBe(2)
  })

  it('the same message comes from exportedNode, so a read degrades once', async () => {
    const { resolver, deepId } = manyInstances(1)
    await resolver.resolve(deepId(1))
    expect(
      resolver.exportedNode(deepId(2)),
    ).rejects.toThrow(exportBudgetMessage(deepId(2), 1))
  })

  it('an instance already exported is free, however many ids name it', async () => {
    const { resolver, calls, deepId } = manyInstances(1)
    // The budget counts INSTANCES, not ids: one card with 40 broken rows costs
    // one export and must not be refused.
    for (let i = 0; i < 40; i++) {
      expect(
        (await resolver.resolve(deepId(1)))?.id,
      ).toBe('1:7')
    }
    expect(calls.exportOf).toBe(1)
  })

  it('reset restores the budget for the next dispatch', async () => {
    const { resolver, deepId } = manyInstances(1)
    await resolver.resolve(deepId(1))
    expect(resolver.resolve(deepId(2))).rejects.toThrow(
      'per-command budget',
    )
    resolver.reset()
    expect((await resolver.resolve(deepId(2)))?.id).toBe(
      '2:7',
    )
  })

  it('the walk fast path is never budgeted', async () => {
    const { resolver, deepId } = manyInstances(1)
    await resolver.resolve(deepId(1))
    // `2:2` is answered by the walk, so it costs no export and the exhausted
    // budget cannot reach it. A call naming a thousand ordinary sublayers is
    // unaffected by the cap.
    expect((await resolver.resolve('I2:1;2:2'))?.id).toBe(
      'I2:1;2:2',
    )
  })

  it('the default cap is generous enough for a full search page', async () => {
    // `search` hydrates up to limit=50 ids, but only a slot-override id costs
    // an export at all, and the QA run's worst real case was 3 cards.
    expect(MAX_INSTANCE_EXPORTS).toBeGreaterThanOrEqual(25)
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

// ── THE 2026-08-30 FAMILY: B65 / B72 / B73 / B74 ─────────────────────────────
//
// The fixture above stops one INSTANCE short of the shape that broke. The
// 2026-08-30 dashboard nested content FOUR deep through a slot —
//
//   549:17459                                        INSTANCE  "Chart card"
//     I549:17459;549:17078                           SLOT      "Body"
//       I549:17459;549:17078;549:17624               FRAME     "Table"
//         I549:17459;549:17078;549:17625             INSTANCE  "Table row"
//           I549:17459;549:17078;549:17625;549:17265 TEXT      "Amount"
//
// — and at that depth two live handles stand for one address, neither of which
// a WRITE may be handed:
//
//   the ALIAS     `549:17625`. The row answers its pre-append plain id while
//                 sitting inside an INSTANCE, so Figma composes its children
//                 off it and mints `I549:17625;549:17265` — an address that
//                 reads, writes, reads back changed, and is not the rendered
//                 node. `update_node` answered {ok:true, warnings:[]} and ~60
//                 cell writes were lost (B74).
//   the DEAD one  the handle the export pairing puts opposite the canonical id
//                 refuses every property read. Live it answered `in get_parent:
//                 The node … does not exist` on a write (B74), and `in
//                 appendChild: The node I549:17201;549:17145 does not exist` on
//                 a create into a nested SLOT — quoting an id the caller never
//                 sent (B73).
//
// A READ still takes either: the read face serves the node from the ancestor's
// export and declares the degrade. A WRITE takes neither.
const CARD = '549:17459'
const SLOT_C = 'I549:17459;549:17078'
const TABLE_C = 'I549:17459;549:17078;549:17624'
const ROW_C = 'I549:17459;549:17078;549:17625'
const CELL_C = 'I549:17459;549:17078;549:17625;549:17265'
/** What Figma composed off the row's alias — the id the ~60 lost writes used. */
const CELL_ALIAS = 'I549:17625;549:17265'

/** Give every plain node in a live tree the `parent` link a handle carries. */
const linkParents = (root: LiveNode): LiveNode => {
  const walk = (n: LiveNode): void => {
    const kids = n.children as LiveNode[] | undefined
    if (kids === undefined) return
    for (const child of kids) {
      try {
        ;(child as Record<string, unknown>).parent = n
      } catch {
        // An unreadable handle refuses the write as flatly as the read.
      }
      walk(child)
    }
  }
  walk(root)
  return root
}

/** The cell handle paired opposite the canonical id: it refuses everything. */
const CELL_DEAD = unreadable(CELL_ALIAS)

/**
 * The handle B81 is about: it answers its own identity and TYPE, refuses every
 * read Figma has to resolve through an ANCESTOR, and takes a write.
 *
 * OBSERVED, 2026-09-02 read-back census
 * (`runs/2026-09-02-dashboard/readbacks/08-b65-readerrors.json`): on the 51
 * `live-handle-refused-fields` rows the enrichment listed `context`, `the
 * unrotated size`, `style() names` and nine more groups as refused, while
 * `vector geometry` and `text runs` were NOT listed — and both of those groups
 * read `node.type` as their first statement. So `type` answers on this class
 * and `width` / `getSharedPluginData` / `parent` do not.
 *
 * MODELED, NOT OBSERVED: that the SETTER lands. Nothing headless can settle
 * whether Figma resolves a node for a write it refused for a read — that is
 * the dispatcher's live probe 1. This fake takes the write so the resolver can
 * be held to the rule that matters either way: never refuse a handle before
 * the write has been tried, and never ack one that did not land.
 */
const parentRefusing = (
  id: string,
  options: { writable?: boolean } = {},
): LiveNode => {
  const own: Record<string, unknown> = {
    id,
    name: 'Amount',
    type: 'TEXT',
  }
  const refuse = (verb: string, prop: string): never => {
    throw new Error(
      'in ' +
        verb +
        '_' +
        prop +
        ': The node (instance sublayer or table cell) with id "' +
        CELL_ALIAS +
        '" does not exist',
    )
  }
  return new Proxy(own, {
    get: (target, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined
      }
      if (prop in target) return target[prop as string]
      if (
        prop === 'parent' ||
        prop === 'width' ||
        prop === 'height' ||
        prop === 'getSharedPluginData'
      ) {
        refuse('get', String(prop))
      }
      return undefined
    },
    set: (target, prop, value) => {
      if (options.writable === false) {
        refuse('set', String(prop))
      }
      target[prop as string] = value
      return true
    },
    has: () => true,
  })
}

/** The same handle, refusing the write too — the hypothesis's other half. */
const CELL_WRITE_REFUSING = parentRefusing(CELL_ALIAS, {
  writable: false,
})

const deepLive = (): LiveNode =>
  linkParents({
    id: CARD,
    name: 'Chart card',
    type: 'INSTANCE',
    children: [
      {
        id: SLOT_C,
        name: 'Body',
        type: 'SLOT',
        children: [
          {
            // Slot content keeps its pre-append plain id …
            id: '549:17624',
            name: 'Table',
            type: 'FRAME',
            children: [
              {
                // … and so does the INSTANCE inside it. THIS is the alias.
                id: '549:17625',
                name: 'Table row',
                type: 'INSTANCE',
                children: [
                  // The GHOST: it answers the 2-segment address, reads back
                  // what was written to it, and is not what renders.
                  {
                    id: CELL_ALIAS,
                    name: 'Amount',
                    type: 'TEXT',
                    characters: '940,000 USDC',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  })

/** The same card as the FILE describes it — the oracle, and it is unchanged. */
const deepExport = (): RawNode => ({
  id: CARD,
  name: 'Chart card',
  type: 'INSTANCE',
  children: [
    {
      id: SLOT_C,
      name: 'Body',
      type: 'SLOT',
      children: [
        {
          id: TABLE_C,
          name: 'Table',
          type: 'FRAME',
          children: [
            {
              id: ROW_C,
              name: 'Table row',
              type: 'INSTANCE',
              children: [
                {
                  id: CELL_C,
                  name: 'Amount',
                  type: 'TEXT',
                  characters: '1,412.4 ETH',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
})

/** A resolver over the deep fixture; `dead` swaps the ghost for a refusal. */
const deepHarness = (
  options: { dead?: boolean; parentless?: LiveNode } = {},
) => {
  const root = deepLive()
  const doc = deepExport()
  if (options.dead === true) {
    const row = findLiveById(root, '549:17625') as LiveNode
    ;(row.children as LiveNode[])[0] = CELL_DEAD
  }
  if (options.parentless !== undefined) {
    const row = findLiveById(root, '549:17625') as LiveNode
    ;(row.children as LiveNode[])[0] = options.parentless
  }
  const resolver = createNodeResolver({
    getNodeById: async id => {
      if (id === CARD) return root
      if (id === '549:17625') {
        return findLiveById(root, '549:17625') ?? null
      }
      return null
    },
    exportOf: async () => doc,
  })
  return { resolver, root, doc }
}

describe('outerInstanceOf / isAliasHandle — an alias is a fact about ancestry', () => {
  it('names the OUTERMOST instance a handle sits inside', () => {
    const row = findLiveById(
      deepLive(),
      '549:17625',
    ) as LiveNode
    expect(outerInstanceOf(row)).toBe(CARD)
  })

  it('a plain id inside an INSTANCE is an ALIAS — Figma composes ids off it', () => {
    const row = findLiveById(
      deepLive(),
      '549:17625',
    ) as LiveNode
    expect(isAliasHandle(row)).toBe(true)
  })

  it('a page-root INSTANCE is not an alias, however deep its subtree', () => {
    expect(isAliasHandle(deepLive())).toBe(false)
  })

  it('a master-derived compound id is not an alias', () => {
    expect(
      isAliasHandle(
        findLiveById(deepLive(), SLOT_C) as LiveNode,
      ),
    ).toBe(false)
  })

  it('a handle that refuses its own reads is never called an alias', () => {
    // It refuses `parent` too, so ancestry is unknowable — and unknown must
    // not read as clean.
    expect(isAliasHandle(CELL_DEAD)).toBe(false)
  })
})

describe('handleAnswers — a handle that answers NOTHING (B81)', () => {
  it('a live handle answers', () => {
    expect(handleAnswers(deepLive())).toBe(true)
  })

  it('a handle that refuses even its own type is dead', () => {
    expect(handleAnswers(CELL_DEAD)).toBe(false)
  })

  it('a handle that refuses only its ANCESTRY still answers', () => {
    // B81 — this is the class the old `.parent` probe rejected. `parent` is a
    // fact about the chain above the node; a write touches the node.
    expect(handleAnswers(parentRefusing(CELL_ALIAS))).toBe(
      true,
    )
  })
})

describe('parentAnswers — advisory, never a write gate (B81)', () => {
  it('a healthy handle answers its parent', () => {
    expect(
      parentAnswers(
        findLiveById(deepLive(), '549:17625') as LiveNode,
      ),
    ).toBe(true)
  })

  it('the B74 signature refuses it', () => {
    expect(parentAnswers(CELL_DEAD)).toBe(false)
  })

  it('so does the handle that answers everything else', () => {
    expect(parentAnswers(parentRefusing(CELL_ALIAS))).toBe(
      false,
    )
  })
})

describe('staleHandleThrow / restatedRefusal — the id a caller can use', () => {
  const figmaThrow = new Error(
    'in set_layoutMode: The node (instance sublayer or table cell) with id ' +
      '"I571:32063;571:32007" does not exist',
  )

  it('recognises Figma’s own stale-handle throw', () => {
    expect(staleHandleThrow(figmaThrow)).toBe(true)
  })

  it('does not claim an unrelated failure', () => {
    expect(
      staleHandleThrow(new Error('Unsupported node type')),
    ).toBe(false)
  })

  it('restates it against the id the CALLER sent', () => {
    // Figma quotes the 2-segment address it composed off a pre-append id, and
    // that address resolves to nothing (69 such rows, 2026-09-02). The caller
    // gets our sentence, naming its own id and the way out.
    expect(restatedRefusal(figmaThrow, [CELL_C])).toBe(
      deadHandleMessage(CELL_C),
    )
  })

  it('leaves the throw alone when no id was provisional', () => {
    expect(restatedRefusal(figmaThrow, [])).toBeUndefined()
  })

  it('leaves an unrelated throw alone', () => {
    expect(
      restatedRefusal(
        new Error('Unsupported node type'),
        [CELL_C],
      ),
    ).toBeUndefined()
  })
})

describe('the write face refuses what it cannot address (B73/B74)', () => {
  it('READ mode still resolves the alias-derived address, as it always did', async () => {
    const { resolver } = deepHarness()
    expect((await resolver.resolve(CELL_ALIAS))?.name).toBe(
      'Amount',
    )
  })

  it('WRITE mode refuses the 2-segment ghost instead of acking onto it', async () => {
    const { resolver } = deepHarness()
    resolver.setStrict(true)
    expect(resolver.resolve(CELL_ALIAS)).rejects.toThrow(
      aliasAddressMessage(CELL_ALIAS, '549:17625', CARD),
    )
  })

  it('the refusal names the caller’s id, the alias and the way out', () => {
    const message = aliasAddressMessage(
      CELL_ALIAS,
      '549:17625',
      CARD,
    )
    expect(message).toContain(CELL_ALIAS)
    expect(message).toContain('549:17625')
    expect(message).toContain(CARD)
  })

  it('WRITE mode refuses a canonical id whose handle answers NOTHING', async () => {
    const { resolver } = deepHarness({ dead: true })
    resolver.setStrict(true)
    expect(resolver.resolve(CELL_C)).rejects.toThrow(
      deadHandleMessage(CELL_C),
    )
  })

  it('WRITE mode HANDS BACK a handle that only refuses its ancestry (B81)', async () => {
    // The top row. 48 live refusals in one build forced every slot to be
    // built-then-reparented and the app shell flattened — for a handle the
    // probe never asked to take a write. A refusal has to be earned by a
    // write that did not land, not by a `.parent` that would not read.
    const { resolver } = deepHarness({
      parentless: parentRefusing(CELL_ALIAS),
    })
    resolver.setStrict(true)
    expect((await resolver.resolve(CELL_C))?.name).toBe(
      'Amount',
    )
  })

  it('…and NAMES it provisional, so the write face can restate a refusal', async () => {
    const { resolver } = deepHarness({
      parentless: parentRefusing(CELL_ALIAS),
    })
    resolver.setStrict(true)
    await resolver.resolve(CELL_C)
    expect(resolver.provisionalIds()).toEqual([CELL_C])
  })

  it('a handle that refuses the WRITE is still refused — in OUR words', async () => {
    // The other half of the hypothesis. Figma throws quoting the composed
    // 2-segment address; the caller is handed the id it sent instead.
    const { resolver } = deepHarness({
      parentless: CELL_WRITE_REFUSING,
    })
    resolver.setStrict(true)
    const handle = (await resolver.resolve(
      CELL_C,
    )) as LiveNode
    let thrown: unknown
    try {
      ;(handle as Record<string, unknown>).layoutMode = 'H'
    } catch (err) {
      thrown = err
    }
    expect(
      restatedRefusal(thrown, resolver.provisionalIds()),
    ).toBe(deadHandleMessage(CELL_C))
  })

  it('a healthy write names no provisional id at all', async () => {
    const { resolver } = deepHarness()
    resolver.setStrict(true)
    await resolver.resolve(SLOT_C)
    expect(resolver.provisionalIds()).toEqual([])
  })

  it('reset() drops the provisional list with the exports', async () => {
    const { resolver } = deepHarness({
      parentless: parentRefusing(CELL_ALIAS),
    })
    resolver.setStrict(true)
    await resolver.resolve(CELL_C)
    resolver.reset()
    expect(resolver.provisionalIds()).toEqual([])
  })

  it('READ mode still hands the dead handle back, so the slice can degrade', async () => {
    const { resolver } = deepHarness({ dead: true })
    expect(await resolver.resolve(CELL_C)).toBe(CELL_DEAD)
  })

  it('WRITE mode leaves an ordinary compound id alone', async () => {
    const { resolver } = deepHarness()
    resolver.setStrict(true)
    expect((await resolver.resolve(SLOT_C))?.name).toBe(
      'Body',
    )
  })

  it('WRITE mode leaves a plain page-root id alone', async () => {
    const { resolver } = deepHarness()
    resolver.setStrict(true)
    expect((await resolver.resolve(CARD))?.name).toBe(
      'Chart card',
    )
  })

  it('WRITE mode still answers "no such node" for an id nothing names', async () => {
    const { resolver } = deepHarness()
    resolver.setStrict(true)
    // A refusal is not a miss and a miss is not a refusal (B39).
    expect(
      await resolver.resolve('I549:17459;9:99'),
    ).toBeNull()
  })

  it('the phantom is still READABLE — the refusal is the write face only', async () => {
    // Law: a read may serve an id a write refuses. Reads have an export to fall
    // back on and a `readError` to declare with; a write has neither.
    const { resolver } = deepHarness()
    expect(
      (await resolver.resolve(CELL_ALIAS))?.name,
    ).toBe('Amount')
  })

  it('reset returns the resolver to READ mode', async () => {
    const { resolver } = deepHarness()
    resolver.setStrict(true)
    resolver.reset()
    expect((await resolver.resolve(CELL_ALIAS))?.name).toBe(
      'Amount',
    )
  })
})

// ── B78: an enumeration that drops what addressing finds ─────────────────────
//
// `get_node depth:1` on the Overview chart's Plot listed the gridlines, the
// fill, the axes and the ticks and SKIPPED `Treasury line`
// (`I549:17448;549:17078;549:17513`) — while a direct `get_node` on that id
// answered it in full. Two oracles disagreeing: the parent was described by the
// ancestor's export, the child by the alias handle's own export, which is a
// different document rooted at a different id.
//
// Same family as B72/B74, and the same rule closes it: the export that NAMED a
// node is the one that describes it.
describe('servedByAncestorExport — one node, one oracle', () => {
  it('a handle answering a DIFFERENT id does not describe itself', () => {
    const row = findLiveById(
      deepLive(),
      '549:17625',
    ) as LiveNode
    // The caller asked for the canonical id; the handle answers the alias.
    expect(servedByAncestorExport(ROW_C, row)).toBe(true)
  })

  it('a handle answering the caller’s own id is its own oracle', () => {
    const slot = findLiveById(
      deepLive(),
      SLOT_C,
    ) as LiveNode
    expect(servedByAncestorExport(SLOT_C, slot)).toBe(false)
  })

  it('a PLAIN id is always its own oracle — nothing renamed it', () => {
    // A page-root instance answers its own id and has no ancestor export to
    // prefer; routing it to a slice would buy an export for nothing.
    expect(servedByAncestorExport(CARD, deepLive())).toBe(
      false,
    )
  })

  it('a miss is not routed anywhere', () => {
    expect(servedByAncestorExport(CELL_C, null)).toBe(false)
  })

  it('a handle that cannot state its id is served by the ancestor', () => {
    // `idOf` answers undefined for a refusing handle, which is never the
    // caller's id — so the export speaks, which is what it already did.
    expect(servedByAncestorExport(CELL_C, CELL_DEAD)).toBe(
      true,
    )
  })

  it('the ancestor export carries the child an alias export could drop', async () => {
    // The property B78 is about, end to end: what the ancestor's export says a
    // node's children are is what a read of that node has to return.
    const { resolver } = deepHarness()
    const row = await resolver.exportedNode(ROW_C)
    expect(
      (row?.children as RawNode[]).map(c => c.id),
    ).toEqual([CELL_C])
    // …and the id it comes back under is the one the caller asked for.
    expect(row?.id).toBe(ROW_C)
  })

  it('the TABLE level too — the disagreement is not depth-specific', async () => {
    const { resolver } = deepHarness()
    const table = await resolver.exportedNode(TABLE_C)
    expect(
      (table?.children as RawNode[]).map(c => c.id),
    ).toEqual([ROW_C])
  })
})
