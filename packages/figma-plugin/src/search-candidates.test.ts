// search-candidates.test.ts — B48: the nodes a live scan loses, recovered from
// the host's export with their CANONICAL ids.

import { describe, expect, it } from 'bun:test'
import {
  candidateFromExport,
  candidatesFromExport,
} from './search-candidates'

const CANON = 'I298:7517;298:7516;298:7523'

/** The chip's export: canonical ids, one bound TEXT label. */
const chipDoc = () => ({
  id: CANON,
  name: 'Chip',
  type: 'INSTANCE',
  absoluteBoundingBox: {
    x: 0,
    y: 0,
    width: 96,
    height: 28,
  },
  children: [
    {
      id: CANON + ';298:7510',
      name: 'Label',
      type: 'TEXT',
      characters: 'PROBE-SLOT-STRING',
      absoluteBoundingBox: {
        x: 8,
        y: 6,
        width: 80,
        height: 16,
      },
      fills: [
        {
          type: 'SOLID',
          boundVariables: {
            color: {
              id: 'VariableID:261:4751',
              type: 'VARIABLE_ALIAS',
            },
          },
        },
      ],
    },
  ],
})

describe('candidateFromExport', () => {
  it('carries id / name / type and the bbox size', () => {
    expect(candidateFromExport(chipDoc())).toEqual({
      id: CANON,
      name: 'Chip',
      type: 'INSTANCE',
      size: [96, 28],
    })
  })

  it('prefers the enriched unrotated size over the bbox', () => {
    expect(
      candidateFromExport({
        id: 'n',
        width: 10,
        height: 20,
        absoluteBoundingBox: {
          width: 28,
          height: 28,
        },
      })?.size,
    ).toEqual([10, 20])
  })

  it('omits the size rather than fabricating [0,0]', () => {
    expect(
      candidateFromExport({ id: 'n' })?.size,
    ).toBeUndefined()
  })

  it('is nothing at all without an id — a candidate must be addressable', () => {
    expect(
      candidateFromExport({ name: 'anon' }),
    ).toBeUndefined()
  })

  it('adds characters and variableIds only when the scan asked', () => {
    const label = chipDoc().children[0]
    expect(
      candidateFromExport(label, {
        characters: true,
        variableIds: true,
      }),
    ).toMatchObject({
      characters: 'PROBE-SLOT-STRING',
      variableIds: ['VariableID:261:4751'],
    })
    const bare = candidateFromExport(label)
    expect('characters' in bare!).toBe(false)
    expect('variableIds' in bare!).toBe(false)
  })
})

describe('candidatesFromExport — the whole subtree, canonically', () => {
  it('returns the host and its descendants, root first', () => {
    expect(
      candidatesFromExport(chipDoc(), -1).map(c => c.id),
    ).toEqual([CANON, CANON + ';298:7510'])
  })

  it('honours the levels the live scan had left', () => {
    expect(
      candidatesFromExport(chipDoc(), 0).map(c => c.id),
    ).toEqual([CANON])
  })
})
