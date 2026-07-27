// The change-feed wire contract + the collapse algebra, shared by the plugin
// accumulator and the server buffer so the two can never disagree
// (change-feed.md, "Collapse has one owner and one subordinate").

export type MutationOp =
  | 'create'
  | 'update'
  | 'delete'
  | 'style_create'
  | 'style_update'
  | 'style_delete'

export type ChangeOp = MutationOp | 'page' | 'select'

export type ChangeRecord = {
  op: ChangeOp
  /** node / style / page id. ABSENT for op:'select'. */
  id?: string
  /** node/style type. On delete this plus id is ALL Figma gives. */
  type?: string
  /** best-effort; present on create/update/page, ABSENT on delete. */
  name?: string
  /** update / style_update ONLY: changed property names, sorted, deduped. */
  props?: string[]
  /** select ONLY: the current selection, capped at SELECT_IDS_CAP. */
  ids?: string[]
  /** select ONLY: the TRUE selection size when it exceeds SELECT_IDS_CAP. */
  count?: number
}

export type BufferEntry = {
  op: MutationOp
  type?: string
  name?: string
  props?: Set<string>
}

export type BaselineState = 'ok' | 'no_baseline' | 'gap'

/** The body of a `document_changed` push. Identity rides in `meta`. */
export type DocumentChangedParams = {
  changes: ChangeRecord[]
  indexStale: boolean
  overflow?: true
  at: number
}

// ── Tuning constants ────────────────────────────────────────────────────────
// Every one of these is TUNING, not contract, EXCEPT SETTLE_MS, which is an
// empirical fact — see docs/reference/change-feed-poc-results.md.

/**
 * Self-write window hold after a command settles. SET BY MEASUREMENT, not
 * chosen: docs/reference/change-feed-poc-results.md measured the
 * `documentchange` batch period at p99.9 = 100 ms across nine command shapes,
 * and swept this constant to find the filter's empirical floor — 120 ms
 * passes, 80 ms fails OPEN (every agent write reads as a user edit and
 * pending_edits never returns to 0). 400 ms is 4x the measured p99.9 and 3.3x
 * that floor; the opposite failure (a window wide enough to swallow the user's
 * concurrent edits) was tested at this value and did not occur.
 *
 * Do NOT change on a hunch — re-run the POC.
 * packages/shared/test/change-feed.test.ts pins it against both measurements.
 */
export const SETTLE_MS = 400

export const FLUSH_DEBOUNCE_MS = 300
export const FLUSH_MAX_WAIT_MS = 2000
/** An order below the relay bucket's 50/s refill: the feed must never spend
 *  budget a paired command REPLY needs on the same socket. */
export const FEED_FRAMES_PER_SEC = 5
export const SELECT_IDS_CAP = 20
export const ACCUM_CAP = 500
export const BUFFER_CAP = 2000
export const DRAIN_LIMIT = 100
export const COUNT_DEBOUNCE_MS = 500
/** A sentinel older than this reads as NO SIGNAL: its session never "ends", so
 *  a killed process would otherwise leave a count file that never expires.
 *  Long enough that a live quiet session's sentinel survives a working day.
 *
 *  DECLARED HERE, ENFORCED BY THE HOOK. The only code that expires a sentinel
 *  is `plugin/hooks/presence`'s `read_count`, which cannot import TypeScript and
 *  so hardcodes `SENTINEL_TTL_SEC=43200`. The two are held together by the
 *  parity test in test/presence-hook.test.ts — change one and that test goes
 *  red. Never edit one number alone. */
export const SENTINEL_TTL_MS = 12 * 60 * 60 * 1000

const kindOf = (
  op: MutationOp,
): 'create' | 'update' | 'delete' =>
  op === 'create' || op === 'style_create'
    ? 'create'
    : op === 'update' || op === 'style_update'
      ? 'update'
      : 'delete'

/**
 * The collapse algebra, applied per id. `held` is the entry already stored,
 * `arriving` the new record. Returns the entry to store, or `null` to REMOVE
 * the entry (the create→delete cancel). TOTAL: cells that "cannot happen"
 * (update→create, delete→update) are specified, because event reordering is
 * possible and a table with holes says nothing at the moment it matters.
 */
export const collapse = (
  held: BufferEntry | undefined,
  arriving: BufferEntry,
): BufferEntry | null => {
  if (held === undefined) {
    return arriving
  }
  const h = kindOf(held.op)
  const a = kindOf(arriving.op)
  const type = arriving.type ?? held.type
  const name = arriving.name ?? held.name

  if (h === 'create' && a === 'delete') {
    return null
  }
  if (a === 'delete') {
    return { op: arriving.op, type }
  }
  if (h === 'create' && a === 'update') {
    return { op: held.op, type, name }
  }
  if (a === 'create') {
    return { op: arriving.op, type, name }
  }
  if (h === 'update' && a === 'update') {
    return {
      op: arriving.op,
      type,
      name,
      props: new Set([
        ...(held.props ?? []),
        ...(arriving.props ?? []),
      ]),
    }
  }
  // held delete → arriving update: props are the arriving set only.
  return {
    op: arriving.op,
    type,
    name,
    props: new Set(arriving.props ?? []),
  }
}

/** ChangeRecord → BufferEntry (the storage shape: props as a Set). */
export const toEntry = (rec: ChangeRecord): BufferEntry => {
  const entry: BufferEntry = { op: rec.op as MutationOp }
  if (rec.type !== undefined) {
    entry.type = rec.type
  }
  if (rec.name !== undefined) {
    entry.name = rec.name
  }
  if (rec.props !== undefined) {
    entry.props = new Set(rec.props)
  }
  return entry
}

/** BufferEntry → ChangeRecord (the wire shape: props sorted + deduped). */
export const toRecord = (
  id: string,
  entry: BufferEntry,
): ChangeRecord => {
  const rec: ChangeRecord = { op: entry.op, id }
  if (entry.type !== undefined) {
    rec.type = entry.type
  }
  if (entry.name !== undefined) {
    rec.name = entry.name
  }
  if (entry.props !== undefined) {
    rec.props = [...entry.props].sort()
  }
  return rec
}
