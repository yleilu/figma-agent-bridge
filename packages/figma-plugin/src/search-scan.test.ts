// search-scan.test.ts — B62: the walk crosses a slot-hosted instance, and the
// subtree under it comes back CANONICAL rather than as a warning.
//
// The fake models the two Figma facts that produced the defect, and nothing
// else:
//
//   1. A node written into a component SLOT keeps its pre-append id, so its
//      live handle answers a PLAIN id (`487:9419`) while the file calls it
//      `I487:9331;487:8143;487:9497`. Figma composes that node's children off
//      the id the HANDLE answers, so each child comes back addressed
//      `I487:9419;<local>` — an address the file does not use.
//   2. Such a handle is not dead. It answers `id`, `name`, `type` and its size,
//      and refuses exactly one read: `get_children`. That is why the scan
//      returned a complete-looking row under an unusable id instead of failing
//      loudly, and why naming that node as its own repair host could never
//      work — `exportAsync` refuses the same address `get_children` refuses.
//
// `trueId` is the test's oracle: the id the file uses, which is the only id a
// caller can hand back. It is deliberately NOT derivable from the live id.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanFrom } from './search-scan'
import {
  repairScan,
  componentSetOf,
  type Candidate,
  type ExportedHost,
} from './search-candidates'
import type { LiveNode } from './canonical-ids'

// ─── the fake document ────────────────────────────────────────────────────────

type Fake = LiveNode & {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  children?: Fake[]
  /** The id the FILE uses for this node — the test's oracle. */
  trueId: string
  /** Models a fabricated address: every child read refuses. */
  fabricated?: boolean
  /** For an INSTANCE: the main component this node is an instance of. */
  mainId?: string
}

const REFUSAL =
  'in get_children: The node (instance sublayer or table cell) with id "X" does not exist'

/**
 * The file's own record of a node — what an export reads, and what the test
 * knows. Kept SEPARATE from the live handle below, because the whole defect is
 * that the two disagree and the live side refuses to be asked.
 */
const kidsOf = new Map<Fake, Fake[]>()

/**
 * One live handle. A fabricated address answers everything the scan reads
 * cheaply and throws on `children` — the exact asymmetry the live artifact
 * showed (89 `get_children` refusals, not one `get_name` refusal).
 */
const node = (f: Fake): Fake => {
  const kids = f.children ?? []
  const handle: Fake = {
    ...f,
    get children(): Fake[] {
      if (f.fabricated === true) {
        throw new Error(REFUSAL.replace('X', f.id))
      }
      return kids
    },
  }
  kidsOf.set(handle, kids)
  return handle
}

/** `I487:9331;487:8143;487:9497` — the chip's canonical address. */
const CHIP_TRUE = 'I487:9331;487:8143;487:9497'

const label = node({
  id: 'I487:9419;487:8704',
  trueId: CHIP_TRUE + ';487:8704',
  name: 'State',
  type: 'TEXT',
  width: 40,
  height: 16,
  fabricated: true,
})
const dot = node({
  id: 'I487:9419;487:8705',
  trueId: CHIP_TRUE + ';487:8705',
  name: 'Dot',
  type: 'INSTANCE',
  width: 8,
  height: 8,
  mainId: '487:7900',
  fabricated: true,
})
/** Slot CONTENT: a real, readable handle under a PLAIN, pre-append id. */
const chip = node({
  id: '487:9419',
  trueId: CHIP_TRUE,
  name: 'Status chip',
  type: 'INSTANCE',
  width: 72,
  height: 24,
  mainId: '487:7898',
  children: [label, dot],
})
const slot = node({
  id: 'I487:9331;487:8143',
  trueId: 'I487:9331;487:8143',
  name: 'content',
  type: 'FRAME',
  width: 72,
  height: 24,
  children: [chip],
})
const card = node({
  id: '487:9331',
  trueId: '487:9331',
  name: 'Counterparty card',
  type: 'INSTANCE',
  width: 240,
  height: 64,
  mainId: '487:7880',
  children: [slot],
})

/** Every id the FILE uses, which is every id a search may emit. */
const TRUE_IDS = new Set(
  [card, slot, chip, label, dot].map(n => n.trueId),
)

// ─── the export, which is the only oracle for the ids above ──────────────────

type Raw = Record<string, unknown>

const exported = (n: Fake): Raw => {
  const kids = kidsOf.get(n) ?? []
  return {
    id: n.trueId,
    name: n.name,
    type: n.type,
    width: n.width,
    height: n.height,
    ...(n.mainId === undefined
      ? {}
      : { componentId: n.mainId }),
    ...(kids.length === 0
      ? {}
      : { children: kids.map(exported) }),
  }
}

const COMPONENTS = {
  '487:7880': { key: 'k-card', name: 'Counterparty card' },
  '487:7898': {
    key: 'k-paused',
    name: 'State=PAUSED',
    componentSetId: '487:7890',
  },
  '487:7900': { key: 'k-dot', name: 'Dot' },
}
const COMPONENT_SETS = {
  '487:7890': { name: 'Status chip' },
}

/**
 * `exportAsync({format:'JSON_REST_V1'})`, as Figma answers it: a real handle
 * describes its subtree canonically, a fabricated address refuses.
 */
const exportOf = (n: Fake): ExportedHost | undefined => {
  if (n.fabricated === true) return undefined
  return {
    document: exported(n),
    components: COMPONENTS,
    componentSets: COMPONENT_SETS,
  }
}

// ─── the scan + enrichment, exactly as the SEARCH case runs them ─────────────

/**
 * The candidate build, modelled on `code.ts`'s enrichment loop: the base
 * candidate plus the hinted component ref, guarded per node.
 */
const sweep = async (): Promise<{
  results: Candidate[]
  warnings: string[]
  hostOf: (id: string) => number
  indexOf: (id: string) => number
}> => {
  const { scanned, failures } = scanFrom([card], -1)
  const candidates: (Candidate | undefined)[] = []
  for (let i = 0; i < scanned.length; i++) {
    const fn = scanned[i].node
    candidates.push(undefined)
    try {
      const candidate: Candidate = {
        id: fn.id,
        name: fn.name,
        type: fn.type,
        size: [fn.width, fn.height],
      }
      if (
        fn.type === 'INSTANCE' &&
        fn.mainId !== undefined
      ) {
        const main = COMPONENTS[
          fn.mainId as keyof typeof COMPONENTS
        ] as { key: string; name: string } | undefined
        if (main !== undefined) {
          candidate.componentKey = main.key
          candidate.instancesOf = main.name
        }
      }
      candidates[i] = candidate
    } catch {
      failures.push({
        at: i,
        host: scanned[i].parentIndex,
        message: 'search: skipped ' + scanned[i].id,
      })
    }
  }
  const repaired = await repairScan({
    scanned,
    candidates,
    failures,
    hints: { componentRef: true },
    exportHost: async index =>
      exportOf(scanned[index].node),
    componentRefOf: async componentId => {
      const main = COMPONENTS[
        componentId as keyof typeof COMPONENTS
      ] as
        | {
            key: string
            name: string
            componentSetId?: string
          }
        | undefined
      return main === undefined
        ? undefined
        : {
            key: main.key,
            name: main.name,
            setName:
              main.componentSetId === undefined
                ? undefined
                : COMPONENT_SETS[
                    main.componentSetId as keyof typeof COMPONENT_SETS
                  ].name,
          }
    },
  })
  const indexOf = (id: string): number =>
    scanned.findIndex(s => s.id === id)
  const hostOf = (id: string): number => {
    const found = failures.find(f => f.message.includes(id))
    return found === undefined ? -2 : found.host
  }
  return { ...repaired, hostOf, indexOf }
}

describe('B62 — the walk names an ANCESTOR as the host', () => {
  it('actually reaches the fabricated addresses (liveness)', () => {
    const { scanned } = scanFrom([card], -1)
    expect(scanned.map(s => s.id)).toEqual([
      '487:9331',
      'I487:9331;487:8143',
      '487:9419',
      'I487:9419;487:8704',
      'I487:9419;487:8705',
    ])
  })

  it('never names a refusing node as its own host', async () => {
    const { hostOf, indexOf } = await sweep()
    // The chip is what the fabricated children were reached THROUGH, and it is
    // the only party that can export them.
    const chipIndex = indexOf('487:9419')
    expect(chipIndex).toBeGreaterThan(0)
    expect(hostOf('I487:9419;487:8704')).toBe(chipIndex)
    expect(hostOf('I487:9419;487:8705')).toBe(chipIndex)
  })
})

describe('B62 — a doc-scoped sweep comes back whole', () => {
  it('emits no skip warning at all', async () => {
    const { warnings } = await sweep()
    expect(
      warnings.filter(w => w.includes('skipped')),
    ).toEqual([])
    expect(warnings).toEqual([])
  })

  it('emits only ids the FILE uses', async () => {
    const { results } = await sweep()
    const ids = results.map(r => r.id as string)
    // The fabricated address is gone, and every id left is one the export
    // names — which is the only kind a caller can hand back (T2).
    expect(ids).not.toContain('I487:9419;487:8704')
    expect(ids).not.toContain('I487:9419;487:8705')
    expect(ids).not.toContain('487:9419')
    for (const id of ids) {
      expect(TRUE_IDS.has(id)).toBe(true)
    }
  })

  it('finds every INSTANCE descendant, three levels down', async () => {
    const { results } = await sweep()
    const instances = results.filter(
      r => r.type === 'INSTANCE',
    )
    expect(
      instances.map(r => r.id as string).sort(),
    ).toEqual([card.trueId, chip.trueId, dot.trueId].sort())
  })

  it('keeps the slot-nested chip matchable by its FAMILY name', async () => {
    const { results } = await sweep()
    const found = results.find(
      r => r.id === chip.trueId,
    ) as Candidate
    expect(found.instancesOf).toBe('State=PAUSED')
    expect(found.instancesOfSet).toBe('Status chip')
    expect(found.componentKey).toBe('k-paused')
  })
})

// ─── B72: one root cannot spend another root's repair budget ─────────────────
//
// LIVE EVIDENCE (2026-09-01 dashboard, dev 9d306cf). The same four pages,
// minutes apart, through the same tool:
//
//   document scope   1477 rows
//   page scope ×4    1646 rows   (358 / 437 / 507 / 344)
//
// All 195 missing rows sat on the LAST TWO pages — Payments 44, Counterparties
// 151 — under 8 subtree roots, and the first two pages lost NOTHING. Neither
// result set held a single duplicate id, so nothing was deduped away. The four
// pages need 33 / 12 / 17 / 13 repairs; the shared cap is 50, and the first two
// pages spend 45 of it. That is an in-order budget, and it is the only
// candidate that predicts a loss ordered by page.
//
// The fake is the smallest document with that shape: two roots, each holding
// one degraded subtree, and a cap of one.
describe('B72 — the repair budget is spent PER ROOT', () => {
  const degraded = (n: number) => {
    const inner = node({
      id: 'I9:' + n + ';8:1',
      trueId: 'I7:' + n + ';8:0;8:1',
      name: 'Cell',
      type: 'TEXT',
      width: 40,
      height: 16,
      fabricated: true,
    })
    const content = node({
      id: '9:' + n,
      trueId: 'I7:' + n + ';8:0',
      name: 'Row',
      type: 'INSTANCE',
      width: 100,
      height: 24,
      children: [inner],
    })
    return node({
      id: '7:' + n,
      trueId: '7:' + n,
      name: 'Page root ' + n,
      type: 'FRAME',
      width: 200,
      height: 100,
      children: [content],
    })
  }

  const sweepRoots = async (maxRepairs: number) => {
    const roots = [degraded(1), degraded(2)]
    const { scanned, failures } = scanFrom(roots, -1)
    const candidates: (Candidate | undefined)[] =
      scanned.map(s => ({
        id: s.id,
        name: s.node.name,
        type: s.node.type,
      }))
    return {
      scanned,
      ...(await repairScan({
        scanned,
        candidates,
        failures,
        maxRepairs,
        exportHost: async index =>
          exportOf(scanned[index].node),
      })),
    }
  }

  it('attributes every scanned node to the start it came from', () => {
    const { scanned } = scanFrom(
      [degraded(1), degraded(2)],
      -1,
    )
    expect(
      scanned.map(s => [s.id, s.root] as const),
    ).toEqual([
      ['7:1', 0],
      ['9:1', 0],
      ['I9:1;8:1', 0],
      ['7:2', 3],
      ['9:2', 3],
      ['I9:2;8:1', 3],
    ])
  })

  it('repairs the SECOND root after the first has spent its share', async () => {
    const { results, incomplete } = await sweepRoots(1)
    const ids = results.map(r => r.id as string)
    // Before the fix the budget stopped at the first root and root 2's cell
    // was simply gone — the 2026-09-01 shape, at two rows instead of 195.
    expect(ids).toContain('I7:1;8:0;8:1')
    expect(ids).toContain('I7:2;8:0;8:1')
    expect(incomplete).toBe(false)
  })

  it('names the ROOT and the count when a root really does run out', async () => {
    const roots = [degraded(1)]
    const { scanned, failures } = scanFrom(roots, -1)
    const { warnings, incomplete } = await repairScan({
      scanned,
      candidates: scanned.map(s => ({ id: s.id })),
      failures: [
        ...failures,
        // A second, disjoint host under the same root.
        { at: -1, host: 0, message: 'search: skipped …' },
      ],
      maxRepairs: 0,
      exportHost: async index =>
        exportOf(scanned[index].node),
    })
    expect(incomplete).toBe(true)
    const cut = warnings.find(w =>
      w.includes('per-root budget'),
    ) as string
    // Itemised: which subtree, how many were left, and how to get them.
    expect(cut).toContain('7:1')
    expect(cut).toContain('2 more')
    expect(cut).toContain('scope:"node"')
  })
})

// ─── B72, the other candidate: the dedup drop ────────────────────────────────
//
// `if (fresh)` guards the push and not the descent, so a node whose id another
// node already answered is dropped from the results while its children are
// still walked. FALSIFIED as the mechanism behind the 2026-09-01 loss — that
// artifact's 1646 rows carried 1646 distinct ids, and its document scan's 1477
// carried 1477 — but the hole is real and it was silent.
describe('B72 — two nodes, one id', () => {
  const twin = (name: string) =>
    node({
      id: '11:1',
      trueId: '11:1',
      name,
      type: 'FRAME',
      width: 10,
      height: 10,
    })

  it('keeps one row and NAMES the one it dropped', () => {
    const { scanned, failures } = scanFrom(
      [twin('first'), twin('second')],
      -1,
    )
    expect(scanned).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toContain('11:1')
    expect(failures[0].message).toContain('two nodes')
  })

  it('stays silent when the SAME handle is reached twice', () => {
    const shared = twin('once')
    const { scanned, failures } = scanFrom(
      [shared, shared],
      -1,
    )
    expect(scanned).toHaveLength(1)
    expect(failures).toEqual([])
  })
})

// The whole point of extracting the walk is that `code.ts` can no longer hold a
// second copy of it. `code.ts` calls `figma.showUI(__html__)` at module scope,
// so it cannot be imported outside Figma — hence a source scan, carrying its
// own liveness assertions (the house pattern, see apply-wiring.test.ts).
describe('SEARCH scan wiring', () => {
  const callers =
    // eslint-disable-next-line n/no-sync -- test-only source scan
    readFileSync(join(import.meta.dir, 'code.ts'), 'utf8')
  const searchCase = callers.slice(
    callers.indexOf('case COMMANDS.SEARCH'),
    callers.indexOf('case COMMANDS.CREATE_NODE'),
  )

  it('actually found the case (liveness)', () => {
    expect(searchCase.length).toBeGreaterThan(200)
    expect(searchCase.length).toBeLessThan(callers.length)
    expect(searchCase).toContain('repairScan(')
  })

  it('walks through the shared scan, not a private copy', () => {
    expect(searchCase).toContain('scanFrom(')
    // The `host` a failure names is the whole fix; a hand-rolled recursion in
    // here could reintroduce the self-host with every test above still green.
    expect(searchCase).not.toContain('host: index')
  })

  it('hands the enrichment failure the ancestor too', () => {
    expect(searchCase).toContain(
      'host: scanned[index].parentIndex',
    )
  })
})

// componentSetOf is imported above so the family-name path this file asserts on
// stays bound to the module that owns it.
describe('family name (liveness)', () => {
  it('reads a variant’s set name', () => {
    expect(
      componentSetOf({
        name: 'State=PAUSED',
        parent: {
          type: 'COMPONENT_SET',
          name: 'Status chip',
        },
      }),
    ).toBe('Status chip')
  })
})
