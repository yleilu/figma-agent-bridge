import { describe, it, expect } from 'bun:test'
import {
  pocChangeId,
  pocTakeFlush,
  pocVerdict,
} from './poc-probe'

describe('pocChangeId', () => {
  it('reads a node change from change.node.id', () => {
    expect(
      pocChangeId({
        type: 'PROPERTY_CHANGE',
        node: { id: 'n1' },
        id: 'ignored',
      }),
    ).toBe('n1')
  })

  it('reads a STYLE_* change from change.style.id, NOT change.node', () => {
    expect(
      pocChangeId({
        type: 'STYLE_PROPERTY_CHANGE',
        style: { id: 'S:1' },
        node: { id: 'n1' },
      }),
    ).toBe('S:1')
  })

  it('falls back to change.id when style is null (StyleDeleteChange)', () => {
    expect(
      pocChangeId({
        type: 'STYLE_DELETE',
        style: null,
        id: 'S:2',
      }),
    ).toBe('S:2')
  })

  it('is null when no id is reachable', () => {
    expect(pocChangeId({ type: 'CREATE' })).toBe(null)
    expect(pocChangeId(null)).toBe(null)
    expect(pocChangeId({ node: { id: 'n1' } })).toBe('n1')
  })
})

const sets = (o: {
  touched?: string[]
  reflow?: string[]
}) => ({
  touched: new Set(o.touched ?? []),
  reflow: new Set(o.reflow ?? []),
})

describe('pocVerdict', () => {
  it('an admitted change is kept', () => {
    expect(
      pocVerdict({
        kept: true,
        id: 'n1',
        open: true,
        ...sets({ touched: ['n1'] }),
      }),
    ).toBe('kept')
  })

  it('attributes a drop to the touched set', () => {
    expect(
      pocVerdict({
        kept: false,
        id: 'n1',
        open: true,
        ...sets({ touched: ['n1'] }),
      }),
    ).toBe('dropped-touched')
  })

  it('attributes a drop to the reflow closure', () => {
    expect(
      pocVerdict({
        kept: false,
        id: 'n2',
        open: true,
        ...sets({ reflow: ['n2'] }),
      }),
    ).toBe('dropped-cascade')
  })

  it('touched WINS over reflow (the filter tests it first)', () => {
    expect(
      pocVerdict({
        kept: false,
        id: 'n3',
        open: true,
        ...sets({ touched: ['n3'], reflow: ['n3'] }),
      }),
    ).toBe('dropped-touched')
  })

  // A drop the WINDOW did not cause must never read as a filter drop:
  // Measurement B's cascade histogram is counted off these labels, and a
  // shape the filter does not model (an unmapped change type, a change with
  // no id) would otherwise inflate `dropped-cascade`.
  it('a drop while the window is CLOSED is not the filter', () => {
    expect(
      pocVerdict({
        kept: false,
        id: 'n1',
        open: false,
        ...sets({ touched: ['n1'] }),
      }),
    ).toBe('dropped-unfiltered')
  })

  it('a drop of an id in NEITHER set is not the filter', () => {
    expect(
      pocVerdict({
        kept: false,
        id: 'n9',
        open: true,
        ...sets({ touched: ['n1'] }),
      }),
    ).toBe('dropped-unfiltered')
  })

  it('a drop with no id is not the filter', () => {
    expect(
      pocVerdict({
        kept: false,
        id: null,
        open: true,
        ...sets({ touched: ['n1'] }),
      }),
    ).toBe('dropped-unfiltered')
  })
})

describe('pocTakeFlush', () => {
  const rows = (n: number, from = 0): number[] =>
    Array.from({ length: n }, (_, i) => i + from)

  it('emits everything when the backlog fits in one frame', () => {
    const b = pocTakeFlush(rows(3), 10, 100)
    expect(b.frame).toEqual([0, 1, 2])
    expect(b.rest).toEqual([])
    expect(b.dropped).toBe(0)
  })

  it('caps the frame and DEFERS the remainder rather than dropping it', () => {
    const b = pocTakeFlush(rows(7), 3, 100)
    expect(b.frame).toEqual([0, 1, 2])
    expect(b.rest).toEqual([3, 4, 5, 6])
    expect(b.dropped).toBe(0)
  })

  it('drops from the NEWEST end once the backlog cap is exceeded, and counts it', () => {
    // FIFO order is preserved so the emitted stream stays contiguous in time
    // and the hole is at the end of the burst, where PROBE_OVERFLOW marks it.
    const b = pocTakeFlush(rows(10), 2, 3)
    expect(b.frame).toEqual([0, 1])
    expect(b.rest).toEqual([2, 3, 4])
    expect(b.dropped).toBe(5)
  })

  it('never mutates the input', () => {
    const input = rows(5)
    pocTakeFlush(input, 2, 2)
    expect(input).toEqual([0, 1, 2, 3, 4])
  })
})
