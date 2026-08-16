// search-candidates.test.ts — B48: the nodes a live scan loses, recovered from
// the host's export with their CANONICAL ids.

import { describe, expect, it } from 'bun:test'
import {
  candidateFromExport,
  candidatesFromExport,
  repairScan,
  type Candidate,
  type ScanEntry,
  type ScanFailure,
} from './search-candidates'
import type { RawNode } from './canonical-ids'

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

// ─── repairScan ───────────────────────────────────────────────────────────────
//
// The scan modelled here is the shape the review found the first fix broke: a
// FRAME whose children are two healthy INSTANCEs — live ids already canonical,
// carrying the reverse-lookup keys only a LIVE read can supply — and one chip
// written into a SLOT, whose own id is a pre-append alias.
//
//   index  id          what it is
//   0      2:1         FRAME, healthy. The HOST, because the chip's own
//                      candidate build threw and it was reached through here.
//   1      2:2         INSTANCE, healthy — styleIds / componentKey /
//                      instancesOf / context
//   2      2:3         INSTANCE, healthy — same
//   3      298:7519    the chip: ALIAS id, unreadable
//
// The frame's export names 2:2 and 2:3 by the ids they already answer, renames
// the chip to CANON, and adds the label the live walk never reached. Repairing
// through index 0 covers all four — which is exactly the range the first fix
// downgraded wholesale.

const live = (
  id: string,
  over: Record<string, unknown> = {},
): Candidate => ({
  id,
  name: id,
  type: 'INSTANCE',
  size: [10, 10],
  ...over,
})

type Fixture = {
  scanned: ScanEntry[]
  candidates: (Candidate | undefined)[]
  failures: ScanFailure[]
}

/** The C1 shape: the chip is unreadable, so the FRAME is the host. */
const frameHosted = (): Fixture => ({
  scanned: [
    { id: '2:1', levelsLeft: -1, subtreeEnd: 4 },
    { id: '2:2', levelsLeft: -1, subtreeEnd: 2 },
    { id: '2:3', levelsLeft: -1, subtreeEnd: 3 },
    { id: '298:7519', levelsLeft: -1, subtreeEnd: 4 },
  ],
  candidates: [
    live('2:1', { type: 'FRAME' }),
    live('2:2', {
      styleIds: ['S:abc'],
      componentKey: 'k-a',
      instancesOf: 'Button',
      context: 'primary action',
    }),
    live('2:3', {
      styleIds: ['S:abc'],
      componentKey: 'k-b',
      instancesOf: 'Button',
    }),
    // The chip's own candidate build threw — no live row for it.
    undefined,
  ],
  failures: [
    {
      at: 3,
      host: 0,
      message:
        'search: skipped 298:7519: in get_name: The node does not exist',
    },
  ],
})

/** The frame's export: healthy children keep their ids, the chip is renamed. */
const frameDoc = (): RawNode => ({
  id: '2:1',
  name: '2:1',
  type: 'FRAME',
  children: [
    { id: '2:2', name: '2:2', type: 'INSTANCE' },
    { id: '2:3', name: '2:3', type: 'INSTANCE' },
    {
      id: CANON,
      name: 'Chip',
      type: 'INSTANCE',
      children: [
        {
          id: CANON + ';298:7510',
          name: 'Label',
          type: 'TEXT',
          characters: 'PROBE-SLOT-STRING',
        },
      ],
    },
  ],
})

describe('repairScan — repair without downgrading (C1)', () => {
  it('keeps a healthy sibling LIVE, with the fields no export can carry', async () => {
    const { results } = await repairScan({
      ...frameHosted(),
      exportHost: async () => frameDoc(),
    })
    const byId = new Map(
      results.map(r => [r.id as string, r]),
    )
    // The finding itself: these two read fine, and a repair next door must not
    // cost them the keys `match:{instancesOf|componentKey|styleId}` runs on.
    expect(byId.get('2:2')).toMatchObject({
      styleIds: ['S:abc'],
      componentKey: 'k-a',
      instancesOf: 'Button',
      context: 'primary action',
    })
    expect(byId.get('2:3')).toMatchObject({
      componentKey: 'k-b',
      instancesOf: 'Button',
    })
    // …and the host is a healthy node too.
    expect(byId.get('2:1')).toMatchObject({ type: 'FRAME' })
  })

  it('recovers the lost subtree once, under its canonical ids', async () => {
    const { results } = await repairScan({
      ...frameHosted(),
      hints: { characters: true },
      exportHost: async () => frameDoc(),
    })
    const ids = results.map(r => r.id)
    expect(ids).toContain(CANON)
    expect(ids).toContain(CANON + ';298:7510')
    // The alias never reaches the caller, and nothing is listed twice.
    expect(ids).not.toContain('298:7519')
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      results.find(r => r.id === CANON + ';298:7510')
        ?.characters,
    ).toBe('PROBE-SLOT-STRING')
  })

  it('drops the ALIAS row when the node DID build a live candidate', async () => {
    // Same tree, but the chip itself read — only its label threw. The chip's
    // live row carries the pre-append id, which the export does not name.
    const fixture = frameHosted()
    fixture.candidates[3] = live('298:7519', {
      name: 'Chip',
    })
    fixture.failures = [
      {
        at: -1,
        host: 3,
        message: 'search: skipped I298:7519;298:7510',
      },
    ]
    const { results } = await repairScan({
      ...fixture,
      exportHost: async index => {
        expect(index).toBe(3)
        return (frameDoc().children as RawNode[])[2]
      },
    })
    const ids = results.map(r => r.id)
    expect(ids).not.toContain('298:7519')
    expect(ids).toContain(CANON)
    // The siblings are outside this host's range and untouched either way.
    expect(ids).toContain('2:2')
    expect(ids).toContain('2:3')
  })

  it('says nothing when the export covered the loss', async () => {
    const { warnings } = await repairScan({
      ...frameHosted(),
      exportHost: async () => frameDoc(),
    })
    expect(warnings).toEqual([])
  })

  it('still warns when the host cannot describe itself either', async () => {
    const { results, warnings } = await repairScan({
      ...frameHosted(),
      exportHost: async () => undefined,
    })
    expect(warnings).toHaveLength(1)
    // …and nothing was thrown away on the strength of an export that failed.
    expect(results.map(r => r.id)).toEqual([
      '2:1',
      '2:2',
      '2:3',
    ])
  })

  it('warns, and changes nothing, for a failure with no host', async () => {
    const { results, warnings } = await repairScan({
      ...frameHosted(),
      failures: [
        { at: -1, host: -1, message: 'search: skipped …' },
      ],
      exportHost: async () => {
        throw new Error('must not be asked')
      },
    })
    expect(warnings).toHaveLength(1)
    expect(results).toHaveLength(3)
  })

  it('lets an ancestor absorb a nested host — one export, not two', async () => {
    const fixture = frameHosted()
    const asked: number[] = []
    await repairScan({
      ...fixture,
      failures: [
        ...fixture.failures,
        { at: -1, host: 3, message: 'search: skipped …' },
      ],
      exportHost: async index => {
        asked.push(index)
        return frameDoc()
      },
    })
    expect(asked).toEqual([0])
  })

  it('honours the repair cap and keeps the uncovered failures as warnings', async () => {
    const asked: number[] = []
    const { warnings } = await repairScan({
      ...frameHosted(),
      // Two disjoint hosts — the healthy instances stand in as hosts here.
      failures: [
        { at: 1, host: 1, message: 'first' },
        { at: 2, host: 2, message: 'second' },
      ],
      maxRepairs: 1,
      exportHost: async index => {
        asked.push(index)
        return { id: '2:2', name: '2:2', type: 'INSTANCE' }
      },
    })
    expect(asked).toEqual([1])
    expect(warnings).toEqual(['second'])
  })

  it('a scan with no failures is returned untouched', async () => {
    const fixture = frameHosted()
    const { results, warnings } = await repairScan({
      ...fixture,
      failures: [],
      exportHost: async () => {
        throw new Error('must not be asked')
      },
    })
    expect(results).toEqual(
      fixture.candidates.filter(c => c !== undefined),
    )
    expect(warnings).toEqual([])
  })

  it('keeps a warning whose failing node sits outside the repaired slice (M3)', async () => {
    // An overlapping-selection scan appends a second, deeper visit's finds
    // AFTER the first visit's range. A host inside that range must not silence
    // a failure that landed outside it.
    const fixture = frameHosted()
    fixture.scanned.push({
      id: '9:9',
      levelsLeft: -1,
      subtreeEnd: 5,
    })
    fixture.candidates.push(live('9:9'))
    fixture.failures = [
      { at: 4, host: 0, message: 'search: skipped 9:9' },
    ]
    const { warnings } = await repairScan({
      ...fixture,
      exportHost: async () => frameDoc(),
    })
    expect(warnings).toEqual(['search: skipped 9:9'])
  })
})
