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

/** The shape on the wire — ONE RUN of one id. */
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
  /** update / style_update ONLY: the FINAL value of each changed property
   *  small enough to carry. Always a SUBSET of props, never a different key
   *  set — a property in `props` and absent here is the honest "this changed
   *  and you must re-read it". ABSENT on create and delete: a create's final
   *  value is an entire node spec, and a delete has none. */
  set?: Record<string, unknown>
  /** best-effort locator: the page the changed node is on. */
  pg?: string
  /** best-effort locator: the ancestor that is a direct child of a page — the
   *  node's own id when it IS one. ABSENT on delete and when the walk cannot
   *  be performed. */
  fr?: string
  /** select ONLY: the current selection, capped at SELECT_IDS_CAP. */
  ids?: string[]
  /** select ONLY: the TRUE selection size when it exceeds SELECT_IDS_CAP. */
  count?: number
  /** bitmask over the frame's writers[]: sessions that TOUCHED this id. */
  by?: number
  /** bitmask over the frame's writers[]: sessions whose REFLOW closure holds
   *  it. Node-only — no real StyleChangeProperty is a cascade property. */
  rf?: number
  /** this run is two runs the accumulator folded under one of its run bounds:
   *  order lost, no change and no value lost. */
  merged?: true
}

/**
 * Plugin-internal, from the attributor to the flush. Writers are NAMES here:
 * a bit index is meaningful only against a table, and the table is a property
 * of a FRAME — so the accumulator folds names and the flush mints the masks
 * (change-feed.md, "The attributor stamps names").
 */
export type AttributedRecord = Omit<
  ChangeRecord,
  'by' | 'rf'
> & {
  by?: ReadonlySet<string>
  rf?: ReadonlySet<string>
}

export type BaselineState = 'ok' | 'no_baseline' | 'gap'

/** The body of a `document_changed` push. Identity rides in `meta`. */
export type DocumentChangedParams = {
  /** ORDERED runs; may be EMPTY (the opening flush). Where a flush window
   *  contains a writer change on one node it carries two records for that id,
   *  in run order — a consumer that reorders them corrupts the history it is
   *  reconstructing. */
  changes: ChangeRecord[]
  /** the sessions this frame's records are attributed to; the table `by`/`rf`
   *  index into. Minted per frame, capped at WRITERS_CAP, ABSENT when no
   *  record in the flush is attributed. */
  writers?: string[]
  indexStale: boolean
  overflow?: true
  at: number
}

// ── The run model ───────────────────────────────────────────────────────────

/**
 * A run's foreign writers, canonically ordered and joined. EMPTY for the user
 * or an unresolvable cause, and the reserved SELF key for this session's own.
 * Buffer-local, derived from the surviving `by`, never emitted.
 */
export type WriterKey = string

/** The reserved self key: not a session id, not the empty key, so it matches
 *  nothing the attributor can produce. */
export const SELF = '\0self'

/**
 * The one degrade, named once. It is a WRITER like any other — the name a
 * command carries when no session id could be resolved, the stem the count
 * mirror files that server's counts under, and a fixed point of `sanitizeKey`
 * that no UUID session id can collide with.
 *
 * DEFINED here because the plugin stamps it at source and the server subtracts
 * it at ingest: the same reasoning that put CASCADE_PROPS here. Were the two
 * copies ever to diverge, an unattributed session would stop subtracting its
 * own writes and its `pending_edits` would never return to zero.
 */
export const UNATTRIBUTED = '_unattributed'

const WRITER_SEP = '\0'

/**
 * The buffer-local key two runs must share to merge. Two runs merge only if
 * their keys are EQUAL AS SETS: {A} and {A,B} are different writers of the
 * same node, and the empty key — the user, or a cause the attributor could not
 * resolve — is different from both.
 *
 * Deterministic by construction (canonical order, one separator), which is
 * what makes run-merge equality testable.
 *
 * An empty name is not a writer and is dropped; so is one carrying the
 * separator itself, which no platform session id can. That is what makes
 * "SELF matches nothing the attributor can produce" structural rather than a
 * convention — and it makes `{'A\0B'}` unable to masquerade as `{'A','B'}`.
 * Dropping a name costs its writer its bit, so its own record comes back to it
 * as foreign: a false nudge, never silence, the accepted direction.
 */
export const writerKeyOf = (
  by: ReadonlySet<string> | undefined,
): WriterKey => {
  if (by === undefined || by.size === 0) {
    return ''
  }
  const names = [...by]
    .filter(n => n.length > 0 && !n.includes(WRITER_SEP))
    .sort()
  return names.join(WRITER_SEP)
}

/** A FOREIGN run in the server buffer — somebody else's unbroken stretch. */
export type ForeignRun = {
  /** never SELF */
  w: WriterKey
  op: MutationOp
  /** update / style_update only */
  props?: Set<string>
  /** update / style_update only; a subset of props */
  set?: Map<string, unknown>
  /** two runs were folded under a run cap: order lost */
  merged?: true
}

/**
 * A SELF run — this session's own, kept for its POSITION. Nothing ever folds
 * into it and nothing folds across it: a set has no order, and the question
 * `mine` answers (superseded, or never landed?) is entirely about order.
 *
 * That rule is about the FOREIGN COLLAPSE ALGEBRA, whose operands are foreign
 * runs — a self run never enters `collapseWithin` or `collapseAcross`, and no
 * foreign run ever fuses over one. It does NOT make two ADJACENT self runs two
 * runs: a run is one writer's UNBROKEN stretch, and two self positions with
 * nothing between them are by that definition one. They are unioned, which is
 * output-identical (per-property last-writer and existence both resolve the
 * same walking backwards) and is what keeps a solo session's own build costing
 * a set of short strings per node instead of a history of it.
 */
export type SelfRun = {
  w: typeof SELF
  /** ops and property names this session caused at this point */
  mine: Set<string>
}

export type BufferRun = ForeignRun | SelfRun

/** The server buffer's per-id entry. */
export type BufferEntry = {
  type?: string
  name?: string
  pg?: string
  fr?: string
  /** oldest first; NO FOREIGN RUN makes this a shadow entry */
  runs: BufferRun[]
  /** the union of its self runs' names — the shadow */
  mine?: Set<string>
}

/** What `pull_changes` renders for ONE run in `detail: 'runs'`. */
export type DrainedRun =
  | (Omit<
      ChangeRecord,
      | 'by'
      | 'rf'
      | 'id'
      | 'type'
      | 'name'
      | 'pg'
      | 'fr'
      | 'ids'
      | 'count'
    > & { src?: 'agent' })
  /** a POSITION-ONLY run: this session's own work, held to keep the boundary
   *  it sits on. No op, no props, no values. */
  | { src: 'self'; mine: string[] }

/** What `pull_changes` returns: ONE ENTRY PER ID, whichever detail was asked
 *  for. The masks are spent at ingest and never reach the agent. */
export type DrainedRecord = {
  id?: string
  type?: string
  name?: string
  pg?: string
  fr?: string
  /** ops and property NAMES this session is known to have caused on this id,
   *  union over its self runs — the evidence that its own write LANDED. On
   *  the folded view, narrowed to what this record reports on. */
  mine?: string[]
  // detail:'folded' (the default) — the runs projected down to one net effect.
  op?: ChangeOp
  props?: string[]
  set?: Record<string, unknown>
  src?: 'agent'
  /** detail:'runs' — node and style entries carry the runs themselves, oldest
   *  first, and NONE of the four fields above. The context slots are
   *  unaffected by `detail`. */
  runs?: DrainedRun[]
  // context slots only.
  ids?: string[]
  count?: number
}

/**
 * Geometry a re-flow moves on a node the agent did not name. All are real
 * NodeChangeProperty values. `name`/`parent`/`fills`/`characters` are NOT here
 * — a user renaming a node the agent re-flowed must survive.
 *
 * DEFINED here because the reflow closure is computed in the plugin and this
 * set is APPLIED at ingest in the server: one definition, two layers, so a
 * second copy cannot drift.
 */
export const CASCADE_PROPS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'rotation',
  'relativeTransform',
])

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

/**
 * The number of writers one FRAME may name in `params.writers[]`. It bounds
 * the distinct writers in ONE FLUSH WINDOW — a few hundred milliseconds of
 * document activity — not the sessions a plugin has ever seen, so reaching it
 * takes that many sessions writing CONCURRENTLY.
 *
 * `by` / `rf` are integer masks over that table, so the cap sits below the
 * platform's safe bitwise width (JS bitwise operands are 32-bit SIGNED: bit 31
 * is the sign bit, so 31 usable bits), and an order above the number of agent
 * sessions a single file plausibly carries. A writer beyond the cap wins no
 * bit: its records go out unattributed and are kept by everyone including
 * itself — over-reporting, never a wrong drop.
 */
export const WRITERS_CAP = 16

/**
 * Writers that may hold a retained set of generations at once. A writer beyond
 * it evicts the WHOLE set of the writer that has been idle longest, never part
 * of one — half-evicting a writer's ring would silently shorten its reach on
 * somebody else's activity.
 *
 * A backstop, not a working bound: RETENTION_CEILING_MS releases an idle
 * session's set long before a file plausibly carries this many concurrently
 * active ones. Sized in single digits. The scope's memory bound is the product
 * RETAINED_COMMANDS x RETAINED_WRITERS, which is what makes per-writer scoping
 * affordable.
 */
export const RETAINED_WRITERS = 8

/**
 * Runs one id may hold, in BOTH the plugin accumulator and the server buffer —
 * the same pathological alternation (a user dragging a node an agent keeps
 * restyling) reaches both. Beyond it the two oldest IMMEDIATELY ADJACENT
 * foreign runs merge and the survivor is flagged `merged`.
 *
 * Small on purpose: the merge loses ORDER between two foreign runs and nothing
 * else — no change, no property, no value — so it never arms `gap`, and it
 * degrades an id smoothly back toward the pure-collapse answer, oldest history
 * first, which is the part a reader is least likely to be asking about. Large
 * enough that an ordinary alternation stays legible in the runs view.
 */
export const RUNS_PER_ID_CAP = 8

/**
 * The per-property value cap, measured on the value's JSON serialization in
 * BYTES. Sized in the low hundreds: it admits a number, a boolean, a short
 * string, a single paint, one effect, a constraints object or a layout mode,
 * and refuses a vector path, an image fill, a long text-run array and a
 * variable-mode map.
 *
 * It is the SIZE, never the property name, that decides: a table of expensive
 * property names would drift against the runtime, a byte count cannot.
 */
export const VALUE_MAX_BYTES = 256

/**
 * The array-length half of the O(1) pre-check. Learning that a sixty-paint
 * array is over the cap must not cost a full serialization inside the
 * synchronous documentchange handler, per property, per event, on records
 * every consumer may drop — so an array longer than this is refused before
 * anything is serialized.
 *
 * Deliberately conservative: an array this long is over VALUE_MAX_BYTES for
 * any realistic element, and the rare short-element array it refuses falls
 * back to the names-only record, which is the direction the whole values
 * design fails in.
 */
export const VALUE_MAX_ITEMS = 32

/**
 * The per-RECORD value budget, in bytes. Properties are considered in
 * ascending serialized size, ties broken by name, and each is carried while it
 * fits both VALUE_MAX_BYTES and the record's remaining budget.
 *
 * A small multiple of the per-property cap: a record's values therefore cost
 * at most VALUE_MAX_BYTES x 4, which is what bounds the frame's per-record
 * growth. Ascending order maximises how many properties one budget answers;
 * the tie-break makes the outcome deterministic, and therefore testable.
 */
export const RECORD_VALUE_BUDGET = 4 * VALUE_MAX_BYTES

/**
 * The per-RESPONSE value budget, in bytes: what ONE drain may spend on values
 * across all its entries, past which entries render names-only. Spent the way
 * RECORD_VALUE_BUDGET is, one layer up — entries in ascending serialized size
 * of their values, ties broken by their position in `changes`.
 *
 * NO ENTRY IS EVER DROPPED FOR IT: the response degrades to names-only, and
 * the reader re-reads. Sized against DRAIN_LIMIT (a ~160-byte average across a
 * full 100-entry drain) so a values-carrying drain stays a bounded context
 * cost under T4.
 */
export const DRAIN_VALUE_BUDGET = 16 * 1024

/**
 * Frame buckets a truncated drain's `remaining` map may carry. Everything past
 * it folds into `other`, which also absorbs the unlocatable, so the counts
 * always close: total = sum(frames[].n) + other. A map of WHERE TO LOOK needs
 * a handful of buckets, not a histogram (T4).
 */
export const HOTSPOT_CAP = 8

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

// ── The collapse algebra, run-aware ─────────────────────────────────────────
// Applied per id, in BOTH the plugin accumulator and the server buffer, so the
// two can never disagree. The arriving record's writer decides WHICH table
// applies: matching the last run's writer folds under `collapseWithin`,
// differing from it opens a new run, and `collapseAcross` says what a fold
// across those runs then produces when the drain projects them down.
//
// Both tables are over FOREIGN runs. A self run is not an operand — it takes
// its place in the order and then decides, per property and once for
// existence, which foreign runs still reach the reader.

/**
 * The operand of both tables: the structural payload of one run,
 * representation-neutral so the plugin (records carrying their own name/type/
 * locator) and the server (runs under an entry that carries them) share one
 * algebra rather than two copies of it.
 */
export type CollapseRun = {
  op: MutationOp
  type?: string
  name?: string
  props?: Set<string>
  set?: Map<string, unknown>
  pg?: string
  fr?: string
  merged?: true
}

/** `set` is ALWAYS a subset of `props`. Enforced at the one place two key sets
 *  meet, so the invariant holds by construction at every merge; an empty `set`
 *  is dropped rather than carried. */
const withValues = (
  base: CollapseRun,
  props: Set<string>,
  set: Map<string, unknown> | undefined,
): CollapseRun => {
  const kept = new Map<string, unknown>()
  for (const [k, v] of set ?? []) {
    if (props.has(k)) {
      kept.set(k, v)
    }
  }
  return kept.size > 0
    ? { ...base, props, set: kept }
    : { ...base, props }
}

/**
 * The shared table. `create → delete` yields `delete` here — the ACROSS
 * answer. The cancel is the one cell that differs and it lives, visibly, in
 * `collapseWithin`.
 */
const fold = (
  earlier: CollapseRun,
  later: CollapseRun,
): CollapseRun => {
  const e = kindOf(earlier.op)
  const l = kindOf(later.op)
  const type = later.type ?? earlier.type
  const name = later.name ?? earlier.name
  const pg = later.pg ?? earlier.pg
  const fr = later.fr ?? earlier.fr
  // Order was already lost; folding does not recover it.
  const merged =
    earlier.merged === true || later.merged === true
      ? (true as const)
      : undefined

  if (l === 'delete') {
    // A RemovedNode has no name and a deleted node has no properties left to
    // report. pg/fr survive from an earlier run: a delete can never locate
    // itself.
    return {
      op: later.op,
      type,
      name: undefined,
      pg,
      fr,
      merged,
    }
  }
  if (l === 'create' || e === 'create') {
    // create → update keeps the create (the reader never saw the node and
    // re-reads it whole, so a changed-property list on one is meaningless and
    // a value list on one is meaningless AND expensive); update/delete →
    // create becomes the create.
    return {
      op: l === 'create' ? later.op : earlier.op,
      type,
      name,
      pg,
      fr,
      merged,
    }
  }
  if (e === 'update' && l === 'update') {
    // props by UNION — the only merge that cannot lose a changed-property
    // name; `set` LATEST-WINS per property — a property has one final value,
    // and a union of values is not a value.
    return withValues(
      { op: later.op, type, name, pg, fr, merged },
      new Set([
        ...(earlier.props ?? []),
        ...(later.props ?? []),
      ]),
      new Map([
        ...(earlier.set ?? []),
        ...(later.set ?? []),
      ]),
    )
  }
  // earlier delete → later update (cannot happen, still specified): props and
  // set are the later run's only.
  return withValues(
    { op: later.op, type, name, pg, fr, merged },
    new Set(later.props ?? []),
    later.set,
  )
}

/**
 * WITHIN a run — one writer's unbroken stretch. `held` is the run already
 * open, `arriving` the new record. Returns the run to store, or `null` to
 * REMOVE it (the create→delete cancel).
 *
 * TOTAL: cells that "cannot happen" (update→create, delete→update) are
 * specified, because event reordering is possible and a table with holes says
 * nothing at the moment it matters.
 */
export const collapseWithin = (
  held: CollapseRun | undefined,
  arriving: CollapseRun,
): CollapseRun | null => {
  if (held === undefined) {
    // The invariant holds at the ENTRY to the algebra too, not only at a
    // merge: a first record whose `set` names something its `props` does not
    // would seed a run the tables can never repair.
    return arriving.props === undefined
      ? { ...arriving, set: undefined }
      : withValues(arriving, arriving.props, arriving.set)
  }
  if (
    kindOf(held.op) === 'create' &&
    kindOf(arriving.op) === 'delete'
  ) {
    // THE DIVERGENT CELL. Under one writer inside one unbroken stretch, a node
    // that appeared and vanished is a node no reader can have seen, and the
    // cancel keeps a transient scaffold out of everyone's buffer.
    return null
  }
  return fold(held, arriving)
}

/**
 * ACROSS a run boundary — the folded projection, applied left to right over an
 * id's runs, and the merge two runs take under a run cap. NEVER cancels:
 * `create → delete` yields `delete`, because one party created the node and
 * another destroyed it, and the party whose work was undone must learn it.
 */
export const collapseAcross = (
  earlier: CollapseRun,
  later: CollapseRun,
): CollapseRun => fold(earlier, later)
