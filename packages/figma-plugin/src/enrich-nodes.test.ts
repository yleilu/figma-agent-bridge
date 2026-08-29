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

  // B27 — per-side stroke weights. The node's own `strokeWeight` is
  // figma.mixed exactly when the four sides disagree, so the uniform field
  // cannot describe a divider; the four sides can, and only they cross.
  it('carries the four per-side stroke weights when they DIFFER', () => {
    const patch = syncPatch(
      node({
        id: '1:3b',
        type: 'FRAME',
        strokeWeight: MIXED,
        strokeTopWeight: 0,
        strokeRightWeight: 0,
        strokeBottomWeight: 1,
        strokeLeftWeight: 0,
      }),
      MIXED,
    )
    expect(patch).toMatchObject({
      strokeTopWeight: 0,
      strokeRightWeight: 0,
      strokeBottomWeight: 1,
      strokeLeftWeight: 0,
    })
    expect(
      Object.values(patch).some(v => typeof v === 'symbol'),
    ).toBe(false)
  })

  it('adds nothing when the four sides are EQUAL — the uniform weight already says it', () => {
    const patch = syncPatch(
      node({
        id: '1:3c',
        type: 'FRAME',
        strokeWeight: 2,
        strokeTopWeight: 2,
        strokeRightWeight: 2,
        strokeBottomWeight: 2,
        strokeLeftWeight: 2,
      }),
      MIXED,
    )
    expect('strokeTopWeight' in patch).toBe(false)
  })

  it('adds nothing for a node type without per-side support', () => {
    const patch = syncPatch(
      node({
        id: '1:3d',
        type: 'ELLIPSE',
        strokeWeight: 1,
      }),
      MIXED,
    )
    expect('strokeTopWeight' in patch).toBe(false)
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

  // B44 — JSON_REST_V1 carries no layout binding, so a live `itemSpacing`
  // bind read back as a bare number and the token was invisible. Only the ids
  // travel; the reader turns them into the `var()` names it emits.
  it('ships which variable each bindable LAYOUT field is bound to', () => {
    const patch = syncPatch(
      node({
        id: 'row',
        type: 'FRAME',
        boundVariables: {
          itemSpacing: {
            type: 'VARIABLE_ALIAS',
            id: 'V:space8',
          },
          paddingTop: {
            type: 'VARIABLE_ALIAS',
            id: 'V:space8',
          },
          gridRowGap: {
            type: 'VARIABLE_ALIAS',
            id: 'V:space16',
          },
          // Not a layout field — it rides the paint wrapper's own channel.
          fills: [
            { type: 'VARIABLE_ALIAS', id: 'V:brand' },
          ],
        },
      }),
      MIXED,
    )
    expect(patch.layoutBoundVariables).toEqual({
      itemSpacing: 'V:space8',
      paddingTop: 'V:space8',
      gridRowGap: 'V:space16',
    })
  })

  it('omits layoutBoundVariables when no layout field is bound', () => {
    const patch = syncPatch(
      node({
        id: 'row',
        type: 'FRAME',
        boundVariables: {
          fills: [
            { type: 'VARIABLE_ALIAS', id: 'V:brand' },
          ],
        },
      }),
      MIXED,
    )
    expect('layoutBoundVariables' in patch).toBe(false)
  })

  // B54 — the four auto-layout size clamps. `update_node` writes them and the
  // layout honours them, but no read channel carried them, so an agent could
  // only infer a floor from its geometric effect. They ride the live patch
  // because the export does not always carry them.
  it('ships the min/max size clamps a write set', () => {
    const patch = syncPatch(
      node({
        id: 'card',
        type: 'FRAME',
        minWidth: 100,
        maxWidth: 400,
        minHeight: 240,
        maxHeight: null,
      }),
      MIXED,
    )
    expect(patch.minWidth).toBe(100)
    expect(patch.maxWidth).toBe(400)
    expect(patch.minHeight).toBe(240)
    // A cleared clamp reads null. Shipping it would put a null key on every
    // frame in a read for no information — the absence already says "no
    // ceiling".
    expect('maxHeight' in patch).toBe(false)
  })

  it('omits all four on a node that carries none', () => {
    const patch = syncPatch(
      node({ id: 'plain', type: 'RECTANGLE' }),
      MIXED,
    )
    expect('minWidth' in patch).toBe(false)
    expect('maxWidth' in patch).toBe(false)
    expect('minHeight' in patch).toBe(false)
    expect('maxHeight' in patch).toBe(false)
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

  // All FIVE slots Figma has (B47). A grid style owns `grids` exactly as a
  // paint style owns `fills`, and a read that could not see gridStyleId
  // reported a styled field as a plain list of literals.
  it('maps gridStyleId — the fifth slot — to the grid field', () => {
    expect(
      styleIdsOf({
        gridStyleId: 'S:grid',
        effectStyleId: 'S:effect',
      }),
    ).toEqual({ grid: 'S:grid', effect: 'S:effect' })
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
      undefined,
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
      undefined,
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
    const patches = await collectPatches(
      root,
      undefined,
      1,
      deps(),
    )
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
      undefined,
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
      undefined,
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
      undefined,
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

describe('collectPatches — one bad node costs one node (B31)', () => {
  // The live failure, verbatim: a node created inside a component SLOT keeps a
  // stale creation-id, and every property read on it throws. ONE such node
  // inside a 978 KB read used to return 151 bytes of PLUGIN_ERROR.
  const STALE =
    'in getSharedPluginData: The node (instance sublayer or table cell) with id "I3:1;4:5;6:7" does not exist'

  /** A node that no longer resolves: reading its context throws. */
  const unreadable = (id: string): LiveNode =>
    node({
      id,
      type: 'FRAME',
      getSharedPluginData: () => {
        throw new Error(STALE)
      },
    })

  it('names the failure on the throwing node and returns its siblings whole', async () => {
    const root = node({ id: 'root', type: 'FRAME' }, [
      star('good-before'),
      unreadable('gone'),
      star('good-after'),
    ])

    const patches = await collectPatches(
      root,
      undefined,
      -1,
      deps(),
    )

    expect(patches.get('gone')?.readError).toContain(STALE)
    for (const id of ['good-before', 'good-after']) {
      expect(patches.get(id)).toMatchObject({
        pointCount: 7,
        innerRadius: 0.4,
      })
      expect('readError' in patches.get(id)!).toBe(false)
    }
  })

  it('survives a node that throws in the ASYNC half too', async () => {
    const root = node({ id: 'root', type: 'FRAME' }, [
      node({
        id: 'stale-instance',
        type: 'INSTANCE',
        // Throws SYNCHRONOUSLY, as an unreachable node does — there is no
        // promise to reject, so a .catch() on the result never runs.
        getMainComponentAsync: () => {
          throw new Error(STALE)
        },
      }),
      node({
        id: 'live-instance',
        type: 'INSTANCE',
        getMainComponentAsync: async () => ({
          key: 'abc123',
          remote: false,
        }),
      }),
    ])

    const patches = await collectPatches(
      root,
      undefined,
      -1,
      deps(),
    )

    expect(
      patches.get('stale-instance')?.readError,
    ).toContain(STALE)
    expect(patches.get('live-instance')).toMatchObject({
      componentKey: 'abc123',
    })
  })

  it('survives a node whose CHILDREN cannot be listed, and says so on that node', async () => {
    const broken: LiveNode = {
      id: 'no-children',
      type: 'FRAME',
      width: 10,
      height: 10,
    }
    Object.defineProperty(broken, 'children', {
      get() {
        throw new Error(
          'in get_children: The node with id "I3:1;4:5" does not exist',
        )
      },
      enumerable: true,
      configurable: true,
    })
    const root = node({ id: 'root', type: 'FRAME' }, [
      broken,
      star('sibling'),
    ])

    const patches = await collectPatches(
      root,
      undefined,
      -1,
      deps(),
    )

    expect(patches.get('no-children')).toMatchObject({
      width: 10,
    })
    expect(patches.get('no-children')?.readError).toContain(
      'in get_children',
    )
    expect(patches.get('sibling')?.pointCount).toBe(7)
  })

  it('a resolver that throws SYNCHRONOUSLY still loses only its own name', async () => {
    const patches = await collectPatches(
      node({
        id: 'root',
        type: 'RECTANGLE',
        fillStyleId: 'S:gone',
        pointCount: 5,
      }),
      undefined,
      0,
      deps({
        getStyleName: (() => {
          throw new Error('deleted')
        }) as unknown as (
          id: string,
        ) => Promise<string | undefined>,
      }),
    )
    expect(patches.get('root')).toMatchObject({
      pointCount: 5,
    })
    expect('bindingNames' in patches.get('root')!).toBe(
      false,
    )
    // …and the lost name is declared, not passed off as an unstyled node
    // (B41). The resolver EXISTS here — it is one id it could not answer.
    expect(patches.get('root')?.readError).toContain('fill')
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

  // B31 round 2, live-caught: the walk and the export key the SAME node by
  // DIFFERENT ids — the walk sees the stale slot handle, the export names the
  // canonical ancestor chain — so the patch matches nothing and the failure
  // used to vanish at the merge, after being caught correctly.
  it('reports a failure it cannot attach on the ROOT as readErrors', () => {
    const doc: Record<string, unknown> = {
      id: 'root',
      type: 'FRAME',
      children: [{ id: 'kid', type: 'STAR' }],
    }
    applyPatches(
      doc,
      new Map([
        ['kid', { pointCount: 7 }],
        [
          'I<stale>;6:7',
          {
            readError:
              'Error: in getSharedPluginData: The node (instance sublayer or table cell) with id "I<stale>;6:7" does not exist',
          },
        ],
      ]),
      1,
    )
    const errors = doc.readErrors as string[]
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('I<stale>;6:7: ')
    expect(errors[0]).toContain('does not exist')
    // The sibling that DID match still merged.
    expect(
      (doc.children as Record<string, unknown>[])[0],
    ).toMatchObject({ pointCount: 7 })
  })

  it('does NOT invent readErrors for a clean patch that finds no home', () => {
    const doc: Record<string, unknown> = {
      id: 'root',
      type: 'FRAME',
    }
    applyPatches(
      doc,
      new Map([['nowhere', { pointCount: 7 }]]),
      -1,
    )
    expect('readErrors' in doc).toBe(false)
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

  // B23 two levels down, which is where a real read lives: an agent inspects a
  // screen and gets the frame, its cards, and the sublayers inside them. The
  // GRANDCHILD is the node the fix is about — it is served in full, so it owes
  // the caller both the geometry REST drops and the variable NAME only the live
  // handle can resolve. The level past `depth` owes nothing: it collapses to a
  // stub server-side, so a lookup for it is a token spent on a node nobody sees.
  it('reaches a GRANDCHILD at depth 2 — and stops one level later', async () => {
    const asked: string[] = []
    const bound = (id: string, kids: LiveNode[] = []) =>
      node(
        {
          id,
          type: 'VECTOR',
          width: 24,
          height: 24,
          vectorPaths: [
            { windingRule: 'NONZERO', data: 'M 0 0' },
          ],
          vectorNetwork: { vertices: [] },
          boundVariables: {
            fills: [{ id: 'V:9', type: 'VARIABLE_ALIAS' }],
          },
        },
        kids,
      )
    const live = node({ id: 'screen', type: 'FRAME' }, [
      node({ id: 'card', type: 'INSTANCE' }, [
        bound('I card;icon', [bound('I card;glyph')]),
      ]),
    ])
    const doc: Record<string, unknown> = {
      id: 'screen',
      type: 'FRAME',
      children: [
        {
          id: 'card',
          type: 'INSTANCE',
          children: [
            {
              id: 'I card;icon',
              type: 'VECTOR',
              children: [
                { id: 'I card;glyph', type: 'VECTOR' },
              ],
            },
          ],
        },
      ],
    }
    await enrichDocument(
      live,
      doc,
      2,
      deps({
        getVariableName: async id => {
          asked.push(id)
          return 'brand/accent'
        },
      }),
    )
    const card = (
      doc.children as Record<string, unknown>[]
    )[0]
    const icon = (
      card.children as Record<string, unknown>[]
    )[0]
    const glyph = (
      icon.children as Record<string, unknown>[]
    )[0]
    // The grandchild: named binding AND the geometry REST has no column for.
    expect(icon.bindingNames).toEqual({
      variables: { 'V:9': 'brand/accent' },
    })
    expect(icon.vectorPaths).toEqual([
      { windingRule: 'NONZERO', data: 'M 0 0' },
    ])
    // One level further is past `depth`: not walked, not resolved, not paid for.
    expect('bindingNames' in glyph).toBe(false)
    expect('vectorPaths' in glyph).toBe(false)
    // One distinct id, one lookup — the batching holds across levels.
    expect(asked).toEqual(['V:9'])
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

// B41 — content written into a component SLOT keeps its pre-append id, so the
// live walk and the export disagree about every id in that subtree. The fix is
// structural pairing; these pin the three-way the sweep reproduced live.
describe('enrichDocument — the alias subtree (B41)', () => {
  const CANON = 'I298:7517;298:7516;298:7523'
  const VAR = 'VariableID:261:4751'

  /** A live handle whose address names no node: every read throws. */
  const unreadable = (id: string): LiveNode =>
    new Proxy({} as LiveNode, {
      get: (_t, prop) => {
        if (prop === 'id') return id
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

  /** The exported chip: canonical ids, and the binding on the label's fill. */
  const slotDoc = (): Record<string, unknown> => ({
    id: CANON,
    type: 'INSTANCE',
    children: [
      {
        id: CANON + ';298:7510',
        type: 'TEXT',
        fills: [
          {
            type: 'SOLID',
            color: { r: 0.13, g: 0.83, b: 0.93 },
            boundVariables: {
              color: { id: VAR, type: 'VARIABLE_ALIAS' },
            },
          },
        ],
      },
    ],
  })

  const named = deps({
    getStyleName: async () => 'Glow/Accent',
    getVariableName: async () => 'probe/cyan',
  })

  it('lands the ROOT patch on the canonical id, not the alias', async () => {
    // The chip's own handle reads fine — it is only CALLED something else.
    const chip = node(
      {
        id: '298:7519',
        type: 'INSTANCE',
        fillStyleId: 'S:glow',
        width: 96,
        height: 28,
      },
      [node({ id: 'I298:7519;298:7510', type: 'TEXT' })],
    )
    const doc = slotDoc()
    await enrichDocument(chip, doc, -1, named)
    expect(doc.bindingNames).toEqual({
      styles: { fill: 'Glow/Accent' },
    })
    expect(doc.width).toBe(96)
    // The whole point: nothing was reported as unattachable.
    expect('readErrors' in doc).toBe(false)
  })

  it('names a DESCENDANT binding off the export when its handle is dead', async () => {
    const chip = node(
      { id: '298:7519', type: 'INSTANCE' },
      [unreadable('I298:7519;298:7510')],
    )
    const doc = slotDoc()
    await enrichDocument(chip, doc, -1, named)
    const label = (
      doc.children as Record<string, unknown>[]
    )[0]
    // var(probe/cyan) survives — the id was on the export all along.
    expect(label.bindingNames).toEqual({
      variables: { [VAR]: 'probe/cyan' },
    })
    // …and the loss that IS real is named on the node that suffered it,
    // instead of on the root as an id the caller cannot find (I48).
    expect(label.readError).toContain('does not exist')
    expect('readErrors' in doc).toBe(false)
  })

  // B41 — the style() wrapper is a LIVE-ONLY field (the export carries no
  // style id at all, proven live 2026-07-31). So a node the live walk never
  // reached loses its wrapper, and until now it lost it SILENTLY: the read
  // came back looking complete and one field short. Whether a handle answers
  // is session state, which is the whole of B41's nondeterminism.
  //
  // The fix cannot restore the name. It can make the absence ATTRIBUTABLE:
  // every node the export alone described says so, on the node that suffered
  // it.
  it('declares the export-served node the live walk never reached', async () => {
    // The chip's own handle reads. Its LABEL refuses `children`, so the walk
    // never reaches the grandchild below it — that node has no live half at
    // all, and no throw of its own to report.
    const label: LiveNode = {
      id: 'I298:7519;298:7510',
      type: 'FRAME',
    }
    Object.defineProperty(label, 'children', {
      get() {
        throw new Error(
          'in get_children: The node with id "I298:7519;298:7510" does not exist',
        )
      },
      enumerable: true,
      configurable: true,
    })
    const chip = node(
      { id: '298:7519', type: 'INSTANCE' },
      [label],
    )
    const doc: Record<string, unknown> = {
      id: CANON,
      type: 'INSTANCE',
      children: [
        {
          id: CANON + ';298:7510',
          type: 'FRAME',
          children: [
            {
              id: CANON + ';298:7510;298:7511',
              type: 'TEXT',
              fills: [
                {
                  type: 'SOLID',
                  color: { r: 0.13, g: 0.83, b: 0.93 },
                  boundVariables: {
                    color: {
                      id: VAR,
                      type: 'VARIABLE_ALIAS',
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    await enrichDocument(chip, doc, -1, named)

    const frame = (
      doc.children as Record<string, unknown>[]
    )[0]
    const text = (
      frame.children as Record<string, unknown>[]
    )[0]
    // The var() half still lands — the export carries the binding id.
    expect(text.bindingNames).toEqual({
      variables: { [VAR]: 'probe/cyan' },
    })
    // …and the style() half, which the export CANNOT carry, is declared
    // missing rather than passed off as a node that has no style.
    expect(text.readError).toContain(
      CANON + ';298:7510;298:7511',
    )
    expect(text.readError).toContain('export')
  })

  it('declares a style it cannot name — a bare literal is not "unstyled"', async () => {
    // The node IS styled. The name resolver cannot say what the style is
    // called, so no style() wrapper can be rendered — and writing the bare
    // literal back would DETACH the style. The read has to say so.
    const patches = await collectPatches(
      node({
        id: 'root',
        type: 'RECTANGLE',
        fillStyleId: 'S:gone',
        textStyleId: 'S:also-gone',
      }),
      undefined,
      0,
      deps({ getStyleName: async () => undefined }),
    )
    const patch = patches.get('root')
    expect('bindingNames' in patch!).toBe(false)
    expect(patch?.readError).toContain('fill')
    expect(patch?.readError).toContain('text')
  })

  it('says nothing extra when every style resolves', async () => {
    const patches = await collectPatches(
      node({
        id: 'root',
        type: 'RECTANGLE',
        fillStyleId: 'S:glow',
      }),
      undefined,
      0,
      named,
    )
    expect(patches.get('root')?.bindingNames).toEqual({
      styles: { fill: 'Glow/Accent' },
    })
    expect('readError' in patches.get('root')!).toBe(false)
  })

  it('control: a clone, whose ids already agree, is unchanged', async () => {
    const clone = node({ id: CANON, type: 'INSTANCE' }, [
      node({
        id: CANON + ';298:7510',
        type: 'TEXT',
        boundVariables: {
          fills: [{ id: VAR, type: 'VARIABLE_ALIAS' }],
        },
      }),
    ])
    const doc = slotDoc()
    await enrichDocument(clone, doc, -1, named)
    const label = (
      doc.children as Record<string, unknown>[]
    )[0]
    expect(label.bindingNames).toEqual({
      variables: { [VAR]: 'probe/cyan' },
    })
    expect('readError' in label).toBe(false)
  })
})
