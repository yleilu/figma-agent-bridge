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
// Every one of these is TUNING, not contract; the three retention bounds are
// sized against measurements in docs/reference/change-feed-poc-results.md.
//
// Retention is keyed on the COMMAND, not on the clock: `documentchange`
// delivery is batched and unbounded, so membership that expires on a timer
// fails OPEN — the agent's own write comes back as the user's. Neither bound
// below is sized toward over-reporting: a leak here would be systematic
// (every command reporting itself back) and a count that is never zero
// carries no signal at all.

/**
 * Sealed generations retained. THE memory bound: at most this many
 * generations are live at once. Also what covers a deferred event — it
 * advances only when commands are DISPATCHED, so an event that lands long
 * after its own command still finds it, as long as the agent has not
 * dispatched past it. Reads open no generation and do not spend it.
 *
 * Sized above the largest burst observed with an earlier event still
 * undelivered: the POC sweep's 20-write battery produced NO frame while it
 * ran, then one frame of 19 records — eight of them from a PREVIOUS run of
 * the same script, i.e. >= 28 dispatches were outstanding at once
 * (docs/reference/change-feed-poc-results.md, "The idle-delivery leak").
 * 64 is ~2.3x that. Counts DISPATCHES, not work: 50 single-node updates
 * spend 50, one batch of 50 ops spends 1.
 */
export const RETAINED_COMMANDS = 64

/**
 * Idle time since the last dispatch after which EVERY sealed generation is
 * evicted at once. NOT a generation's own age — while the agent keeps
 * working nothing is released and RETAINED_COMMANDS alone decides. Age-keying
 * would expire generations mid-task (an agent round-trips through a model
 * between calls) and collapse the design back into a wall-clock window with a
 * bigger constant.
 *
 * Exists for HAND-OVER: without it an agent that builds a screen and stops
 * goes on claiming nodes it touched twenty commands ago while the user
 * refines them. Sized in minutes: above the longest deferral ever observed
 * (49.2 s, POC Probe 1) with margin, and above any pause an agent takes
 * between commands, so ordinary thinking time never releases retention
 * mid-task. It cannot simply be raised — the same number sets how long a
 * user's post-hand-over edits stay invisible.
 */
export const RETENTION_CEILING_MS = 5 * 60_000

/**
 * Ceiling on how long one dispatch may hold a generation open / count as in
 * flight. A dispatch that never settles (a promise waiting on a font, an
 * image, or an API that never resolves) would otherwise leave a generation
 * that is neither counted out nor released, growing without bound as every
 * later command merged into it, with inFlight() true for the rest of the
 * session — suppressing every page and selection record.
 *
 * 2x the server's own 30 s dispatch timeout (figma-client.ts): a command the
 * server has already abandoned and that is still open here is a wedge, not a
 * slow font load. Batch delivery does not widen behind a font load or a
 * network fetch — POC Measurement A.
 */
export const MAX_DISPATCH_MS = 60_000

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
