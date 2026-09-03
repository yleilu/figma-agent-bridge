// Projection: what a buffered entry looks like on the way out (change-feed.md,
// "`mine` — the evidence that a write landed", "Two tiers of detail" and
// "A truncated drain returns a prefix and a map"). Pure — no buffer, no clock.
import {
  SELF,
  collapseAcross,
  type BufferRun,
  type CollapseRun,
  type DrainedRecord,
  type DrainedRun,
  type ForeignRun,
  type MutationOp,
  type BufferEntry,
} from '@figma-agent-bridge/shared/change-feed'

const isSelf = (
  run: BufferRun,
): run is Extract<BufferRun, { mine: Set<string> }> =>
  run.w === SELF

const kindOf = (
  op: MutationOp,
): 'create' | 'update' | 'delete' =>
  op === 'create' || op === 'style_create'
    ? 'create'
    : op === 'update' || op === 'style_update'
      ? 'update'
      : 'delete'

/** The `update` op of the run's own family. Degrading a `style_delete` to a
 *  NODE `update` would put a node op on a style record. */
const updateOf = (op: MutationOp): MutationOp =>
  op.startsWith('style_') ? 'style_update' : 'update'

/** A structural literal in `mine` pairs with `op`, so it is kept
 *  unconditionally where a property name is narrowed away. */
const STRUCTURAL = new Set([
  'create',
  'delete',
  'style_create',
  'style_delete',
])

const toCollapseRun = (run: ForeignRun): CollapseRun => ({
  op: run.op,
  ...(run.props !== undefined ? { props: run.props } : {}),
  ...(run.set !== undefined ? { set: run.set } : {}),
  ...(run.merged === true ? { merged: true as const } : {}),
})

const sorted = (s: Iterable<string>): string[] =>
  [...new Set(s)].sort()

/** Entry-level identity + locator, shared by both detail modes. */
const shell = (
  id: string,
  entry: BufferEntry,
): DrainedRecord => {
  const out: DrainedRecord = { id }
  if (entry.type !== undefined) {
    out.type = entry.type
  }
  if (entry.name !== undefined) {
    out.name = entry.name
  }
  if (entry.pg !== undefined) {
    out.pg = entry.pg
  }
  if (entry.fr !== undefined) {
    out.fr = entry.fr
  }
  return out
}

/**
 * The folded projection: the foreign runs collapse left to right under the
 * ACROSS table exactly as they would with no self run present, and the self
 * runs then decide — on POSITION alone — which of that result still reaches the
 * reader.
 *
 * Returns `null` when nothing survives. That is not a special case but the same
 * rule reaching zero: the reader's own work is current on everything the entry
 * held, so there is no change relative to it. An entry with no foreign run —
 * a shadow — returns `null` for the same reason.
 */
export const foldEntry = (
  id: string,
  entry: BufferEntry,
): DrainedRecord | null => {
  const foreignRuns = entry.runs.filter(
    (r): r is ForeignRun => !isSelf(r),
  )
  if (foreignRuns.length === 0) {
    return null
  }

  let folded = toCollapseRun(foreignRuns[0])
  for (let i = 1; i < foreignRuns.length; i += 1) {
    folded = collapseAcross(
      folded,
      toCollapseRun(foreignRuns[i]),
    )
  }

  // PER PROPERTY: the LAST run that carried it wins. Walking backwards, the
  // first run to mention a name is its last writer.
  const decided = new Set<string>()
  const suppressed = new Set<string>()
  // EXISTENCE is one dimension for the whole id, decided the same way.
  let existenceIsSelf: boolean | null = null
  for (let i = entry.runs.length - 1; i >= 0; i -= 1) {
    const run = entry.runs[i]
    const names = isSelf(run) ? run.mine : (run.props ?? [])
    for (const name of names) {
      if (!decided.has(name)) {
        decided.add(name)
        if (isSelf(run)) {
          suppressed.add(name)
        }
      }
    }
    const structural = isSelf(run)
      ? [...run.mine].some(n => STRUCTURAL.has(n))
      : kindOf(run.op) !== 'update'
    if (structural && existenceIsSelf === null) {
      existenceIsSelf = isSelf(run)
    }
  }

  let op: MutationOp = folded.op
  if (existenceIsSelf === true) {
    // The id's existence is not news to this reader: it caused it.
    op = updateOf(op)
  }

  const out = shell(id, entry)
  if (kindOf(op) === 'update') {
    const props = [...(folded.props ?? [])]
      .filter(p => !suppressed.has(p))
      .sort()
    if (props.length === 0) {
      // Nothing left to report — the entry is a shadow.
      return null
    }
    out.op = op
    out.props = props
    if (folded.set !== undefined) {
      const set: Record<string, unknown> = {}
      for (const p of props) {
        if (folded.set.has(p)) {
          set[p] = folded.set.get(p)
        }
      }
      if (Object.keys(set).length > 0) {
        out.set = set
      }
    }
  } else {
    // A folded create or delete carries no `props` and no `set`, as it never
    // does; a delete additionally clears `name` (a RemovedNode has none).
    out.op = op
    if (kindOf(op) === 'delete') {
      delete out.name
    }
  }

  // `src` is CONJUNCTIVE over the contributing foreign runs — present only when
  // EVERY one carried it. Self runs contribute nothing to the record and
  // nothing to the label. A record reading `src: 'agent'` while the user had
  // also edited the node would under-warn on the one axis this design refuses
  // to under-warn on.
  if (foreignRuns.every(r => r.w.length > 0)) {
    out.src = 'agent'
  }

  if (entry.mine !== undefined && entry.mine.size > 0) {
    // NARROWED to what the record reports on: the names it shares with `props`,
    // plus any structural literal it holds. A property in `mine` that no
    // foreign run overwrote raises no question, so naming it would spend tokens
    // to say nothing (T4).
    const reported = new Set(out.props ?? [])
    const mine = sorted(entry.mine).filter(
      n => STRUCTURAL.has(n) || reported.has(n),
    )
    if (mine.length > 0) {
      out.mine = mine
    }
  }
  return out
}

/**
 * `detail: 'runs'` — the same entry carrying its runs, oldest first. A SELF run
 * renders as a POSITION and nothing more: without it a node this session and
 * the user took turns on would look, in runs mode, exactly like a node the user
 * edited alone. `mine` is UNNARROWED here.
 */
export const renderRuns = (
  id: string,
  entry: BufferEntry,
): DrainedRecord | null => {
  if (entry.runs.every(isSelf)) {
    return null
  }
  const out = shell(id, entry)
  if (entry.mine !== undefined && entry.mine.size > 0) {
    out.mine = sorted(entry.mine)
  }
  out.runs = entry.runs.map((run): DrainedRun => {
    if (isSelf(run)) {
      return { src: 'self', mine: sorted(run.mine) }
    }
    const rendered: DrainedRun = { op: run.op }
    if (run.props !== undefined && run.props.size > 0) {
      rendered.props = sorted(run.props)
    }
    if (run.set !== undefined && run.set.size > 0) {
      rendered.set = Object.fromEntries(run.set)
    }
    if (run.w.length > 0) {
      rendered.src = 'agent'
    }
    if (run.merged === true) {
      rendered.merged = true
    }
    return rendered
  })
  return out
}

export type Locatable = { fr?: string; pg?: string }

export type Hotspots = {
  total: number
  frames: {
    fr: string
    pg?: string
    name?: string
    n: number
  }[]
  other: number
}

/**
 * A MAP OF WHERE TO LOOK for a truncated drain: mechanical buckets on `fr`,
 * biggest first, capped. `other` absorbs BOTH what cannot be bucketed (deletes,
 * styles, and nodes whose walk failed) and every locatable entry whose frame
 * fell past `cap`, so the counts always close — `total = Σ frames[].n + other`,
 * asserted here rather than assumed, because a map whose numbers do not
 * reconcile is a map a reader cannot act on.
 *
 * NO SEMANTIC SUMMARISING (B1): it buckets by ancestor id and counts.
 * "142 changes under 12:7" is a fact; "the header was redesigned" is an
 * interpretation the feed does not make.
 */
export const hotspots = (
  entries: Iterable<Locatable>,
  /** A `name` is carried where the buffer already holds one for that `fr`:
   *  free where available, absent otherwise, and NEVER worth a lookup. */
  nameOf: (fr: string) => string | undefined,
  cap: number,
): Hotspots => {
  const buckets = new Map<
    string,
    { fr: string; pg?: string; n: number }
  >()
  let total = 0
  for (const e of entries) {
    total += 1
    if (e.fr === undefined) {
      continue
    }
    const held = buckets.get(e.fr)
    if (held === undefined) {
      buckets.set(e.fr, {
        fr: e.fr,
        ...(e.pg !== undefined ? { pg: e.pg } : {}),
        n: 1,
      })
    } else {
      held.n += 1
    }
  }
  // Biggest first; ties broken on the id so the map is deterministic and
  // therefore testable.
  const ranked = [...buckets.values()].sort((a, b) =>
    a.n !== b.n ? b.n - a.n : a.fr < b.fr ? -1 : 1,
  )
  const frames = ranked.slice(0, cap).map(b => {
    const name = nameOf(b.fr)
    return {
      fr: b.fr,
      ...(b.pg !== undefined ? { pg: b.pg } : {}),
      ...(name !== undefined ? { name } : {}),
      n: b.n,
    }
  })
  const other =
    total - frames.reduce((sum, f) => sum + f.n, 0)
  return { total, frames, other: Math.max(0, other) }
}
