import { describe, it, expect } from 'bun:test'
import { createAccumulator } from './accumulator'

const W = (...names: string[]): ReadonlySet<string> =>
  new Set(names)

describe('ChangeAccumulator', () => {
  it('folds repeated updates of one id by the SAME writer into ONE run', () => {
    const a = createAccumulator(100)
    a.add({ op: 'update', id: 'n1', props: ['x'] })
    a.add({ op: 'update', id: 'n1', props: ['y'] })
    expect(a.size()).toBe(1)
    expect(a.runCount()).toBe(1)
    const out = a.drain()
    expect(out.changes).toHaveLength(1)
    expect(out.changes[0]?.props).toEqual(['x', 'y'])
  })

  it('a DIFFERENT writer set opens a new run; the same one does not', () => {
    const a = createAccumulator(100)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: W('A'),
    })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: W('A'),
    })
    expect(a.runCount()).toBe(1)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: W('B'),
    })
    expect(a.runCount()).toBe(2)
    // {A} and {A,B} are DIFFERENT writers of the same node.
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: W('A', 'B'),
    })
    expect(a.runCount()).toBe(3)
    // Order-insensitive: {B,A} is the same key as {A,B}.
    a.add({
      op: 'update',
      id: 'n1',
      props: ['y'],
      by: W('B', 'A'),
    })
    expect(a.runCount()).toBe(3)
    expect(a.size()).toBe(1)
  })

  it('runs are PER ID — a writer change on X leaves Y at one run', () => {
    const a = createAccumulator(100)
    for (let i = 0; i < 40; i += 1) {
      a.add({ op: 'update', id: 'Y', props: ['x'] })
    }
    a.add({
      op: 'update',
      id: 'X',
      props: ['x'],
      by: W('A'),
    })
    a.add({ op: 'update', id: 'X', props: ['x'] })
    expect(a.runCount()).toBe(3) // Y: 1, X: 2
  })

  it('within a run props UNION and set takes the LATER value', () => {
    const a = createAccumulator(100)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x', 'name'],
      set: { x: 10, name: 'first' },
    })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      set: { x: 20 },
    })
    const [rec] = a.drain().changes
    expect(rec?.props).toEqual(['name', 'x'])
    expect(rec?.set).toEqual({ name: 'first', x: 20 })
  })

  it('nothing folds ACROSS a run boundary — drain emits both, in run order', () => {
    const a = createAccumulator(100)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      set: { x: 10 },
      by: W('A'),
    })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      set: { x: 20 },
    })
    const { changes } = a.drain()
    expect(changes).toHaveLength(2)
    // The ORDER is the history. A consumer that reordered these would put the
    // value's last writer on the wrong side of the boundary.
    expect(changes[0]?.set).toEqual({ x: 10 })
    expect(changes[0]?.by).toEqual(W('A'))
    expect(changes[1]?.set).toEqual({ x: 20 })
    expect(changes[1]?.by).toBeUndefined()
  })

  it('unions the writer sets of a record that folds INTO a run', () => {
    const a = createAccumulator(100)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: W('A'),
      rf: W('A'),
    })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['y'],
      by: W('A'),
      rf: W('B'),
    })
    const [rec] = a.drain().changes
    // A set that lost a writer would send that writer its own work back.
    expect(rec?.rf).toEqual(W('A', 'B'))
  })

  it('create → delete CANCELS within a run and NEVER across one', () => {
    const within = createAccumulator(100)
    within.add({ op: 'create', id: 'n1', by: W('A') })
    within.add({ op: 'delete', id: 'n1', by: W('A') })
    expect(within.size()).toBe(0)
    expect(within.drain().changes).toEqual([])

    const across = createAccumulator(100)
    across.add({ op: 'create', id: 'n1', by: W('A') })
    across.add({ op: 'delete', id: 'n1', by: W('B') })
    // The party whose work was undone must learn it was undone.
    expect(across.runCount()).toBe(2)
    const ops = across.drain().changes.map(c => c.op)
    expect(ops).toEqual(['create', 'delete'])
  })

  it('RUNS_PER_ID_CAP merges the two OLDEST adjacent runs and flags `merged`', () => {
    const a = createAccumulator(100, 3)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['a'],
      set: { a: 1 },
      by: W('A'),
    })
    a.add({ op: 'update', id: 'n1', props: ['b'] })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['c'],
      by: W('C'),
    })
    expect(a.runCount()).toBe(3)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['d'],
      by: W('D'),
    })
    // Still 3: the two oldest merged rather than a fourth being added.
    expect(a.runCount()).toBe(3)
    expect(a.overflowed()).toBe(false)
    const { changes } = a.drain()
    expect(changes).toHaveLength(3)
    expect(changes[0]?.props).toEqual(['a', 'b'])
    expect(changes[0]?.set).toEqual({ a: 1 })
    expect(changes[0]?.merged).toBe(true)
    // Their keys UNION.
    expect(changes[0]?.by).toEqual(W('A'))
    expect(changes[1]?.merged).toBeUndefined()
    expect(changes[2]?.merged).toBeUndefined()
  })

  it('ACCUM_CAP stage 1 MERGES RUNS and arms nothing', () => {
    const a = createAccumulator(2)
    a.add({ op: 'update', id: 'n1', props: ['a'] })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['b'],
      by: W('A'),
    })
    expect(a.runCount()).toBe(2)
    a.add({
      op: 'update',
      id: 'n1',
      props: ['c'],
      by: W('B'),
    })
    // Three runs on one id, cap 2 → merge, not evict. No change is lost, so
    // `overflow` stays false and no consumer's baseline is broken.
    expect(a.runCount()).toBe(2)
    expect(a.size()).toBe(1)
    expect(a.overflowed()).toBe(false)
  })

  it('ACCUM_CAP stage 2 evicts the OLDEST distinct id and sets overflow', () => {
    const a = createAccumulator(2)
    a.add({ op: 'create', id: 'n1' })
    a.add({ op: 'create', id: 'n2' })
    expect(a.overflowed()).toBe(false)
    a.add({ op: 'create', id: 'n3' })
    // Every entry is already a single run, so stage 1 cannot help.
    expect(a.overflowed()).toBe(true)
    const ids = a.drain().changes.map(c => c.id)
    expect(ids).toEqual(['n2', 'n3'])
  })

  it('spends ORDER before it spends CHANGES', () => {
    const a = createAccumulator(3)
    // n1 holds three runs; n2 and n3 hold one each. Cap 3.
    a.add({ op: 'update', id: 'n1', props: ['a'] })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['b'],
      by: W('A'),
    })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['c'],
      by: W('B'),
    })
    a.add({ op: 'update', id: 'n2', props: ['a'] })
    a.add({ op: 'update', id: 'n3', props: ['a'] })
    // Five runs over three ids under a cap of 3: the two merges come out of
    // n1's history, and all three ids survive.
    expect(a.runCount()).toBe(3)
    expect(a.size()).toBe(3)
    expect(a.overflowed()).toBe(false)
    expect(a.drain().changes.map(c => c.id)).toEqual([
      'n1',
      'n2',
      'n3',
    ])
  })

  it('drain emits per-id run order, mutations first, then page, then select', () => {
    const a = createAccumulator(100)
    a.add({ op: 'select', ids: [] })
    a.add({ op: 'page', id: 'p' })
    a.add({ op: 'style_create', id: 'S:1' })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: W('A'),
    })
    a.add({ op: 'update', id: 'n1', props: ['x'] })
    expect(a.drain().changes.map(c => c.op)).toEqual([
      'update',
      'update',
      'style_create',
      'page',
      'select',
    ])
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
    expect(a.runCount()).toBe(0)
    const out = a.drain()
    expect(out.changes.map(c => c.op)).toEqual([
      'page',
      'select',
    ])
    expect(out.changes[0]?.id).toBe('p2')
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

  // A batch that is drained and then fails to LEAVE the plugin is gone: the
  // accumulator is already empty and there is nothing to put back. A
  // plugin-side loss is REPORTED, never silent, so the loser arms the same arm
  // an eviction does and the next frame carries it.
  it('markOverflow arms the next frame, and the arm clears with it', () => {
    const a = createAccumulator(100)
    a.add({ op: 'create', id: 'n1' })
    expect(a.drain().overflow).toBe(false)
    a.markOverflow()
    expect(a.overflowed()).toBe(true)
    const out = a.drain()
    expect(out.changes).toEqual([])
    expect(out.overflow).toBe(true)
    expect(a.drain().overflow).toBe(false)
  })

  it('UNATTRIBUTED traffic drains exactly as pure collapse did', () => {
    // The pre-wire-cut state: the attributor still drops self-writes, so no
    // record carries `by`, every key is the empty one, and every id holds
    // exactly ONE run. The frame must be what it was before runs existed.
    const a = createAccumulator(100)
    a.add({ op: 'create', id: 'n1', type: 'FRAME' })
    a.add({
      op: 'update',
      id: 'n1',
      props: ['x'],
      name: 'Card',
    })
    a.add({
      op: 'update',
      id: 'n2',
      props: ['y'],
      type: 'TEXT',
    })
    a.add({
      op: 'update',
      id: 'n2',
      props: ['name'],
      name: 'Label',
    })
    a.add({ op: 'style_update', id: 'S:1', props: ['p'] })
    expect(a.runCount()).toBe(3)
    expect(a.drain().changes).toEqual([
      // create → update keeps the create and drops props/set.
      {
        op: 'create',
        id: 'n1',
        type: 'FRAME',
        name: 'Card',
      },
      {
        op: 'update',
        id: 'n2',
        type: 'TEXT',
        name: 'Label',
        props: ['name', 'y'],
      },
      { op: 'style_update', id: 'S:1', props: ['p'] },
    ])
  })
})
