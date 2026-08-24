// space-between-gap.test.ts — B58's real fix, the half that needs the live node.
//
// THE EVIDENCE, all live and human-in-the-loop:
//   1. The QA read-back from before the original failure shows the pagination
//      bar STORED align SPACE_BETWEEN with gap "var(space/16)16" — one
//      create_tree wrote both. It rendered correctly for days.
//   2. Lei CLICKING the node converted the stored SPACE_BETWEEN to MIN. Replayed
//      with byte-identical params, the replica collapsed the same way.
//   3. Discriminating pair: an identical bar with a PLAIN literal gap 16 +
//      SPACE_BETWEEN survives selection; the var-bound twin collapses.
//   4. A selected-node write of SPACE_BETWEEN with a PLAIN gap lands and sticks.
//      Same machinery, opposite outcome — the gap BINDING is the sole
//      discriminator, and the UI selection never was one.
//
// So the pair is refused. The server catches both halves in one write; these
// are the cases only the live node can answer.

import { describe, expect, it } from 'bun:test'
import {
  alignIsSpaceBetween,
  bindFieldConflict,
  gapIsBound,
  updateLayoutConflict,
} from './space-between-gap'

/** A bar whose gap is bound to a token — the shape that produced B58. */
const boundGapBar = {
  id: '454:4934',
  primaryAxisAlignItems: 'MIN',
  boundVariables: {
    itemSpacing: {
      type: 'VARIABLE_ALIAS',
      id: 'VariableID:space16',
    },
  },
}

/** A bar already set to SPACE_BETWEEN, with a plain gap. */
const spaceBetweenBar = {
  id: '454:4935',
  primaryAxisAlignItems: 'SPACE_BETWEEN',
  boundVariables: {},
}

const plainBar = {
  id: '454:4936',
  primaryAxisAlignItems: 'MIN',
  boundVariables: {},
}

const varGapBinding = [
  { kind: 'var', field: 'itemSpacing' },
]

describe('gapIsBound / alignIsSpaceBetween', () => {
  it('sees a bound gap', () => {
    expect(gapIsBound(boundGapBar)).toBe(true)
    expect(gapIsBound(plainBar)).toBe(false)
  })

  it('sees a SPACE_BETWEEN align', () => {
    expect(alignIsSpaceBetween(spaceBetweenBar)).toBe(true)
    expect(alignIsSpaceBetween(plainBar)).toBe(false)
  })

  it('answers false rather than throwing on a refusing handle', () => {
    const hostile = {
      get boundVariables(): never {
        throw new Error('The node does not exist')
      },
      get primaryAxisAlignItems(): never {
        throw new Error('The node does not exist')
      },
    }
    expect(() => gapIsBound(hostile)).not.toThrow()
    expect(gapIsBound(hostile)).toBe(false)
    expect(alignIsSpaceBetween(hostile)).toBe(false)
  })
})

describe('updateLayoutConflict — the half arriving onto the other half', () => {
  // Evidence 1 + 2: this is the original bug's shape, one edit later.
  it('refuses SPACE_BETWEEN onto a node whose gap is already bound', () => {
    const message = updateLayoutConflict(
      boundGapBar,
      { align: ['SPACE_BETWEEN', 'CENTER'] },
      undefined,
    )
    expect(message).toBeDefined()
    expect(message).toContain('454:4934')
    expect(message).toContain('already has the bound gap')
  })

  it('refuses binding the gap on a node already SPACE_BETWEEN', () => {
    const message = updateLayoutConflict(
      spaceBetweenBar,
      undefined,
      varGapBinding,
    )
    expect(message).toBeDefined()
    expect(message).toContain('454:4935')
    expect(message).toContain('already has the align')
  })

  it('refuses both halves in one write, even reaching the plugin alone', () => {
    const message = updateLayoutConflict(
      plainBar,
      { align: ['SPACE_BETWEEN', 'CENTER'] },
      varGapBinding,
    )
    expect(message).toBeDefined()
    expect(message).toContain('This call sets both')
  })

  // Evidence 3 + 4: the literal gap is the supported way to write both.
  it('ALLOWS SPACE_BETWEEN with a plain literal gap', () => {
    expect(
      updateLayoutConflict(
        plainBar,
        { align: ['SPACE_BETWEEN', 'CENTER'] },
        undefined,
      ),
    ).toBeUndefined()
  })

  it('ALLOWS binding the gap on a node that is not SPACE_BETWEEN', () => {
    expect(
      updateLayoutConflict(
        plainBar,
        undefined,
        varGapBinding,
      ),
    ).toBeUndefined()
  })

  // Resolving the conflict must not be mistaken for creating one, or the node
  // would be stuck in the very state the guard exists to prevent.
  it('ALLOWS binding a gap in the same write that drops SPACE_BETWEEN', () => {
    expect(
      updateLayoutConflict(
        spaceBetweenBar,
        { align: ['MIN', 'CENTER'] },
        varGapBinding,
      ),
    ).toBeUndefined()
  })

  it('ALLOWS a non-SPACE_BETWEEN align onto a bound-gap node', () => {
    expect(
      updateLayoutConflict(
        boundGapBar,
        { align: ['CENTER', 'CENTER'] },
        undefined,
      ),
    ).toBeUndefined()
  })

  it('ALLOWS a layout write that touches neither half', () => {
    expect(
      updateLayoutConflict(
        boundGapBar,
        { align: undefined },
        [{ kind: 'var', field: 'paddingTop' }],
      ),
    ).toBeUndefined()
  })

  it('names all three ways out', () => {
    const message =
      updateLayoutConflict(
        boundGapBar,
        { align: ['SPACE_BETWEEN', 'CENTER'] },
        undefined,
      ) ?? ''
    expect(message).toContain('drop the align')
    expect(message).toContain('LITERAL gap')
    expect(message).toContain('drop the gap entirely')
  })
})

describe('bindFieldConflict — the pair by the other door', () => {
  it('refuses bind_variable on the gap of a SPACE_BETWEEN node', () => {
    const message = bindFieldConflict(
      spaceBetweenBar,
      'itemSpacing',
    )
    expect(message).toBeDefined()
    expect(message).toContain('454:4935')
  })

  it('ALLOWS binding the gap of a node that is not SPACE_BETWEEN', () => {
    expect(
      bindFieldConflict(plainBar, 'itemSpacing'),
    ).toBeUndefined()
  })

  it('ALLOWS binding any OTHER field on a SPACE_BETWEEN node', () => {
    for (const field of [
      'paddingTop',
      'fills',
      'cornerRadius',
    ]) {
      expect(
        bindFieldConflict(spaceBetweenBar, field),
      ).toBeUndefined()
    }
  })
})
