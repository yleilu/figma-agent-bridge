// Folds admitted records immediately; the timer only decides WHEN to flush,
// never WHAT to keep (change-feed.md, Plugin-side pipeline §3).
//
// Each map entry holds that id's RUNS — one writer's unbroken stretch of work
// on it. Continuous changes by the same writer set collapse into the open run;
// a change by a DIFFERENT writer set breaks it and opens the next. The break is
// AUTHORITATIVE AT SOURCE: the frame is the only evidence of the order, so a
// boundary lost here cannot be recovered downstream — the server can only fold
// what the frame carries. Frame economy is discretionary; the break at a writer
// change is not.
import {
  RUNS_PER_ID_CAP,
  collapseAcross,
  collapseWithin,
  writerKeyOf,
  type AttributedRecord,
  type CollapseRun,
  type MutationOp,
  type WriterKey,
} from '@figma-agent-bridge/shared/change-feed'

export type ChangeAccumulator = {
  add(rec: AttributedRecord): void
  markIndexStale(): void
  /** Runs across both maps — the unit ACCUM_CAP bounds, a run being what costs
   *  memory. */
  runCount(): number
  /** nodes.size + styles.size — distinct ids, for the eviction stage only. */
  size(): number
  indexStale(): boolean
  /** True only if ACCUM_CAP pressure reached its LAST stage and forced a
   *  distinct id out. Run merges do NOT set it: they lose order, not a
   *  change. */
  overflowed(): boolean
  /** Arm the SAME arm an eviction arms, for a loss that happened OUTSIDE the
   *  accumulator — a drained batch that then failed to leave the plugin. The
   *  records are already gone and cannot be put back, so the only honest
   *  answer left is to tell the next frame that something was lost. */
  markOverflow(): void
  drain(): {
    changes: AttributedRecord[]
    indexStale: boolean
    overflow: boolean
  }
}

/** One writer's unbroken stretch on one id. Writers are NAMES here — the bit
 *  table does not exist until a frame is assembled. */
type Run = {
  /** `writerKeyOf(by)`: what decides whether the next record folds in. */
  key: WriterKey
  by?: ReadonlySet<string>
  rf?: ReadonlySet<string>
  core: CollapseRun
}

type Entry = {
  /** Monotonic, assigned when the id first enters. The maps are separate, so
   *  "the oldest distinct id" is only answerable against a shared clock. */
  seq: number
  runs: Run[]
}

/** Union, never replacement: a set that lost a writer would send that writer
 *  its own work back. Returns the operand itself when the other is empty —
 *  the sets are never mutated in place, so aliasing the scope's memo is safe. */
const unionOf = (
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined => {
  if (a === undefined || a.size === 0) return b
  if (b === undefined || b.size === 0) return a
  const out = new Set(a)
  for (const name of b) out.add(name)
  return out
}

const toCollapseRun = (
  rec: AttributedRecord,
): CollapseRun => {
  const run: CollapseRun = { op: rec.op as MutationOp }
  if (rec.type !== undefined) run.type = rec.type
  if (rec.name !== undefined) run.name = rec.name
  if (rec.props !== undefined)
    run.props = new Set(rec.props)
  if (rec.set !== undefined)
    run.set = new Map(Object.entries(rec.set))
  if (rec.pg !== undefined) run.pg = rec.pg
  if (rec.fr !== undefined) run.fr = rec.fr
  if (rec.merged === true) run.merged = true
  return run
}

const toRecord = (
  id: string,
  run: Run,
): AttributedRecord => {
  const { core } = run
  const rec: AttributedRecord = { op: core.op, id }
  if (core.type !== undefined) rec.type = core.type
  if (core.name !== undefined) rec.name = core.name
  if (core.props !== undefined)
    rec.props = [...core.props].sort()
  if (core.set !== undefined && core.set.size > 0) {
    rec.set = Object.fromEntries(core.set)
  }
  if (core.pg !== undefined) rec.pg = core.pg
  if (core.fr !== undefined) rec.fr = core.fr
  if (core.merged === true) rec.merged = true
  if (run.by !== undefined && run.by.size > 0)
    rec.by = run.by
  if (run.rf !== undefined && run.rf.size > 0)
    rec.rf = run.rf
  return rec
}

export const createAccumulator = (
  cap: number,
  runsPerId: number = RUNS_PER_ID_CAP,
): ChangeAccumulator => {
  const nodes = new Map<string, Entry>()
  const styles = new Map<string, Entry>()
  let page: AttributedRecord | null = null
  let select: AttributedRecord | null = null
  let stale = false
  let overflow = false
  let clock = 0

  const runCount = (): number => {
    let n = 0
    for (const e of nodes.values()) n += e.runs.length
    for (const e of styles.values()) n += e.runs.length
    return n
  }

  /** Merge an entry's two OLDEST immediately-adjacent runs under
   *  `collapseAcross`: their props union, their `set` takes the later value per
   *  property, their keys union, and the survivor is flagged `merged`. The
   *  plugin holds no self runs, so every pair is adjacent. */
  const mergeOldestPair = (entry: Entry): void => {
    const [first, second] = entry.runs
    if (first === undefined || second === undefined) return
    const by = unionOf(first.by, second.by)
    entry.runs.splice(0, 2, {
      key: writerKeyOf(by),
      by,
      rf: unionOf(first.rf, second.rf),
      core: {
        ...collapseAcross(first.core, second.core),
        merged: true,
      },
    })
  }

  /** ACCUM_CAP stage 1: merge runs on the ids holding the MOST, oldest entry
   *  first. Loses order between two runs and nothing else — no change, no
   *  property, no value — so it arms nothing. Returns false once every entry is
   *  a single run. */
  const mergeBiggest = (): boolean => {
    let victim: Entry | null = null
    for (const e of [...nodes.values(), ...styles.values()])
      if (
        e.runs.length >= 2 &&
        (victim === null ||
          e.runs.length > victim.runs.length ||
          (e.runs.length === victim.runs.length &&
            e.seq < victim.seq))
      ) {
        victim = e
      }
    if (victim === null) return false
    mergeOldestPair(victim)
    return true
  }

  /** ACCUM_CAP stage 2, and the only one that loses a CHANGE: evict the oldest
   *  distinct id, across both maps, and report it. A plugin-side loss breaks
   *  EVERY consumer's baseline — the builder's included — so it is never
   *  silent. */
  const evictOldest = (): boolean => {
    let map: Map<string, Entry> | null = null
    let key: string | null = null
    let seq = Number.POSITIVE_INFINITY
    for (const m of [nodes, styles])
      for (const [id, e] of m)
        if (e.seq < seq) {
          seq = e.seq
          map = m
          key = id
        }
    if (map === null || key === null) return false
    map.delete(key)
    overflow = true
    return true
  }

  const enforceCap = (): void => {
    while (runCount() > cap) {
      if (mergeBiggest()) continue
      if (!evictOldest()) return
    }
  }

  const fold = (
    map: Map<string, Entry>,
    rec: AttributedRecord,
  ): void => {
    const id = rec.id
    if (id === undefined) return
    let entry = map.get(id)
    if (entry === undefined) {
      clock += 1
      entry = { seq: clock, runs: [] }
      map.set(id, entry)
    }
    const arriving = toCollapseRun(rec)
    const key = writerKeyOf(rec.by)
    const last = entry.runs[entry.runs.length - 1]

    if (last !== undefined && last.key === key) {
      const next = collapseWithin(last.core, arriving)
      if (next === null) {
        // create → delete under ONE writer inside one unbroken stretch: a node
        // that appeared and vanished is a node no reader can have seen.
        entry.runs.pop()
        if (entry.runs.length === 0) map.delete(id)
        return
      }
      last.core = next
      last.by = unionOf(last.by, rec.by)
      last.rf = unionOf(last.rf, rec.rf)
    } else {
      entry.runs.push({
        key,
        by: rec.by,
        rf: rec.rf,
        core: collapseWithin(
          undefined,
          arriving,
        ) as CollapseRun,
      })
      // Per-id first, so a single contested node cannot spend the global cap
      // on its own history.
      while (entry.runs.length > runsPerId) {
        mergeOldestPair(entry)
      }
    }
    enforceCap()
  }

  return {
    add(rec) {
      if (rec.op === 'page') {
        page = rec
        return
      }
      if (rec.op === 'select') {
        select = rec
        return
      }
      fold(
        rec.op.startsWith('style_') ? styles : nodes,
        rec,
      )
    },
    markIndexStale() {
      stale = true
    },
    runCount,
    size: () => nodes.size + styles.size,
    indexStale: () => stale,
    overflowed: () => overflow,
    markOverflow() {
      overflow = true
    },
    drain() {
      const changes: AttributedRecord[] = []
      // Runs are flattened OLDEST FIRST per id: `params.changes[]` is ordered,
      // and for a given id that order IS the run order.
      for (const map of [nodes, styles])
        for (const [id, entry] of map)
          for (const run of entry.runs)
            changes.push(toRecord(id, run))
      if (page !== null) changes.push(page)
      if (select !== null) changes.push(select)
      const out = {
        changes,
        indexStale: stale,
        overflow,
      }
      nodes.clear()
      styles.clear()
      page = null
      select = null
      stale = false
      overflow = false
      return out
    },
  }
}
