import { describe, it, expect } from 'bun:test'
import {
  bitFor,
  resolveIngest,
} from '@figma-agent-bridge/server/change-feed/subtract'
import {
  writerKeyOf,
  type ChangeRecord,
} from '@figma-agent-bridge/shared/change-feed'

const WRITERS = ['A', 'B']
const A = 1 // bit 0
const B = 2 // bit 1

describe('bitFor', () => {
  it('is the writer’s bit in the frame’s table', () => {
    expect(bitFor(WRITERS, 'A')).toBe(1)
    expect(bitFor(WRITERS, 'B')).toBe(2)
  })

  it('is ZERO for a writer the table does not name', () => {
    // "A server whose writer is absent from the table holds no bit and
    // subtracts nothing, which is the correct answer: it caused none of this
    // frame."
    expect(bitFor(WRITERS, 'C')).toBe(0)
    expect(bitFor(undefined, 'A')).toBe(0)
    expect(bitFor([], 'A')).toBe(0)
  })

  it('refuses a table position past the safe bitwise width', () => {
    const wide = Array.from(
      { length: 40 },
      (_, i) => `w${i}`,
    )
    expect(bitFor(wide, 'w30')).toBe(1 << 30)
    expect(bitFor(wide, 'w31')).toBe(0)
  })
})

describe('resolveIngest — the ingest table', () => {
  it('bit in `by` → the whole record becomes a SELF run', () => {
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['x', 'name'],
      set: { x: 20 },
      by: A,
    }
    expect(resolveIngest(rec, WRITERS, 'A')).toEqual({
      kind: 'self',
      mine: ['name', 'x'],
    })
  })

  it('a structural op leaves the OP LITERAL behind, not property names', () => {
    expect(
      resolveIngest(
        { op: 'create', id: 'n1', by: A },
        WRITERS,
        'A',
      ),
    ).toEqual({ kind: 'self', mine: ['create'] })
    expect(
      resolveIngest(
        { op: 'style_delete', id: 'S:1', by: A },
        WRITERS,
        'A',
      ),
    ).toEqual({ kind: 'self', mine: ['style_delete'] })
  })

  it('in NEITHER mask → kept whole, keyed on the surviving `by`', () => {
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: B,
    }
    const out = resolveIngest(rec, WRITERS, 'A')
    expect(out.kind).toBe('foreign')
    expect(out.kind === 'foreign' && out.key).toBe('B')
  })

  it('the USER’s work carries no `by` and resolves to the EMPTY key', () => {
    const out = resolveIngest(
      { op: 'update', id: 'n1', props: ['x'] },
      WRITERS,
      'A',
    )
    expect(out.kind).toBe('foreign')
    expect(out.kind === 'foreign' && out.key).toBe('')
  })

  it('a server with NO bit subtracts nothing', () => {
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['x', 'y'],
      by: A,
      rf: A | B,
    }
    const out = resolveIngest(rec, WRITERS, 'C')
    expect(out.kind).toBe('foreign')
    expect(out.kind === 'foreign' && out.key).toBe('A')
  })

  it('THE CASCADE CASE: `rf` only, `by` empty → subtract CASCADE_PROPS, keep the rename', () => {
    // The live-verified behaviour, ported from the plugin: one record carrying
    // a user's `name` change AND an agent's cascade `y`.
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['name', 'y'],
      set: { name: 'Renamed', y: 40 },
      rf: A,
    }
    const out = resolveIngest(rec, WRITERS, 'A')
    expect(out).toEqual({
      kind: 'split',
      key: '',
      rec: {
        op: 'update',
        id: 'n1',
        props: ['name'],
        set: { name: 'Renamed' },
        rf: A,
      },
      mine: ['y'],
    })
  })

  it('`rf` only and NOTHING survives → the run is dropped, the names kept', () => {
    const out = resolveIngest(
      {
        op: 'update',
        id: 'n1',
        props: ['x', 'y'],
        set: { x: 1, y: 2 },
        rf: A,
      },
      WRITERS,
      'A',
    )
    expect(out).toEqual({ kind: 'self', mine: ['x', 'y'] })
  })

  it('`rf` with ANOTHER WRITER in `by` → KEPT WHOLE, nothing subtracted', () => {
    // An explicit write by somebody else OUTRANKS a cascade explanation.
    // Reflow closures overlap, so a node B deliberately resized carries A's
    // `rf` bit too; subtracting there loses a named write to a cascade A
    // merely COULD have caused — silence, on the most natural shape of
    // multi-agent work.
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['x', 'y'],
      set: { x: 1, y: 2 },
      by: B,
      rf: A,
    }
    const out = resolveIngest(rec, WRITERS, 'A')
    expect(out.kind).toBe('foreign')
    expect(out.kind === 'foreign' && out.rec).toBe(rec)
    expect(out.kind === 'foreign' && out.key).toBe('B')
  })

  it('`rf` on a CREATE or DELETE is kept — subtraction is per PROPERTY', () => {
    expect(
      resolveIngest(
        { op: 'create', id: 'n1', rf: A },
        WRITERS,
        'A',
      ).kind,
    ).toBe('foreign')
    expect(
      resolveIngest(
        { op: 'delete', id: 'n1', rf: A },
        WRITERS,
        'A',
      ).kind,
    ).toBe('foreign')
  })

  it('`rf` on a STYLE record is kept — rf is node-only', () => {
    expect(
      resolveIngest(
        {
          op: 'style_update',
          id: 'S:1',
          props: ['paints'],
          rf: A,
        },
        WRITERS,
        'A',
      ).kind,
    ).toBe('foreign')
  })

  it('`rf` naming NO cascade property changes nothing', () => {
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['name'],
      rf: A,
    }
    const out = resolveIngest(rec, WRITERS, 'A')
    expect(out.kind).toBe('foreign')
    expect(out.kind === 'foreign' && out.rec).toBe(rec)
  })

  it('an UNATTRIBUTED record is kept by EVERY consumer', () => {
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['x'],
    }
    for (const self of ['A', 'B', 'C']) {
      expect(resolveIngest(rec, WRITERS, self).kind).toBe(
        'foreign',
      )
    }
  })

  it('the `_unattributed` writer is a writer like any other', () => {
    const rec: ChangeRecord = {
      op: 'update',
      id: 'n1',
      props: ['x'],
      by: 1,
    }
    expect(
      resolveIngest(rec, ['_unattributed'], '_unattributed')
        .kind,
    ).toBe('self')
  })

  it('a mask naming several writers keys on ALL of them, canonically', () => {
    const out = resolveIngest(
      { op: 'update', id: 'n1', props: ['x'], by: A | B },
      WRITERS,
      'C',
    )
    // {A,B} is a different writer of the same node from {A} or {B}.
    expect(out.kind === 'foreign' && out.key).toBe(
      writerKeyOf(new Set(['B', 'A'])),
    )
    expect(out.kind === 'foreign' && out.key).not.toBe('A')
  })
})
