import { describe, it, expect } from 'bun:test'
import {
  CASCADE_PROPS,
  collapseAcross,
  collapseWithin,
  DRAIN_VALUE_BUDGET,
  HOTSPOT_CAP,
  MAX_DISPATCH_MS,
  RECORD_VALUE_BUDGET,
  RETAINED_COMMANDS,
  RETAINED_WRITERS,
  RETENTION_CEILING_MS,
  RUNS_PER_ID_CAP,
  SELF,
  SENTINEL_TTL_MS,
  VALUE_MAX_BYTES,
  VALUE_MAX_ITEMS,
  WRITERS_CAP,
  writerKeyOf,
  type CollapseRun,
  type MutationOp,
} from '@figma-agent-bridge/shared/change-feed'

describe('tuning constants that must not drift', () => {
  // Every number below is read off docs/reference/change-feed-poc-results.md.
  // Update BOTH together, never one alone — that is the entire point of this
  // test.

  // The largest observed burst of dispatches outstanding with an earlier
  // event still undelivered: the 20-write battery produced NO frame while it
  // ran, then one frame of 19 records — eight of them from a PREVIOUS run of
  // the same script ("The idle-delivery leak").
  const MEASURED_OUTSTANDING_DISPATCHES = 28

  // The longest deferral ever measured between a command's exit and the
  // delivery of its documentchange (Probe 1).
  const MEASURED_MAX_DEFERRAL_MS = 49_200

  // The server's own dispatch timeout (figma-client.ts): a command it has
  // already abandoned and that is still open plugin-side is a wedge.
  const SERVER_DISPATCH_TIMEOUT_MS = 30_000

  it('RETAINED_COMMANDS is above the largest observed outstanding burst', () => {
    expect(Number.isInteger(RETAINED_COMMANDS)).toBe(true)
    expect(RETAINED_COMMANDS).toBeGreaterThan(
      MEASURED_OUTSTANDING_DISPATCHES,
    )
  })

  it('RETAINED_COMMANDS stays "in tens of commands" — it is THE memory bound', () => {
    // Both sides, or the assertion is not a pin: this is the constant that
    // bounds plugin-sandbox memory (up to this many generations, each
    // holding a reflow set capped only at MAX_CLOSURE_NODES), and it is
    // also how much of the user's work on nodes the agent touched is
    // dropped in silence. Without an upper bound it could drift to 4096
    // and this suite would stay green — the exact drift the test exists to
    // prevent. change-feed.md: "sized in TENS of commands".
    expect(RETAINED_COMMANDS).toBeLessThanOrEqual(100)
  })

  it('RETENTION_CEILING_MS is sized in minutes, above the longest deferral', () => {
    expect(RETENTION_CEILING_MS).toBeGreaterThan(
      MEASURED_MAX_DEFERRAL_MS,
    )
    // "Sized in MINUTES" (change-feed.md), pinned on both sides: too low and
    // retention lets go before a deferred batch lands; too high and the
    // user's post-hand-over edits stay invisible for that long.
    expect(RETENTION_CEILING_MS).toBeGreaterThanOrEqual(
      2 * 60_000,
    )
    expect(RETENTION_CEILING_MS).toBeLessThanOrEqual(
      15 * 60_000,
    )
  })

  it('MAX_DISPATCH_MS reaps a wedge well before the idle ceiling could', () => {
    expect(MAX_DISPATCH_MS).toBeGreaterThan(
      SERVER_DISPATCH_TIMEOUT_MS,
    )
    expect(MAX_DISPATCH_MS).toBeLessThan(
      RETENTION_CEILING_MS,
    )
  })

  it('SENTINEL_TTL_MS is a whole number of seconds (the hook pins seconds)', () => {
    expect(SENTINEL_TTL_MS % 1000).toBe(0)
  })
})

describe('the multi-agent and value caps', () => {
  it('WRITERS_CAP sits below the platform safe bitwise width', () => {
    // `by` / `rf` are integer masks over params.writers[]. JS bitwise operands
    // are 32-bit SIGNED, so bit 31 is the sign bit and 31 bits are usable.
    // The highest bit this cap can mint must still be positive.
    expect(Number.isInteger(WRITERS_CAP)).toBe(true)
    expect(WRITERS_CAP).toBeLessThanOrEqual(30)
    expect(1 << (WRITERS_CAP - 1)).toBeGreaterThan(0)
    // "An order above the number of agents a single file plausibly carries."
    expect(WRITERS_CAP).toBeGreaterThanOrEqual(
      RETAINED_WRITERS,
    )
  })

  it('RETAINED_WRITERS is sized in single digits, above one', () => {
    // A backstop, not a working bound — but a SECOND session must fit, or the
    // whole multi-agent case would evict itself.
    expect(RETAINED_WRITERS).toBeGreaterThanOrEqual(2)
    expect(RETAINED_WRITERS).toBeLessThanOrEqual(9)
  })

  it('RUNS_PER_ID_CAP can hold a boundary and stays small', () => {
    // Two runs is the minimum that can express a writer change at all.
    expect(RUNS_PER_ID_CAP).toBeGreaterThanOrEqual(2)
    expect(RUNS_PER_ID_CAP).toBeLessThanOrEqual(32)
  })

  it('VALUE_MAX_BYTES is sized in the low hundreds', () => {
    // Admits a number, a short string, a single paint, one effect, a
    // constraints object; refuses a vector path or an image fill.
    expect(VALUE_MAX_BYTES).toBeGreaterThanOrEqual(100)
    expect(VALUE_MAX_BYTES).toBeLessThan(1000)
  })

  it('VALUE_MAX_ITEMS refuses the sixty-paint array', () => {
    // The pre-check exists to refuse THAT without serializing it.
    expect(VALUE_MAX_ITEMS).toBeGreaterThan(1)
    expect(VALUE_MAX_ITEMS).toBeLessThan(60)
  })

  it('the three value budgets nest', () => {
    // A record can afford at least one full-cap property; a drain can afford
    // at least one full record. Otherwise a budget would be unreachable and
    // the layer above it would never bind.
    expect(RECORD_VALUE_BUDGET % VALUE_MAX_BYTES).toBe(0)
    expect(RECORD_VALUE_BUDGET).toBeGreaterThanOrEqual(
      VALUE_MAX_BYTES,
    )
    expect(DRAIN_VALUE_BUDGET).toBeGreaterThanOrEqual(
      RECORD_VALUE_BUDGET,
    )
  })

  it('HOTSPOT_CAP is a handful of buckets, not a histogram', () => {
    expect(HOTSPOT_CAP).toBeGreaterThanOrEqual(2)
    expect(HOTSPOT_CAP).toBeLessThanOrEqual(20)
  })
})

describe('CASCADE_PROPS', () => {
  it('is the geometry a re-flow moves on a node nobody named', () => {
    expect([...CASCADE_PROPS].sort()).toEqual([
      'height',
      'maxHeight',
      'maxWidth',
      'minHeight',
      'minWidth',
      'relativeTransform',
      'rotation',
      'width',
      'x',
      'y',
    ])
  })

  it('does NOT hold the properties a user edit carries', () => {
    // A user renaming a node the agent re-flowed must survive subtraction.
    for (const p of [
      'name',
      'parent',
      'fills',
      'characters',
    ]) {
      expect(CASCADE_PROPS.has(p)).toBe(false)
    }
  })
})

describe('writerKeyOf', () => {
  it('is order-independent — a set has no order', () => {
    expect(writerKeyOf(new Set(['A', 'B']))).toBe(
      writerKeyOf(new Set(['B', 'A'])),
    )
  })

  it('distinguishes {A,B} from {A} and from the empty key', () => {
    const ab = writerKeyOf(new Set(['A', 'B']))
    const a = writerKeyOf(new Set(['A']))
    expect(ab).not.toBe(a)
    expect(ab).not.toBe('')
    expect(a).not.toBe('')
  })

  it('is EMPTY for the user, and for an unresolvable cause', () => {
    // No mask at all, and a mask that resolved to nothing, are the same
    // answer: the user, or a cause the attributor could not name.
    expect(writerKeyOf(undefined)).toBe('')
    expect(writerKeyOf(new Set())).toBe('')
    expect(writerKeyOf(new Set(['']))).toBe('')
  })

  it('can never collide with the reserved SELF key', () => {
    // SELF must match nothing the attributor can produce, or a foreign run
    // would fold into this session's own and vanish from the count — silence,
    // which is the direction this design refuses.
    for (const by of [
      new Set(['self']),
      new Set(['', 'self']),
      new Set(['_unattributed']),
      new Set([' self']),
      new Set([SELF]), // the separator itself, forged as a name
      new Set([SELF, 'A']),
    ]) {
      expect(writerKeyOf(by)).not.toBe(SELF)
    }
  })

  it('a name carrying the separator cannot masquerade as two writers', () => {
    // Writer names are untrusted platform input. Without this, {'A\0B'} and
    // {'A','B'} would key the same run — two different writers of one node
    // merged into one history.
    expect(writerKeyOf(new Set(['A\0B']))).not.toBe(
      writerKeyOf(new Set(['A', 'B'])),
    )
  })
})

const run = (
  op: MutationOp,
  over: Partial<CollapseRun> = {},
): CollapseRun => ({ op, ...over })

const P = (...names: string[]) => new Set(names)
const V = (o: Record<string, unknown>) =>
  new Map(Object.entries(o))

describe('collapseWithin — one writer, one unbroken stretch', () => {
  it('(none) → arriving', () => {
    const r = collapseWithin(
      undefined,
      run('update', { props: P('x'), set: V({ x: 20 }) }),
    )
    expect(r?.op).toBe('update')
    expect([...(r?.props ?? [])]).toEqual(['x'])
    expect(r?.set?.get('x')).toBe(20)
  })

  it('create → create', () => {
    expect(
      collapseWithin(run('create'), run('create'))?.op,
    ).toBe('create')
  })

  it('create → update stays create and drops props AND set', () => {
    const r = collapseWithin(
      run('create', { name: 'A' }),
      run('update', { props: P('x'), set: V({ x: 20 }) }),
    )
    expect(r?.op).toBe('create')
    expect(r?.props).toBeUndefined()
    expect(r?.set).toBeUndefined()
    expect(r?.name).toBe('A')
  })

  it('create → delete CANCELS the run', () => {
    expect(
      collapseWithin(run('create'), run('delete')),
    ).toBe(null)
  })

  it('update → create (cannot happen) drops props and set', () => {
    const r = collapseWithin(
      run('update', { props: P('x'), set: V({ x: 1 }) }),
      run('create'),
    )
    expect(r?.op).toBe('create')
    expect(r?.props).toBeUndefined()
    expect(r?.set).toBeUndefined()
  })

  it('update → update UNIONS props and takes the LATEST value per property', () => {
    const r = collapseWithin(
      run('update', {
        props: P('name', 'x'),
        set: V({ name: 'old', x: 10 }),
      }),
      run('update', { props: P('x'), set: V({ x: 20 }) }),
    )
    // Union is the only merge that cannot lose a changed-property NAME…
    expect([...(r?.props ?? [])].sort()).toEqual([
      'name',
      'x',
    ])
    // …and latest-wins is the only merge meaningful for a VALUE.
    expect(r?.set?.get('x')).toBe(20)
    expect(r?.set?.get('name')).toBe('old')
  })

  it('update → delete drops props, set and name', () => {
    const r = collapseWithin(
      run('update', {
        name: 'A',
        props: P('x'),
        set: V({ x: 1 }),
      }),
      run('delete', { type: 'FRAME' }),
    )
    expect(r).toEqual({
      op: 'delete',
      type: 'FRAME',
      name: undefined,
      pg: undefined,
      fr: undefined,
      merged: undefined,
    })
  })

  it('delete → create (undo/redo restores the same id)', () => {
    expect(
      collapseWithin(run('delete'), run('create'))?.op,
    ).toBe('create')
  })

  it('delete → update (cannot happen) takes the arriving props and set', () => {
    const r = collapseWithin(
      run('delete'),
      run('update', { props: P('y'), set: V({ y: 3 }) }),
    )
    expect(r?.op).toBe('update')
    expect([...(r?.props ?? [])]).toEqual(['y'])
    expect(r?.set?.get('y')).toBe(3)
  })

  it('delete → delete', () => {
    expect(
      collapseWithin(run('delete'), run('delete'))?.op,
    ).toBe('delete')
  })
})

describe('collapseAcross — the folded projection over a run boundary', () => {
  it('create → create', () => {
    expect(
      collapseAcross(run('create'), run('create')).op,
    ).toBe('create')
  })

  it('create → update stays create and drops props AND set', () => {
    const r = collapseAcross(
      run('create'),
      run('update', { props: P('x'), set: V({ x: 20 }) }),
    )
    expect(r.op).toBe('create')
    expect(r.props).toBeUndefined()
    expect(r.set).toBeUndefined()
  })

  it('update → create (cannot happen) drops props and set', () => {
    const r = collapseAcross(
      run('update', { props: P('x'), set: V({ x: 1 }) }),
      run('create'),
    )
    expect(r.op).toBe('create')
    expect(r.props).toBeUndefined()
    expect(r.set).toBeUndefined()
  })

  it('update → update UNIONS props and takes the LATEST value per property', () => {
    const r = collapseAcross(
      run('update', {
        props: P('name', 'x'),
        set: V({ name: 'old', x: 10 }),
      }),
      run('update', { props: P('x'), set: V({ x: 20 }) }),
    )
    expect([...(r.props ?? [])].sort()).toEqual([
      'name',
      'x',
    ])
    expect(r.set?.get('x')).toBe(20)
    expect(r.set?.get('name')).toBe('old')
  })

  it('update → delete drops props, set and name', () => {
    const r = collapseAcross(
      run('update', {
        name: 'A',
        props: P('x'),
        set: V({ x: 1 }),
      }),
      run('delete', { type: 'FRAME' }),
    )
    expect(r.op).toBe('delete')
    expect(r.name).toBeUndefined()
    expect(r.props).toBeUndefined()
    expect(r.set).toBeUndefined()
  })

  it('delete → create', () => {
    expect(
      collapseAcross(run('delete'), run('create')).op,
    ).toBe('create')
  })

  it('delete → update (cannot happen) takes the later run only', () => {
    const r = collapseAcross(
      run('delete'),
      run('update', { props: P('y'), set: V({ y: 3 }) }),
    )
    expect(r.op).toBe('update')
    expect([...(r.props ?? [])]).toEqual(['y'])
    expect(r.set?.get('y')).toBe(3)
  })

  it('delete → delete', () => {
    expect(
      collapseAcross(run('delete'), run('delete')).op,
    ).toBe('delete')
  })
})

describe('the one cell where the two tables differ', () => {
  it('create → delete cancels WITHIN a run and NEVER across one', () => {
    // Asserted in ONE test, both directions, so a future edit cannot quietly
    // align the tables. Within one writer's unbroken stretch a node that
    // appeared and vanished is a node no reader can have seen. ACROSS a writer
    // change the same cancel is a lie by omission: one party created the node,
    // another destroyed it, and the party whose work was undone learns
    // nothing.
    expect(
      collapseWithin(run('create'), run('delete')),
    ).toBe(null)

    const across = collapseAcross(
      run('create', { name: 'Card', type: 'FRAME' }),
      run('delete', { type: 'FRAME' }),
    )
    expect(across).not.toBe(null)
    expect(across.op).toBe('delete')
  })
})

describe('what both tables carry across a merge', () => {
  it('takes the LATEST DEFINED name, type, pg and fr', () => {
    const r = collapseAcross(
      run('update', {
        name: 'old',
        type: 'FRAME',
        pg: '1:1',
        fr: '2:2',
      }),
      run('update', { name: 'new' }),
    )
    expect(r.name).toBe('new')
    expect(r.type).toBe('FRAME')
    expect(r.pg).toBe('1:1')
    expect(r.fr).toBe('2:2')
  })

  it('a delete clears name and LEAVES pg/fr from an earlier run', () => {
    // A RemovedNode has no name, and a delete can never locate itself — so the
    // only locator a deleted id can ever carry is the one an earlier run
    // established.
    const r = collapseAcross(
      run('update', {
        name: 'Card',
        pg: '1:1',
        fr: '2:2',
      }),
      run('delete', { type: 'FRAME' }),
    )
    expect(r.name).toBeUndefined()
    expect(r.pg).toBe('1:1')
    expect(r.fr).toBe('2:2')
  })

  it('keeps `set` a SUBSET of `props`, never a different key set', () => {
    // A property in `props` and absent from `set` is the honest "this changed,
    // re-read it". The reverse — a value for a property nothing reports as
    // changed — is not a record any reader can use.
    const r = collapseAcross(
      run('update', { props: P('x'), set: V({ x: 1 }) }),
      run('update', {
        props: P('y'),
        set: V({ y: 2, ghost: 9 }),
      }),
    )
    expect([...(r.props ?? [])].sort()).toEqual(['x', 'y'])
    expect([...(r.set?.keys() ?? [])].sort()).toEqual([
      'x',
      'y',
    ])
  })

  it('holds the subset invariant at the ENTRY to the algebra too', () => {
    // A first record whose `set` names something its `props` does not would
    // seed a run the tables can never repair.
    const seeded = collapseWithin(
      undefined,
      run('update', {
        props: P('x'),
        set: V({ x: 1, ghost: 9 }),
      }),
    )
    expect([...(seeded?.set?.keys() ?? [])]).toEqual(['x'])
    // …and a create carries no `set` at all, whatever it was handed.
    expect(
      collapseWithin(
        undefined,
        run('create', { set: V({ x: 1 }) }),
      )?.set,
    ).toBeUndefined()
  })

  it('drops `set` entirely rather than carrying an empty one', () => {
    const r = collapseAcross(
      run('update', { props: P('x') }),
      run('update', { props: P('y') }),
    )
    expect(r.props?.size).toBe(2)
    expect(r.set).toBeUndefined()
  })

  it('`merged` survives a fold in both tables — order stays lost', () => {
    expect(
      collapseAcross(
        run('update', { props: P('x'), merged: true }),
        run('update', { props: P('y') }),
      ).merged,
    ).toBe(true)
    expect(
      collapseWithin(
        run('update', { props: P('x') }),
        run('update', { props: P('y'), merged: true }),
      )?.merged,
    ).toBe(true)
  })

  it('applies identically over style ops', () => {
    const r = collapseAcross(
      run('style_update', {
        props: P('paints'),
        set: V({ paints: [] }),
      }),
      run('style_update', { props: P('name') }),
    )
    expect(r.op).toBe('style_update')
    expect([...(r.props ?? [])].sort()).toEqual([
      'name',
      'paints',
    ])
    expect(
      collapseWithin(
        run('style_create'),
        run('style_delete'),
      ),
    ).toBe(null)
    expect(
      collapseAcross(
        run('style_create'),
        run('style_delete'),
      ).op,
    ).toBe('style_delete')
  })
})
