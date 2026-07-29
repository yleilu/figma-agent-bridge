import { describe, it, expect } from 'bun:test'
import {
  foldEntry,
  hotspots,
  renderRuns,
} from '@figma-agent-bridge/server/change-feed/fold'
import {
  SELF,
  type BufferRun,
  type BufferEntry,
} from '@figma-agent-bridge/shared/change-feed'

const entry = (
  runs: BufferRun[],
  over: Partial<BufferEntry> = {},
): BufferEntry => {
  const mine = new Set<string>()
  for (const r of runs) {
    if (r.w === SELF) {
      for (const n of r.mine) {
        mine.add(n)
      }
    }
  }
  return {
    runs,
    ...(mine.size > 0 ? { mine } : {}),
    ...over,
  }
}

const foreign = (
  w: string,
  op: BufferRun extends { op: infer O } ? O : never,
  props?: string[],
  set?: Record<string, unknown>,
): BufferRun =>
  ({
    w,
    op,
    ...(props ? { props: new Set(props) } : {}),
    ...(set ? { set: new Map(Object.entries(set)) } : {}),
  }) as BufferRun

const self = (...mine: string[]): BufferRun => ({
  w: SELF,
  mine: new Set(mine),
})

describe('foldEntry — the folded projection', () => {
  it('THE WORKED FAILURE, forward: self then foreign on x', () => {
    // "your write to x landed and someone has since set it to 20"
    const out = foldEntry(
      'n1',
      entry([
        self('x'),
        foreign('B', 'update', ['x'], { x: 20 }),
      ]),
    )
    expect(out).toEqual({
      id: 'n1',
      op: 'update',
      props: ['x'],
      set: { x: 20 },
      src: 'agent',
      mine: ['x'],
    })
  })

  it('THE WORKED FAILURE, mirror: foreign then self on x', () => {
    // This session's own value is the CURRENT one; reporting a stale foreign
    // value for `x` would be the bug. And `x` is absent from the NARROWED
    // `mine` because the record does not report on it.
    const out = foldEntry(
      'n1',
      entry([
        foreign('B', 'update', ['x', 'y'], { x: 1, y: 2 }),
        self('x'),
      ]),
    )
    expect(out).toEqual({
      id: 'n1',
      op: 'update',
      props: ['y'],
      set: { y: 2 },
      src: 'agent',
    })
  })

  it('an entry whose every property is suppressed reports NOTHING', () => {
    expect(
      foldEntry(
        'n1',
        entry([
          foreign('B', 'update', ['x'], { x: 1 }),
          self('x'),
        ]),
      ),
    ).toBe(null)
  })

  it('a self CREATE followed by a foreign DELETE → op delete, mine [create]', () => {
    // "the node you built has been deleted", in one record.
    expect(
      foldEntry(
        'n1',
        entry([self('create'), foreign('B', 'delete')], {
          type: 'FRAME',
          name: 'Card',
        }),
      ),
    ).toEqual({
      id: 'n1',
      type: 'FRAME',
      op: 'delete',
      src: 'agent',
      mine: ['create'],
    })
  })

  it('a foreign CREATE followed by a self DELETE → nothing (a shadow)', () => {
    // There is no node left to act on, and a record announcing one as newly
    // created would send the reader to an id that will not resolve.
    expect(
      foldEntry(
        'n1',
        entry([foreign('B', 'create'), self('delete')]),
      ),
    ).toBe(null)
  })

  it('`src` is CONJUNCTIVE — an agent run plus a user run carries none', () => {
    const out = foldEntry(
      'n1',
      entry([
        foreign('B', 'update', ['x'], { x: 1 }),
        foreign('', 'update', ['y'], { y: 2 }),
      ]),
    )
    expect(out?.props).toEqual(['x', 'y'])
    expect(out?.src).toBeUndefined()
  })

  it('foreign runs fold LEFT TO RIGHT under the ACROSS table (create→delete never cancels)', () => {
    const out = foldEntry(
      'n1',
      entry(
        [foreign('A', 'create'), foreign('B', 'delete')],
        {
          name: 'Card',
        },
      ),
    )
    expect(out?.op).toBe('delete')
    // A RemovedNode has no name.
    expect(out?.name).toBeUndefined()
  })

  it('a folded value takes the LAST foreign run that set it', () => {
    const out = foldEntry(
      'n1',
      entry([
        foreign('A', 'update', ['x'], { x: 1 }),
        foreign('B', 'update', ['x'], { x: 9 }),
      ]),
    )
    expect(out?.set).toEqual({ x: 9 })
  })

  it('the folded `mine` is narrowed to what the record reports on', () => {
    const out = foldEntry(
      'n1',
      entry([
        self('x', 'opacity'),
        foreign('B', 'update', ['x', 'name'], { x: 3 }),
      ]),
    )
    // `opacity` raises no question — no foreign run overwrote it — so naming
    // it would spend tokens to say nothing (T4).
    expect(out?.mine).toEqual(['x'])
  })

  it('carries the entry’s locator through', () => {
    const out = foldEntry(
      'n1',
      entry([foreign('', 'update', ['x'])], {
        pg: '0:1',
        fr: '1:2',
      }),
    )
    expect(out?.pg).toBe('0:1')
    expect(out?.fr).toBe('1:2')
  })

  it('a shadow entry — no foreign run — reports nothing', () => {
    expect(foldEntry('n1', entry([self('x')]))).toBe(null)
  })
})

describe('renderRuns — detail: "runs"', () => {
  it('renders runs oldest first, a self run as a POSITION only', () => {
    const out = renderRuns(
      'n1',
      entry(
        [
          self('x'),
          foreign('B', 'update', ['x'], { x: 20 }),
          self('x'),
          foreign('', 'update', ['y'], { y: 1 }),
        ],
        { type: 'FRAME' },
      ),
    )
    expect(out).toEqual({
      id: 'n1',
      type: 'FRAME',
      mine: ['x'],
      runs: [
        { src: 'self', mine: ['x'] },
        {
          op: 'update',
          props: ['x'],
          set: { x: 20 },
          src: 'agent',
        },
        { src: 'self', mine: ['x'] },
        { op: 'update', props: ['y'], set: { y: 1 } },
      ],
    })
  })

  it('carries `merged` where a run cap folded two runs', () => {
    const merged = {
      ...foreign('A', 'update', ['x']),
      merged: true as const,
    }
    const out = renderRuns('n1', entry([merged]))
    expect(out?.runs?.[0]).toEqual({
      op: 'update',
      props: ['x'],
      src: 'agent',
      merged: true,
    })
  })

  it('`mine` is UNNARROWED in the runs view', () => {
    const out = renderRuns(
      'n1',
      entry([
        self('x', 'opacity'),
        foreign('B', 'update', ['name']),
      ]),
    )
    expect(out?.mine).toEqual(['opacity', 'x'])
  })
})

describe('hotspots — the truncation map', () => {
  const nameOf = (fr: string) =>
    fr === 'f1' ? 'Header' : undefined

  it('buckets by ancestor id, biggest first, and the counts CLOSE', () => {
    const out = hotspots(
      [
        { fr: 'f1', pg: 'p1' },
        { fr: 'f2', pg: 'p1' },
        { fr: 'f1', pg: 'p1' },
        { fr: 'f1', pg: 'p1' },
        {},
      ],
      nameOf,
      8,
    )
    expect(out.total).toBe(5)
    expect(out.frames).toEqual([
      { fr: 'f1', pg: 'p1', name: 'Header', n: 3 },
      { fr: 'f2', pg: 'p1', n: 1 },
    ])
    expect(out.other).toBe(1)
    expect(
      out.frames.reduce((s, f) => s + f.n, 0) + out.other,
    ).toBe(out.total)
  })

  it('everything past HOTSPOT_CAP folds into `other`', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      fr: `f${i}`,
    }))
    const out = hotspots(entries, () => undefined, 3)
    expect(out.frames).toHaveLength(3)
    expect(out.other).toBe(7)
    expect(out.total).toBe(10)
  })

  it('a drain dominated by UNLOCATABLE deletes degrades to a bare count', () => {
    const out = hotspots([{}, {}, {}], () => undefined, 8)
    expect(out).toEqual({ total: 3, frames: [], other: 3 })
  })
})
