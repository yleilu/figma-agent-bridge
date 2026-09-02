// search-candidates.test.ts — B48: the nodes a live scan loses, recovered from
// the host's export with their CANONICAL ids.

import { describe, expect, it } from 'bun:test'
import {
  candidateFromExport,
  candidatesFromExport,
  componentSetOf,
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

  // B85 — the completeness half. A style census taken from `search` read
  // `results: 1` on Overview where three nodes carried `Glow/Accent`, and
  // `results: 0` on Payments where a designated carrier renders it: every
  // missing carrier sat inside a repaired subtree, and the export row that
  // stood for it carried no style reference for `match:{styleId}` to test.
  // JSON_REST_V1 DOES name them, per node, under `styles`.
  it('carries the export’s own per-node style references (B85)', () => {
    expect(
      candidateFromExport(
        {
          id: 'n',
          styles: {
            fill: 'S:60f91cd0,',
            effect: 'S:aab12233,',
          },
        },
        { styleIds: true },
      )?.styleIds,
    ).toEqual(['S:60f91cd0,', 'S:aab12233,'])
  })

  it('only when the scan asked for them', () => {
    expect(
      'styleIds' in
        candidateFromExport({
          id: 'n',
          styles: { fill: 'S:60f91cd0,' },
        })!,
    ).toBe(false)
  })

  it('omits the key on a node the export gives no styles', () => {
    expect(
      'styleIds' in
        candidateFromExport(
          { id: 'n' },
          { styleIds: true },
        )!,
    ).toBe(false)
  })

  it('takes only string references, and each one once', () => {
    expect(
      candidateFromExport(
        {
          id: 'n',
          styles: {
            fill: 'S:1,',
            stroke: 'S:1,',
            text: 7,
            grid: null,
          },
        },
        { styleIds: true },
      )?.styleIds,
    ).toEqual(['S:1,'])
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
      exportHost: async () => ({ document: frameDoc() }),
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
      exportHost: async () => ({ document: frameDoc() }),
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
        return {
          document: (frameDoc().children as RawNode[])[2],
        }
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
      exportHost: async () => ({ document: frameDoc() }),
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
        return { document: frameDoc() }
      },
    })
    expect(asked).toEqual([0])
  })

  it('honours the repair cap and keeps the uncovered failures as warnings', async () => {
    const asked: number[] = []
    const { warnings, incomplete } = await repairScan({
      ...frameHosted(),
      // Two disjoint hosts — the healthy instances stand in as hosts here.
      failures: [
        { at: 1, host: 1, message: 'first' },
        { at: 2, host: 2, message: 'second' },
      ],
      maxRepairs: 1,
      exportHost: async index => {
        asked.push(index)
        return {
          document: {
            id: '2:2',
            name: '2:2',
            type: 'INSTANCE',
          },
        }
      },
    })
    expect(asked).toEqual([1])
    // B72 — the cut is stated as well as counted. A budget that silently stops
    // repairing returns a short set that looks whole. It is ITEMISED too: the
    // line names the subtree that ran out and how many hosts it left, so the
    // caller can re-scan exactly that subtree (the 2026-09-01 document scan
    // lost 195 rows under 8 named subtrees and its reply named none of them).
    expect(warnings[0]).toBe('second')
    expect(warnings[1]).toContain('per-root budget')
    expect(warnings[1]).toContain('2:1')
    expect(warnings[1]).toContain('1 more')
    expect(incomplete).toBe(true)
  })

  // ── B72: a short set says it is short ────────────────────────────────────
  //
  // The 2026-08-30 document scan lost 8% of instances, 13% of nodes and 17% of
  // TEXT while answering `truncated:false`. It carried 192 warnings naming 13
  // parents, and NONE of the 91 dropped TEXT nodes descended from any of the
  // 13 — so prose could not have told the caller either. Two rubric categories
  // were scored to a false FAIL off it; one of them is a gate condition.
  describe('repairScan — incomplete', () => {
    it('a clean scan is not incomplete', async () => {
      const fixture = frameHosted()
      const { incomplete } = await repairScan({
        ...fixture,
        failures: [],
        exportHost: async () => undefined,
      })
      expect(incomplete).toBe(false)
    })

    it('a repaired failure is not incomplete — nothing was lost', async () => {
      const fixture = frameHosted()
      const { incomplete } = await repairScan({
        ...fixture,
        exportHost: async () => ({ document: frameDoc() }),
      })
      expect(incomplete).toBe(false)
    })

    it('a failure no export covered makes the set incomplete', async () => {
      const fixture = frameHosted()
      const { incomplete, warnings } = await repairScan({
        ...fixture,
        // The host cannot describe itself either, so the subtree stays lost.
        exportHost: async () => undefined,
      })
      expect(incomplete).toBe(true)
      expect(warnings.length).toBeGreaterThan(0)
    })

    it('a TRADED row is not incompleteness — it is present, only thinner', async () => {
      // The chip is a row UNDER the host, so its keys have no export twin the
      // repair can identify (B85 carries the host's own; a deeper alias would
      // need a guess). It is the case that still trades.
      const fixture = frameHosted()
      fixture.candidates[3] = live('298:7519', {
        name: 'Chip',
        context: 'a slot-hosted chip',
      })
      const { incomplete, warnings } = await repairScan({
        ...fixture,
        exportHost: async () => ({ document: frameDoc() }),
      })
      expect(
        warnings.some(w => w.includes('cannot carry')),
      ).toBe(true)
      expect(incomplete).toBe(false)
    })
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

  // Final-review I-1, re-aimed by B85. The C1 round protected the healthy
  // SIBLINGS; the row the repair traded away was the alias ROOT, whose own
  // handle read and which therefore HELD the four live-only keys. Trading them
  // is what an effect-style census paid for: `search({match:{styleId}})`
  // answered `results: 1` where three nodes carried the style, and the two it
  // missed were plainly glowing in the export. The host's live row and
  // `fromExport[0]` are the same node under two spellings, so the keys ride
  // over and there is nothing left to trade.
  it('carries the HOST’s live-only keys onto its export twin', async () => {
    const fixture = frameHosted()
    // The chip read — only its label threw — so it HAS a hinted live row.
    fixture.candidates[3] = live('298:7519', {
      name: 'Chip',
      componentKey: 'k-chip',
      instancesOf: 'Chip',
      styleIds: ['S:chip'],
      context: 'a slot-hosted chip',
    })
    fixture.failures = [
      {
        at: -1,
        host: 3,
        message: 'search: skipped I298:7519;298:7510',
      },
    ]
    const { results, warnings, degraded } =
      await repairScan({
        ...fixture,
        exportHost: async () => ({
          document: (frameDoc().children as RawNode[])[2],
        }),
      })
    const chip = results.find(r => r.id === CANON)
    expect(chip).toMatchObject({
      styleIds: ['S:chip'],
      componentKey: 'k-chip',
      instancesOf: 'Chip',
      context: 'a slot-hosted chip',
    })
    // A census on any of those keys now finds it — under the id the file uses.
    expect(results.some(r => r.instancesOf === 'Chip')).toBe(
      true,
    )
    expect(
      warnings.filter(w => w.includes('cannot carry')),
    ).toEqual([])
    expect(degraded).toBe(0)
  })

  // The residual, and it is a different node: an alias row DEEPER than the
  // host has no export twin this pass can identify, and guessing one would put
  // a node's styles on a different node. That row is still traded — said in
  // `warnings`, and COUNTED, so a completeness check can test it the way it
  // tests `truncated` rather than parsing prose.
  it('names AND counts a traded row it cannot pair', async () => {
    const fixture = frameHosted()
    fixture.candidates[3] = live('298:7519', {
      name: 'Chip',
      componentKey: 'k-chip',
      instancesOf: 'Chip',
      styleIds: ['S:chip'],
      context: 'a slot-hosted chip',
    })
    // host 0 — the FRAME above it — so row 3 is not the export root.
    const { results, warnings, degraded } =
      await repairScan({
        ...fixture,
        exportHost: async () => ({ document: frameDoc() }),
      })
    expect(results.some(r => r.instancesOf === 'Chip')).toBe(
      false,
    )
    const traded = warnings.filter(w =>
      w.includes('298:7519'),
    )
    expect(traded).toHaveLength(1)
    // The subtree that was repaired is the FRAME; the row it cost is the chip.
    expect(traded[0]).toContain('2:1')
    for (const key of [
      'context',
      'styleIds',
      'componentKey',
      'instancesOf',
    ]) {
      expect(traded[0]).toContain(key)
    }
    expect(degraded).toBe(1)
  })

  // B85, the completeness half. The row above cannot be PAIRED — but it does
  // not have to be, because the export names each node's own style references.
  // A census on `match:{styleId}` then finds the carrier under the id the file
  // uses, which is the whole of what the row asked for.
  it('serves styleIds off the export, so the trade no longer costs them', async () => {
    const fixture = frameHosted()
    fixture.candidates[3] = live('298:7519', {
      name: 'Chip',
      componentKey: 'k-chip',
      instancesOf: 'Chip',
      styleIds: ['S:60f91cd0,'],
      context: 'a slot-hosted chip',
    })
    const doc = frameDoc()
    const chipDocNode = (doc.children as RawNode[])[2]
    chipDocNode.styles = { effect: 'S:60f91cd0,' }
    const { results, warnings, degraded } =
      await repairScan({
        ...fixture,
        hints: { styleIds: true },
        exportHost: async () => ({ document: doc }),
      })
    // The carrier is in `results`, addressable, and matchable by style.
    expect(
      results.find(r => r.id === CANON)?.styleIds,
    ).toEqual(['S:60f91cd0,'])
    // …so `styleIds` is no longer named as lost. `context` still is: nothing
    // in an export carries agent-authored plugin data.
    const traded = warnings.filter(w =>
      w.includes('298:7519'),
    )
    expect(traded).toHaveLength(1)
    expect(traded[0]).not.toContain('styleIds')
    expect(traded[0]).toContain('context')
    expect(degraded).toBe(1)
  })

  it('still counts styleIds lost when the export names no style at all', async () => {
    // The honest half stays honest: an export with no `styles` anywhere cannot
    // answer for the key, and `degraded` must keep saying so.
    const fixture = frameHosted()
    fixture.candidates[3] = live('298:7519', {
      name: 'Chip',
      styleIds: ['S:chip'],
    })
    const { warnings } = await repairScan({
      ...fixture,
      hints: { styleIds: true },
      exportHost: async () => ({ document: frameDoc() }),
    })
    expect(
      warnings.filter(w => w.includes('298:7519'))[0],
    ).toContain('styleIds')
  })

  it('says nothing when the dropped row carried no live-only key', async () => {
    // A filter cannot miss what the row never had, and a warning per repair
    // would be the noise B48 spent the batch removing.
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
    const { warnings } = await repairScan({
      ...fixture,
      exportHost: async () => ({
        document: (frameDoc().children as RawNode[])[2],
      }),
    })
    expect(warnings).toEqual([])
  })

  it('repairs nothing on an export that describes nothing', async () => {
    // Superseding on the strength of an empty export would delete the subtree
    // and put nothing back — and silence the failures while doing it.
    const fixture = frameHosted()
    const { results, warnings } = await repairScan({
      ...fixture,
      // A document the candidate builder can make nothing of (no id).
      exportHost: async () => ({
        document: { name: 'anon' },
      }),
    })
    expect(results.map(r => r.id)).toEqual([
      '2:1',
      '2:2',
      '2:3',
    ])
    expect(warnings).toEqual([fixture.failures[0].message])
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
      exportHost: async () => ({ document: frameDoc() }),
    })
    expect(warnings).toEqual(['search: skipped 9:9'])
  })
})

// ─── B56: a slot-nested INSTANCE is findable by instancesOf ───────────────────
//
// `search {instancesOf:'State block'}` answered `results: []` against two
// provable instances. The B48 repair already recovered the rows — but it
// recovered them from the export, and the export row carried no `instancesOf`,
// so the matcher had nothing to match on. Any instancesOf-based acceptance gate
// under-counts a correct design.
//
// The export names the main component by ID (`componentId`), and a main
// component is a plain, top-level node whose handle always answers. So the
// repair carries the id out and resolves the NAME and KEY through the caller.

/** A Chart card instance whose Plot-area slot holds a State block instance. */
const slotHostDoc = (): RawNode => ({
  id: CANON,
  name: 'Chart card',
  type: 'INSTANCE',
  componentId: '453:3800',
  children: [
    {
      id: CANON + ';298:7530',
      name: 'Plot area',
      type: 'FRAME',
      children: [
        {
          id: CANON + ';298:7531',
          name: 'State block',
          type: 'INSTANCE',
          componentId: '454:5477',
        },
      ],
    },
  ],
})

describe('candidateFromExport — component reference (B56)', () => {
  it('carries the main component id out when the caller asked for refs', () => {
    const c = candidateFromExport(
      {
        id: 'x',
        name: 'State block',
        type: 'INSTANCE',
        componentId: '454:5477',
      },
      { componentRef: true },
    )
    expect(c?.mainComponentId).toBe('454:5477')
  })

  it('carries nothing when the caller did not ask', () => {
    const c = candidateFromExport({
      id: 'x',
      name: 'State block',
      type: 'INSTANCE',
      componentId: '454:5477',
    })
    expect('mainComponentId' in (c ?? {})).toBe(false)
  })

  it('carries nothing for a node that is not an instance', () => {
    const c = candidateFromExport(
      { id: 'x', name: 'Plot area', type: 'FRAME' },
      { componentRef: true },
    )
    expect('mainComponentId' in (c ?? {})).toBe(false)
  })
})

describe('repairScan — instancesOf survives the repair (B56)', () => {
  const slotHosted = (): Fixture => ({
    scanned: [
      { id: '2:1', levelsLeft: -1, subtreeEnd: 2 },
      { id: '298:7519', levelsLeft: -1, subtreeEnd: 2 },
    ],
    candidates: [live('2:1', { type: 'FRAME' }), undefined],
    failures: [
      {
        at: 1,
        host: 0,
        message:
          'search: skipped the children of 298:7519: The node does not exist',
      },
    ],
  })

  const hostDoc = (): RawNode => ({
    id: '2:1',
    name: 'Page',
    type: 'FRAME',
    children: [slotHostDoc()],
  })

  it('finds the slot-nested instance by its main component NAME', async () => {
    const { results } = await repairScan({
      ...slotHosted(),
      hints: { componentRef: true },
      exportHost: async () => ({ document: hostDoc() }),
      componentRefOf: async id =>
        id === '454:5477'
          ? { key: 'k-state', name: 'State block' }
          : { key: 'k-chart', name: 'Chart card' },
    })
    const nested = results.find(
      r => r.id === CANON + ';298:7531',
    )
    expect(nested?.instancesOf).toBe('State block')
    expect(nested?.componentKey).toBe('k-state')
    // The slot host itself resolves too — it is an instance as well.
    expect(
      results.find(r => r.id === CANON)?.instancesOf,
    ).toBe('Chart card')
  })

  it('asks for each distinct main component once', async () => {
    const asked: string[] = []
    await repairScan({
      ...slotHosted(),
      hints: { componentRef: true },
      exportHost: async () => ({ document: hostDoc() }),
      componentRefOf: async id => {
        asked.push(id)
        return { name: 'X' }
      },
    })
    expect(asked.length).toBe(new Set(asked).size)
  })

  it('never leaks the internal marker to the caller', async () => {
    const { results } = await repairScan({
      ...slotHosted(),
      hints: { componentRef: true },
      exportHost: async () => ({ document: hostDoc() }),
      componentRefOf: async () => undefined,
    })
    expect(results.some(r => 'mainComponentId' in r)).toBe(
      false,
    )
  })

  it('drops the marker, and claims nothing, with no resolver at all', async () => {
    const { results } = await repairScan({
      ...slotHosted(),
      hints: { componentRef: true },
      exportHost: async () => ({ document: hostDoc() }),
    })
    const nested = results.find(
      r => r.id === CANON + ';298:7531',
    )
    expect(nested).toBeDefined()
    expect('mainComponentId' in (nested ?? {})).toBe(false)
    expect(nested?.instancesOf).toBeUndefined()
  })

  it('stops naming instancesOf as lost when the repair can resolve it', async () => {
    // The trade warning exists because an export row could not carry the four
    // live-only keys. Two of them it now can, so saying they were lost would
    // send an operator hunting a filter that works.
    const fixture = slotHosted()
    fixture.candidates[1] = live('298:7519', {
      name: 'Chart card',
      componentKey: 'k-chart',
      instancesOf: 'Chart card',
      context: 'the chart card',
    })
    // Repaired through the PAGE above it, so the chip is a row under the host
    // and its keys are the ones a trade still costs (B85 carries the host's).
    const { warnings } = await repairScan({
      ...fixture,
      hints: { componentRef: true },
      exportHost: async () => ({ document: hostDoc() }),
      componentRefOf: async () => ({
        key: 'k-chart',
        name: 'Chart card',
      }),
    })
    const traded = warnings.filter(w =>
      w.includes('298:7519'),
    )
    expect(traded).toHaveLength(1)
    expect(traded[0]).toContain('context')
    expect(traded[0]).not.toContain('instancesOf')
    expect(traded[0]).not.toContain('componentKey')
  })
})

// ─── B56 live root cause: the export's own maps, and the FAMILY name ─────────
//
// The first cut of this fix carried `componentId` out and resolved it through a
// live `getNodeByIdAsync`. Live verification says that is not where the answer
// has to come from: the export already carries it. `exportAsync` returns
// `{document, components, componentSets, …}` and the repair kept only
// `document`, so the map that says what `componentId` is CALLED was thrown away
// on every repair.
//
// And the name it resolves to is not the one an operator writes. Live, file
// MFMyzjEZyH5cVyrNejdbyP: 454:5477 is a COMPONENT named `State=Error`, a
// variant of COMPONENT_SET 454:5478 named `State block`. Only `State block` is
// ever visible to a human. Both names travel now.

describe('componentSetOf', () => {
  it('names the set a variant belongs to', () => {
    expect(
      componentSetOf({
        name: 'State=Error',
        parent: {
          type: 'COMPONENT_SET',
          name: 'State block',
        },
      }),
    ).toBe('State block')
  })

  it('answers undefined for a stand-alone component', () => {
    expect(
      componentSetOf({
        name: 'Button',
        parent: { type: 'PAGE', name: 'Page 1' },
      }),
    ).toBeUndefined()
  })

  it('answers undefined rather than throwing on a refusing handle', () => {
    const hostile = {
      name: 'X',
      get parent(): never {
        throw new Error('The node does not exist')
      },
    }
    expect(() => componentSetOf(hostile)).not.toThrow()
    expect(componentSetOf(hostile)).toBeUndefined()
  })
})

describe('repairScan — refs come from the export maps (B56)', () => {
  const variantHosted = (): Fixture => ({
    scanned: [
      { id: '2:1', levelsLeft: -1, subtreeEnd: 2 },
      { id: '298:7519', levelsLeft: -1, subtreeEnd: 2 },
    ],
    candidates: [live('2:1', { type: 'FRAME' }), undefined],
    failures: [
      {
        at: 1,
        host: 0,
        message:
          'search: skipped the children of 298:7519: The node does not exist',
      },
    ],
  })

  /** A Chart card whose Plot-area slot holds a State block VARIANT instance. */
  const variantHost = () => ({
    document: {
      id: '2:1',
      name: 'Page',
      type: 'FRAME',
      children: [
        {
          id: CANON,
          name: 'Chart card',
          type: 'INSTANCE',
          componentId: '453:3878',
          children: [
            {
              id: CANON + ';454:5489',
              name: 'Error block',
              type: 'INSTANCE',
              componentId: '454:5477',
            },
          ],
        },
      ],
    },
    components: {
      '454:5477': {
        key: '1c8fd659',
        name: 'State=Error',
        componentSetId: '454:5478',
      },
      '453:3878': { key: 'e09a5ee5', name: 'Chart card' },
    },
    componentSets: {
      '454:5478': { name: 'State block' },
    },
  })

  const rowsOf = async (
    over: Partial<Parameters<typeof repairScan>[0]> = {},
  ) => {
    const { results } = await repairScan({
      ...variantHosted(),
      hints: { componentRef: true },
      exportHost: async () => variantHost(),
      ...over,
    })
    return new Map(results.map(r => [r.id as string, r]))
  }

  it('names the main from the export map — no live lookup at all', async () => {
    const rows = await rowsOf()
    const nested = rows.get(CANON + ';454:5489')
    expect(nested?.instancesOf).toBe('State=Error')
    expect(nested?.componentKey).toBe('1c8fd659')
  })

  // The live repro: the operator writes the SET name, because it is the only
  // name Figma ever shows them.
  it('carries the FAMILY name, so the set name can match', async () => {
    const rows = await rowsOf()
    expect(
      rows.get(CANON + ';454:5489')?.instancesOfSet,
    ).toBe('State block')
  })

  it('leaves a set-less component with no family name', async () => {
    const rows = await rowsOf()
    const card = rows.get(CANON)
    expect(card?.instancesOf).toBe('Chart card')
    expect('instancesOfSet' in (card ?? {})).toBe(false)
  })

  it('never asks the live resolver for an id the map already named', async () => {
    const asked: string[] = []
    await rowsOf({
      componentRefOf: async id => {
        asked.push(id)
        return undefined
      },
    })
    expect(asked).toEqual([])
  })

  it('falls back to the live resolver when the export omits the maps', async () => {
    // A runtime whose subtree export carries no `components` — the only reason
    // the live resolver still exists.
    const rows = await rowsOf({
      exportHost: async () => ({
        document: variantHost().document,
      }),
      componentRefOf: async id =>
        id === '454:5477'
          ? {
              key: 'k-live',
              name: 'State=Error',
              setName: 'State block',
            }
          : undefined,
    })
    const nested = rows.get(CANON + ';454:5489')
    expect(nested?.instancesOf).toBe('State=Error')
    expect(nested?.instancesOfSet).toBe('State block')
    expect(nested?.componentKey).toBe('k-live')
  })

  it('claims no name when neither the map nor a resolver has one', async () => {
    const rows = await rowsOf({
      exportHost: async () => ({
        document: variantHost().document,
      }),
    })
    const nested = rows.get(CANON + ';454:5489')
    expect(nested).toBeDefined()
    expect(nested?.instancesOf).toBeUndefined()
    expect('mainComponentId' in (nested ?? {})).toBe(false)
  })

  it('reuses one export map across the hosts that follow it', async () => {
    // Two repaired hosts, one master between them: the second must not pay a
    // live lookup for a name the first export already supplied.
    const asked: string[] = []
    const fixture = variantHosted()
    fixture.scanned.push({
      id: '2:9',
      levelsLeft: -1,
      subtreeEnd: 3,
    })
    fixture.candidates.push(undefined)
    fixture.failures.push({
      at: 2,
      host: 2,
      message: 'search: skipped 2:9',
    })
    await repairScan({
      ...fixture,
      hints: { componentRef: true },
      exportHost: async index =>
        index === 0
          ? variantHost()
          : {
              document: {
                id: '2:9',
                name: 'Other',
                type: 'INSTANCE',
                componentId: '454:5477',
              },
            },
      componentRefOf: async id => {
        asked.push(id)
        return undefined
      },
    })
    expect(asked).toEqual([])
  })
})
