// enrich-nodes.test.ts — B23: every field the export ROOT gets, a descendant
// within `depth` gets too, and nothing past `depth` is paid for.
//
// The bug this suite pins: enrichment used to land only on the top-level
// `doc`, so a STAR read at depth 0 carried `pointCount` and the same STAR read
// as a child at depth 1 did not — and a mixed-run TEXT child positively
// reported a single font it does not have.

import { describe, expect, it } from 'bun:test'
import {
  applyPatches,
  collectPatches,
  enrichDocument,
  nodesWithin,
  styleIdsOf,
  syncPatch,
  variableIdsOf,
  type LiveNode,
} from './enrich-nodes'

// Stands in for figma.mixed, which is a Symbol at runtime.
const MIXED = Symbol('figma.mixed')

const deps = (
  over: Partial<{
    getStyleName: (
      id: string,
    ) => Promise<string | undefined>
    getVariableName: (
      id: string,
    ) => Promise<string | undefined>
  }> = {},
) => ({ mixed: MIXED, ...over })

/** A live node stand-in: only the properties a real one would expose. */
const node = (
  props: Record<string, unknown>,
  children: LiveNode[] = [],
): LiveNode =>
  children.length > 0
    ? { ...props, children }
    : { ...props }

const star = (id: string): LiveNode =>
  node({
    id,
    type: 'STAR',
    pointCount: 7,
    innerRadius: 0.4,
    width: 100,
    height: 80,
  })

const vector = (id: string): LiveNode =>
  node({
    id,
    type: 'VECTOR',
    width: 24,
    height: 24,
    vectorPaths: [
      { windingRule: 'NONZERO', data: 'M 0 0' },
    ],
    vectorNetwork: {
      vertices: [{ cornerRadius: 4 }, { cornerRadius: 0 }],
    },
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
  })

/** A TEXT whose two segments carry different fonts. */
const mixedText = (id: string): LiveNode =>
  node({
    id,
    type: 'TEXT',
    width: 200,
    height: 20,
    getStyledTextSegments: () => [
      {
        start: 0,
        end: 5,
        fontName: { family: 'Inter', style: 'Regular' },
        fontSize: 16,
      },
      {
        start: 5,
        end: 9,
        fontName: { family: 'Inter', style: 'Bold' },
        fontSize: 16,
      },
    ],
  })

describe('nodesWithin — the depth bound', () => {
  const tree = node({ id: 'a', type: 'FRAME' }, [
    node({ id: 'b', type: 'FRAME' }, [
      node({ id: 'c', type: 'RECTANGLE' }),
    ]),
  ])

  it('depth 0 is the root alone', () => {
    expect(nodesWithin(tree, 0).map(n => n.id)).toEqual([
      'a',
    ])
  })

  it('depth 1 is the root plus one level', () => {
    expect(nodesWithin(tree, 1).map(n => n.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('depth -1 is every level', () => {
    expect(nodesWithin(tree, -1).map(n => n.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('a childless node ends the walk', () => {
    expect(
      nodesWithin(node({ id: 'x', type: 'STAR' }), -1),
    ).toHaveLength(1)
  })
})

describe('syncPatch — the fields REST cannot carry', () => {
  it('carries pointCount / innerRadius / size for a STAR', () => {
    expect(syncPatch(star('1:1'), MIXED)).toMatchObject({
      pointCount: 7,
      innerRadius: 0.4,
      width: 100,
      height: 80,
    })
  })

  it('carries vector geometry AND its per-point channel', () => {
    const patch = syncPatch(vector('1:2'), MIXED)
    expect(patch.vectorPaths).toEqual([
      { windingRule: 'NONZERO', data: 'M 0 0' },
    ])
    expect(patch.vectorCorners).toEqual({ 0: 4 })
  })

  it('drops a mixed strokeJoin rather than putting a Symbol on the wire', () => {
    const patch = syncPatch(
      node({
        id: '1:3',
        type: 'VECTOR',
        strokeJoin: MIXED,
        vectorPaths: [],
        vectorNetwork: { vertices: [] },
      }),
      MIXED,
    )
    expect('strokeJoin' in patch).toBe(false)
    expect(
      Object.values(patch).some(v => typeof v === 'symbol'),
    ).toBe(false)
  })

  it('projects the runs of a mixed-run TEXT', () => {
    const patch = syncPatch(mixedText('1:4'), MIXED)
    const runs = patch.runs as { at: number[] }[]
    expect(runs).toHaveLength(2)
    expect(runs[1].at).toEqual([5, 9])
  })

  it('adds nothing for a single-style TEXT — an ordinary read is unchanged', () => {
    const patch = syncPatch(
      node({
        id: '1:5',
        type: 'TEXT',
        getStyledTextSegments: () => [
          { start: 0, end: 4, fontSize: 16 },
        ],
      }),
      MIXED,
    )
    expect('runs' in patch).toBe(false)
  })

  it('reads context off the node itself', () => {
    const patch = syncPatch(
      node({
        id: '1:6',
        type: 'FRAME',
        getSharedPluginData: (ns: string, key: string) =>
          ns === 'figmabridge' && key === 'context'
            ? 'a pricing card'
            : '',
      }),
      MIXED,
    )
    expect(patch.context).toBe('a pricing card')
  })

  it('omits isMask on an unmasked node and names the type on a masked one', () => {
    expect(
      'isMask' in
        syncPatch(
          node({
            id: 'a',
            type: 'RECTANGLE',
            isMask: false,
          }),
          MIXED,
        ),
    ).toBe(false)
    expect(
      syncPatch(
        node({
          id: 'b',
          type: 'RECTANGLE',
          isMask: true,
          maskType: 'LUMINANCE',
        }),
        MIXED,
      ),
    ).toMatchObject({ isMask: true, maskType: 'LUMINANCE' })
  })

  it('omits an empty explicitVariableModes / componentPropertyReferences', () => {
    const patch = syncPatch(
      node({
        id: 'c',
        type: 'FRAME',
        explicitVariableModes: {},
        componentPropertyReferences: null,
      }),
      MIXED,
    )
    expect('explicitVariableModes' in patch).toBe(false)
    expect('componentPropertyReferences' in patch).toBe(
      false,
    )
  })

  it('carries the GRID keys and componentPropertyReferences when set', () => {
    expect(
      syncPatch(
        node({
          id: 'd',
          type: 'FRAME',
          gridRowCount: 2,
          gridColumnCount: 3,
          gridRowGap: 8,
          gridColumnGap: 12,
          componentPropertyReferences: {
            characters: 'Label#1:0',
          },
          explicitVariableModes: {
            'VariableCollectionId:1': '2',
          },
        }),
        MIXED,
      ),
    ).toMatchObject({
      gridRowCount: 2,
      gridColumnCount: 3,
      gridRowGap: 8,
      gridColumnGap: 12,
      componentPropertyReferences: {
        characters: 'Label#1:0',
      },
      explicitVariableModes: {
        'VariableCollectionId:1': '2',
      },
    })
  })
})

describe('styleIdsOf / variableIdsOf', () => {
  it('maps each bound styleId to its grammar field, skipping the empty ones', () => {
    expect(
      styleIdsOf({
        fillStyleId: 'S:fill',
        strokeStyleId: '',
        textStyleId: 'S:text',
      }),
    ).toEqual({ fill: 'S:fill', text: 'S:text' })
  })

  it('dedupes the ids a node binds, across scalar and array fields', () => {
    expect(
      variableIdsOf({
        boundVariables: {
          topLeftRadius: {
            id: 'V:1',
            type: 'VARIABLE_ALIAS',
          },
          bottomLeftRadius: {
            id: 'V:1',
            type: 'VARIABLE_ALIAS',
          },
          fills: [{ id: 'V:2', type: 'VARIABLE_ALIAS' }],
        },
      }),
    ).toEqual(['V:1', 'V:2'])
  })

  it('is empty for a node with no bindings', () => {
    expect(variableIdsOf({ id: 'x' })).toEqual([])
  })
})

describe('collectPatches — the async halves, batched', () => {
  it('resolves each distinct token ONCE, not once per bound field', async () => {
    const asked: string[] = []
    const root = node(
      {
        id: 'root',
        type: 'FRAME',
        boundVariables: {
          topLeftRadius: {
            id: 'V:1',
            type: 'VARIABLE_ALIAS',
          },
        },
      },
      [
        node({
          id: 'kid-a',
          type: 'RECTANGLE',
          boundVariables: {
            fills: [{ id: 'V:1', type: 'VARIABLE_ALIAS' }],
            topLeftRadius: {
              id: 'V:1',
              type: 'VARIABLE_ALIAS',
            },
          },
        }),
        node({
          id: 'kid-b',
          type: 'RECTANGLE',
          boundVariables: {
            fills: [{ id: 'V:1', type: 'VARIABLE_ALIAS' }],
          },
        }),
      ],
    )
    const patches = await collectPatches(
      root,
      -1,
      deps({
        getVariableName: async id => {
          asked.push(id)
          return 'brand/accent'
        },
      }),
    )
    // Four bound fields across three nodes, one distinct id, one lookup.
    expect(asked).toEqual(['V:1'])
    // …and every node that binds it still names it.
    for (const id of ['root', 'kid-a', 'kid-b']) {
      expect(patches.get(id)?.bindingNames).toEqual({
        variables: { 'V:1': 'brand/accent' },
      })
    }
  })

  it('gives a DESCENDANT its own style name — never the flattened literal', async () => {
    const root = node({ id: 'root', type: 'FRAME' }, [
      node({
        id: 'kid',
        type: 'RECTANGLE',
        fillStyleId: 'S:abc',
      }),
    ])
    const patches = await collectPatches(
      root,
      1,
      deps({ getStyleName: async () => 'Brand/Primary' }),
    )
    expect(patches.get('kid')?.bindingNames).toEqual({
      styles: { fill: 'Brand/Primary' },
    })
    expect(patches.has('root')).toBe(false)
  })

  it('gives a DESCENDANT instance its component.key', async () => {
    const root = node({ id: 'root', type: 'FRAME' }, [
      node({
        id: 'kid',
        type: 'INSTANCE',
        getMainComponentAsync: async () => ({
          key: 'abc123',
          remote: true,
        }),
      }),
    ])
    const patches = await collectPatches(root, 1, deps())
    expect(patches.get('kid')).toMatchObject({
      componentKey: 'abc123',
      componentRemote: true,
    })
  })

  it('survives a resolver that rejects — one odd id never loses the read', async () => {
    const root = node({
      id: 'root',
      type: 'RECTANGLE',
      fillStyleId: 'S:gone',
      pointCount: 5,
    })
    const patches = await collectPatches(
      root,
      0,
      deps({
        getStyleName: async () => {
          throw new Error('deleted')
        },
      }),
    )
    expect(patches.get('root')).toMatchObject({
      pointCount: 5,
    })
    expect('bindingNames' in patches.get('root')!).toBe(
      false,
    )
  })

  it('omits a resolver entirely when the runtime lacks the API (T7)', async () => {
    const patches = await collectPatches(
      node({
        id: 'root',
        type: 'RECTANGLE',
        fillStyleId: 'S:abc',
      }),
      0,
      deps(),
    )
    expect(patches.has('root')).toBe(false)
  })

  it('stops at the requested depth — a node past it is never touched', async () => {
    let asked = 0
    const root = node({ id: 'root', type: 'FRAME' }, [
      node({ id: 'kid', type: 'FRAME' }, [
        node({
          id: 'grandkid',
          type: 'RECTANGLE',
          fillStyleId: 'S:deep',
        }),
      ]),
    ])
    const patches = await collectPatches(
      root,
      1,
      deps({
        getStyleName: async () => {
          asked += 1
          return 'Brand/Primary'
        },
      }),
    )
    expect(patches.has('grandkid')).toBe(false)
    expect(asked).toBe(0)
  })
})

describe('applyPatches / enrichDocument — merge by id', () => {
  it('merges each patch onto the exported node with the matching id', () => {
    const doc: Record<string, unknown> = {
      id: 'root',
      type: 'FRAME',
      children: [{ id: 'kid', type: 'STAR' }],
    }
    applyPatches(
      doc,
      new Map([['kid', { pointCount: 7 }]]),
      1,
    )
    expect(
      (doc.children as Record<string, unknown>[])[0],
    ).toMatchObject({ pointCount: 7 })
  })

  it('leaves an exported node with no patch untouched', () => {
    const doc: Record<string, unknown> = {
      id: 'root',
      type: 'FRAME',
      children: [{ id: 'kid', type: 'RECTANGLE' }],
    }
    const before = JSON.stringify(doc)
    applyPatches(doc, new Map(), 1)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('B23 end to end: a descendant reads exactly as it does as a root', async () => {
    const live = node({ id: 'frame', type: 'FRAME' }, [
      star('kid-star'),
      vector('kid-vector'),
      mixedText('kid-text'),
    ])
    const doc: Record<string, unknown> = {
      id: 'frame',
      type: 'FRAME',
      children: [
        { id: 'kid-star', type: 'STAR' },
        { id: 'kid-vector', type: 'VECTOR' },
        { id: 'kid-text', type: 'TEXT' },
      ],
    }
    await enrichDocument(live, doc, 1, deps())
    const [asStar, asVector, asText] =
      doc.children as Record<string, unknown>[]

    // Each child, read directly at depth 0, for comparison.
    const alone = async (n: LiveNode) => {
      const solo: Record<string, unknown> = {
        id: n.id,
        type: n.type,
      }
      await enrichDocument(n, solo, 0, deps())
      return solo
    }
    expect(asStar).toEqual(await alone(star('kid-star')))
    expect(asVector).toEqual(
      await alone(vector('kid-vector')),
    )
    expect(asText).toEqual(
      await alone(mixedText('kid-text')),
    )

    // …and the fields the bug named are actually there.
    expect(asStar.pointCount).toBe(7)
    expect(asStar.innerRadius).toBe(0.4)
    expect(asVector.vectorPaths).toBeDefined()
    expect(asText.runs).toHaveLength(2)
  })

  it('does not grow an ordinary node that has none of this', async () => {
    const doc: Record<string, unknown> = {
      id: 'plain',
      type: 'RECTANGLE',
      children: [{ id: 'kid', type: 'RECTANGLE' }],
    }
    const before = JSON.stringify(doc)
    await enrichDocument(
      node({ id: 'plain', type: 'RECTANGLE' }, [
        node({ id: 'kid', type: 'RECTANGLE' }),
      ]),
      doc,
      -1,
      deps(),
    )
    expect(JSON.stringify(doc)).toBe(before)
  })
})
