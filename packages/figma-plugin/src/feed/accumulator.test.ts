import { describe, it, expect } from 'bun:test'
import { createAccumulator } from './accumulator'

describe('ChangeAccumulator', () => {
  it('folds repeated updates of one id into a single entry', () => {
    const a = createAccumulator(100)
    a.add({ op: 'update', id: 'n1', props: ['x'] })
    a.add({ op: 'update', id: 'n1', props: ['y'] })
    expect(a.size()).toBe(1)
    const out = a.drain()
    expect(out.changes[0]?.props).toEqual(['x', 'y'])
  })

  it('keeps node and style ids in SEPARATE maps', () => {
    const a = createAccumulator(100)
    a.add({ op: 'update', id: 'X', props: ['x'] })
    a.add({ op: 'style_update', id: 'X', props: ['p'] })
    expect(a.size()).toBe(2)
  })

  it('context slots are latest-wins and NEVER count', () => {
    const a = createAccumulator(100)
    a.add({ op: 'page', id: 'p1', name: 'One' })
    a.add({ op: 'page', id: 'p2', name: 'Two' })
    a.add({ op: 'select', ids: ['a'], count: 1 })
    expect(a.size()).toBe(0)
    const out = a.drain()
    expect(out.changes.map(c => c.op)).toEqual([
      'page',
      'select',
    ])
    expect(out.changes[0]?.id).toBe('p2')
  })

  it('orders mutations first, then page, then select', () => {
    const a = createAccumulator(100)
    a.add({ op: 'select', ids: [] })
    a.add({ op: 'page', id: 'p' })
    a.add({ op: 'style_create', id: 'S:1' })
    a.add({ op: 'create', id: 'n1' })
    expect(a.drain().changes.map(c => c.op)).toEqual([
      'create',
      'style_create',
      'page',
      'select',
    ])
  })

  it('evicts the OLDEST distinct id at cap and reports overflow', () => {
    const a = createAccumulator(2)
    a.add({ op: 'create', id: 'n1' })
    a.add({ op: 'create', id: 'n2' })
    expect(a.overflowed()).toBe(false)
    a.add({ op: 'create', id: 'n3' })
    expect(a.overflowed()).toBe(true)
    const ids = a.drain().changes.map(c => c.id)
    expect(ids).toEqual(['n2', 'n3'])
  })

  it('drain resets everything including the flags', () => {
    const a = createAccumulator(1)
    a.add({ op: 'create', id: 'n1' })
    a.add({ op: 'create', id: 'n2' })
    a.markIndexStale()
    const first = a.drain()
    expect(first.overflow).toBe(true)
    expect(first.indexStale).toBe(true)
    const second = a.drain()
    expect(second.changes).toEqual([])
    expect(second.overflow).toBe(false)
    expect(second.indexStale).toBe(false)
  })
})
