import { describe, expect, it } from 'bun:test'
import {
  resolveCollectionTarget,
  extendedCollectionWarning,
  duplicateVariableWarning,
  ambiguousCollectionError,
} from './variable-collection-target'

const collections = [
  { id: 'VC:1', name: 'color' },
  { id: 'VC:2', name: 'spacing' },
]

describe('resolveCollectionTarget', () => {
  it('creates when no collection carries the name (I63)', () => {
    expect(
      resolveCollectionTarget(
        { collection: 'radius' },
        collections,
      ),
    ).toEqual({ kind: 'create', name: 'radius' })
  })

  it('EXTENDS the one collection that already carries the name (I63)', () => {
    expect(
      resolveCollectionTarget(
        { collection: 'color' },
        collections,
      ),
    ).toEqual({
      kind: 'extend',
      id: 'VC:1',
      name: 'color',
    })
  })

  it('refuses when the name is ambiguous — a first-wins pick is a coin toss (I63/B66)', () => {
    const forked = [
      ...collections,
      { id: 'VC:9', name: 'color' },
    ]
    expect(
      resolveCollectionTarget(
        { collection: 'color' },
        forked,
      ),
    ).toEqual({
      kind: 'ambiguous',
      name: 'color',
      ids: ['VC:1', 'VC:9'],
    })
  })

  it('takes collectionId as the exact address, name or no name', () => {
    expect(
      resolveCollectionTarget(
        { collectionId: 'VC:2' },
        collections,
      ),
    ).toEqual({
      kind: 'extend',
      id: 'VC:2',
      name: 'spacing',
    })
  })

  it('reports an unknown collectionId rather than falling back to the name', () => {
    expect(
      resolveCollectionTarget(
        { collectionId: 'VC:404', collection: 'color' },
        collections,
      ),
    ).toEqual({ kind: 'missing', id: 'VC:404' })
  })

  it('needs one address — neither is a refusal', () => {
    expect(
      resolveCollectionTarget({}, collections),
    ).toEqual({
      kind: 'unaddressed',
    })
  })
})

describe('the sentences', () => {
  it('an extend says what it did and how to ask for something else', () => {
    const w = extendedCollectionWarning('color', 'VC:1')
    expect(w).toContain('color')
    expect(w).toContain('VC:1')
    expect(w).toContain('collectionId')
  })

  it('a duplicate variable names update_variables', () => {
    const w = duplicateVariableWarning(
      'brand/primary',
      'color',
    )
    expect(w).toContain('brand/primary')
    expect(w).toContain('update_variables')
  })

  it('an ambiguous name lists every id it could have meant', () => {
    const e = ambiguousCollectionError('color', [
      'VC:1',
      'VC:9',
    ])
    expect(e).toContain('VC:1')
    expect(e).toContain('VC:9')
    expect(e).toContain('collectionId')
  })
})
