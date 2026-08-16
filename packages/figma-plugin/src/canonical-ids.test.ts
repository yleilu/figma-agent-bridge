// canonical-ids.test.ts — the export owns identity (B41/B48).
//
// The case every test here is built around: a node written into a component
// SLOT answers its PRE-APPEND id, so the live walk and the export disagree
// about what the same node is called, and the walk's descendants carry
// addresses composed from the stale id that resolve to nothing.

import { describe, expect, it } from 'bun:test'
import {
  exportedChildren,
  exportedWithin,
  idOf,
  liveChildren,
  pairWithExport,
  variableIdsInExport,
  type LiveNode,
  type RawNode,
} from './canonical-ids'

const live = (
  id: string,
  children: LiveNode[] = [],
): LiveNode =>
  children.length > 0 ? { id, children } : { id }

const exported = (
  id: string,
  children: RawNode[] = [],
): RawNode =>
  children.length > 0 ? { id, children } : { id }

/** A handle whose address names no node: every property read throws. */
const unreadable = (id: string): LiveNode =>
  new Proxy({} as LiveNode, {
    get: (_t, prop) => {
      if (prop === 'id') return id
      throw new Error(
        'in get_' +
          String(prop) +
          ': The node with id "' +
          id +
          '" does not exist',
      )
    },
    has: () => true,
  })

describe('exportedWithin — the depth bound', () => {
  const doc = exported('a', [
    exported('b', [exported('c')]),
  ])

  it('depth 0 is the root alone', () => {
    expect(exportedWithin(doc, 0).map(n => n.id)).toEqual([
      'a',
    ])
  })

  it('depth 1 is the root plus one level', () => {
    expect(exportedWithin(doc, 1).map(n => n.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('depth -1 is every level', () => {
    expect(exportedWithin(doc, -1).map(n => n.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('ignores a children field that is not an array', () => {
    expect(
      exportedChildren({ id: 'x', children: 'nope' }),
    ).toEqual([])
  })
})

describe('idOf / liveChildren — reads that can refuse', () => {
  it('answers undefined rather than throwing on a dead handle', () => {
    const dead = new Proxy({} as LiveNode, {
      get: () => {
        throw new Error('gone')
      },
      has: () => true,
    })
    expect(idOf(dead)).toBeUndefined()
  })

  it('reports the throw and keeps going when children refuse', () => {
    let seen: unknown
    expect(
      liveChildren(unreadable('I1:9;1:2'), err => {
        seen = err
      }),
    ).toEqual([])
    expect(String(seen)).toContain('does not exist')
  })
})

describe('pairWithExport — the alias join', () => {
  it('pairs by POSITION when the ids disagree — the whole point', () => {
    // The chip: live 298:7519, canonical I298:7517;298:7516;298:7523.
    const root = live('298:7519', [
      live('I298:7519;298:7510'),
    ])
    const doc = exported('I298:7517;298:7516;298:7523', [
      exported('I298:7517;298:7516;298:7523;298:7510'),
    ])
    expect(pairWithExport(root, doc, -1)).toMatchObject([
      { id: 'I298:7517;298:7516;298:7523' },
      { id: 'I298:7517;298:7516;298:7523;298:7510' },
    ])
  })

  it('keeps both halves of each pair', () => {
    const kid = live('live-kid')
    const root = live('live-root', [kid])
    const doc = exported('canon-root', [
      exported('canon-kid'),
    ])
    const pairs = pairWithExport(root, doc, -1)
    expect(pairs[1].live).toBe(kid)
    expect(pairs[1].exported?.id).toBe('canon-kid')
  })

  it('keys every node by its own live id when there is no export', () => {
    const root = live('a', [live('b'), live('c')])
    expect(
      pairWithExport(root, undefined, -1).map(p => p.id),
    ).toEqual(['a', 'b', 'c'])
  })

  it('falls back to matching by id when the two shapes disagree', () => {
    // Positional guessing across a mismatch would merge one node's geometry
    // onto another — worse than losing it.
    const root = live('r', [live('x'), live('y')])
    const doc = exported('r', [exported('y')])
    const pairs = pairWithExport(root, doc, -1)
    expect(pairs.map(p => p.id)).toEqual(['r', 'y', 'x'])
    expect(pairs[1].live?.id).toBe('y')
    expect(pairs[2].exported).toBeUndefined()
  })

  it('emits an exported node the live walk could not reach', () => {
    const root = live('r')
    const doc = exported('r', [exported('ghost')])
    const pairs = pairWithExport(root, doc, -1)
    expect(pairs.map(p => p.id)).toEqual(['r', 'ghost'])
    expect(pairs[1].live).toBeUndefined()
  })

  it('records the throw from a node that will not list its children', () => {
    const root = live('r', [unreadable('I1:9;1:2')])
    const doc = exported('r', [exported('canon-kid')])
    const pairs = pairWithExport(root, doc, -1)
    expect(pairs[1].walkError).toContain('does not exist')
    expect(pairs[1].id).toBe('canon-kid')
  })

  it('stops at the requested depth on BOTH sides', () => {
    const root = live('a', [live('b', [live('c')])])
    const doc = exported('A', [
      exported('B', [exported('C')]),
    ])
    expect(
      pairWithExport(root, doc, 1).map(p => p.id),
    ).toEqual(['A', 'B'])
  })
})

describe('variableIdsInExport — the ids the read face already uses', () => {
  it('finds a flat node-level binding', () => {
    expect(
      variableIdsInExport({
        id: 'n',
        boundVariables: {
          opacity: {
            id: 'VariableID:1:1',
            type: 'VARIABLE_ALIAS',
          },
        },
      }),
    ).toEqual(['VariableID:1:1'])
  })

  it('finds a REST-nested per-corner binding', () => {
    expect(
      variableIdsInExport({
        id: 'n',
        boundVariables: {
          rectangleCornerRadii: {
            RECTANGLE_TOP_LEFT_CORNER_RADIUS: {
              id: 'VariableID:2:2',
              type: 'VARIABLE_ALIAS',
            },
          },
        },
      }),
    ).toEqual(['VariableID:2:2'])
  })

  it('finds a per-paint color binding on fills and strokes', () => {
    expect(
      variableIdsInExport({
        id: 'n',
        fills: [
          {
            type: 'SOLID',
            boundVariables: {
              color: {
                id: 'VariableID:3:3',
                type: 'VARIABLE_ALIAS',
              },
            },
          },
        ],
        strokes: [
          {
            type: 'SOLID',
            boundVariables: {
              color: {
                id: 'VariableID:4:4',
                type: 'VARIABLE_ALIAS',
              },
            },
          },
        ],
      }).sort(),
    ).toEqual(['VariableID:3:3', 'VariableID:4:4'])
  })

  it('is empty for a node that binds nothing', () => {
    expect(
      variableIdsInExport({ id: 'n', fills: [] }),
    ).toEqual([])
  })
})
