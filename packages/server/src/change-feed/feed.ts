// The per-fileKey server buffer (change-feed.md, Server buffer model). The
// buffer belongs to the CONSUMER: the relay broadcasts one push to every
// channel member and each session's server buffers and drains independently,
// so one session's drain never empties another's view. Attribution makes that
// split load-bearing rather than merely convenient — the buffer is where a
// record stops being A CHANGE and becomes A CHANGE RELATIVE TO A READER.
import {
  BUFFER_CAP,
  DRAIN_VALUE_BUDGET,
  HOTSPOT_CAP,
  RUNS_PER_ID_CAP,
  SELF,
  VALUE_MAX_BYTES,
  collapseAcross,
  collapseWithin,
  identityOf,
  measureValue,
  type BaselineState,
  type BufferRun,
  type ChangeRecord,
  type CollapseRun,
  type DocumentChangedParams,
  type DrainedRecord,
  type ForeignRun,
  type MutationOp,
  type BufferEntry,
  type WriterKey,
} from '@figma-agent-bridge/shared'
import {
  foldEntry,
  hotspots,
  renderRuns,
  type Hotspots,
} from './fold'
import { bitFor, resolveIngest } from './subtract'
import { selfWriter } from './session-identity'

/** The stored entry: the spec's `BufferEntry` plus the two clocks BUFFER_CAP's
 *  stages need — `seq` for "the oldest distinct id", `at` for "longest
 *  untouched". Neither is ever emitted. */
type Entry = BufferEntry & { seq: number; at: number }

export type FileBuffer = {
  fileKey: string
  state: BaselineState
  /** The connection this buffer's history belongs to. */
  epoch: string | null
  lastSeq: number | null
  nodes: Map<string, Entry>
  styles: Map<string, Entry>
  /** Latest-wins slots; masks stripped AS THEY ARE STORED, which is what makes
   *  the drain's records mask-free by construction rather than by a filter. */
  page: DrainedRecord | null
  select: DrainedRecord | null
}

export type DrainDetail = 'folded' | 'runs'

export type DrainResult = {
  changes: DrainedRecord[]
  truncated: boolean
  /** ONLY when truncated: what is left of an event backlog has a shape worth
   *  reporting where what is left of a query result does not. */
  remaining?: Hotspots
  state: BaselineState
}

/** Why onChange fired. The count mirror needs this because change-feed.md's
 *  write-trigger table makes `drain` IMMEDIATE unconditionally, and a truncated
 *  drain (positive → positive, state unchanged) is otherwise indistinguishable
 *  from an ordinary ingest. */
export type ChangeReason =
  | 'open'
  | 'ingest'
  | 'arm'
  | 'drain'

/**
 * change-feed.md's write-trigger table has four IMMEDIATE rows the mirror
 * cannot infer from count and state alone — `baseline open`, `state changes`,
 * `server-side disconnect arm (for every affected file)` and `drain`. Only the
 * CALLER knows the reason, so the four are named here rather than rediscovered
 * from the record: an `arm` on a buffer already `gap` with a positive count
 * matches none of the mirror's conditions and would be trailing-debounced,
 * and a truncated `drain` is indistinguishable from an ordinary ingest.
 * `ingest` is the one row the mirror's own condition list decides.
 */
export const isImmediateWrite = (
  reason: ChangeReason,
): boolean =>
  reason === 'open' ||
  reason === 'arm' ||
  reason === 'drain'

const isSelfRun = (
  run: BufferRun,
): run is Extract<BufferRun, { mine: Set<string> }> =>
  run.w === SELF

const hasForeign = (entry: BufferEntry): boolean =>
  entry.runs.some(r => !isSelfRun(r))

/** The collapse algebra's operand for a stored run: the run's own payload plus
 *  the entry-level identity and locator the tables carry through. */
const operandOf = (
  entry: Entry,
  run: ForeignRun,
): CollapseRun => ({
  op: run.op,
  ...(entry.type !== undefined ? { type: entry.type } : {}),
  ...(entry.name !== undefined ? { name: entry.name } : {}),
  ...(run.props !== undefined ? { props: run.props } : {}),
  ...(run.set !== undefined ? { set: run.set } : {}),
  ...(entry.pg !== undefined ? { pg: entry.pg } : {}),
  ...(entry.fr !== undefined ? { fr: entry.fr } : {}),
  ...(run.merged === true ? { merged: true as const } : {}),
})

const operandOfRecord = (
  rec: ChangeRecord,
): CollapseRun => {
  const out: CollapseRun = { op: rec.op as MutationOp }
  if (rec.type !== undefined) {
    out.type = rec.type
  }
  if (rec.name !== undefined) {
    out.name = rec.name
  }
  if (rec.props !== undefined) {
    out.props = new Set(rec.props)
  }
  if (rec.set !== undefined) {
    out.set = new Map(Object.entries(rec.set))
  }
  if (rec.pg !== undefined) {
    out.pg = rec.pg
  }
  if (rec.fr !== undefined) {
    out.fr = rec.fr
  }
  if (rec.merged === true) {
    out.merged = true
  }
  return out
}

/** Split a collapse result back into the run's payload and the entry's shared
 *  identity + locator. */
const writeBack = (
  entry: Entry,
  run: ForeignRun,
  next: CollapseRun,
): void => {
  run.op = next.op
  if (next.props === undefined) {
    delete run.props
  } else {
    run.props = next.props
  }
  if (next.set === undefined) {
    delete run.set
  } else {
    run.set = next.set
  }
  if (next.merged === true) {
    run.merged = true
  } else {
    delete run.merged
  }
  entry.type = next.type
  entry.name = next.name
  entry.pg = next.pg
  entry.fr = next.fr
}

/**
 * The entry-level identity + locator a NEW run establishes. Opening a run is
 * still a MERGE onto what the entry already holds, so the rule has to be the
 * table's: latest DEFINED wins, and a delete clears `name` but inherits `pg` /
 * `fr` — a delete can never locate itself, so an earlier run is the only way a
 * deleted node is ever locatable at all, and the truncation receipt buckets it
 * instead of dropping it into `other`.
 *
 * Routed through `collapseAcross` rather than restated, so the rule has ONE
 * home: the shell carries the arriving op and no payload, which makes every
 * arm of the table reduce to exactly the latest-defined merge of the four
 * identity fields.
 */
const seedIdentity = (
  entry: Entry,
  seeded: CollapseRun,
): void => {
  const shell: CollapseRun = { op: seeded.op }
  if (entry.type !== undefined) {
    shell.type = entry.type
  }
  if (entry.name !== undefined) {
    shell.name = entry.name
  }
  if (entry.pg !== undefined) {
    shell.pg = entry.pg
  }
  if (entry.fr !== undefined) {
    shell.fr = entry.fr
  }
  const next = collapseAcross(shell, seeded)
  entry.type = next.type
  entry.name = next.name
  entry.pg = next.pg
  entry.fr = next.fr
}

/** Masks are transport between the plugin and the buffer, spent at ingest:
 *  putting session ids in the agent's context would cost tokens for an
 *  identifier it has nothing to do with (T4). */
const toSlot = (rec: ChangeRecord): DrainedRecord => {
  const out: DrainedRecord = { op: rec.op }
  if (rec.id !== undefined) {
    out.id = rec.id
  }
  if (rec.name !== undefined) {
    out.name = rec.name
  }
  if (rec.ids !== undefined) {
    out.ids = rec.ids
  }
  if (rec.count !== undefined) {
    out.count = rec.count
  }
  return out
}

/** The serialized value cost of one rendered entry, in bytes — what
 *  DRAIN_VALUE_BUDGET is spent against. A value the plugin's own caps admitted
 *  is measured again here by the SAME function, so the two cannot disagree; one
 *  that somehow did not is charged the per-property cap rather than skipped. */
const valueBytes = (rec: DrainedRecord): number => {
  let n = 0
  const add = (set: Record<string, unknown>): void => {
    for (const v of Object.values(set)) {
      n += measureValue(v) ?? VALUE_MAX_BYTES
    }
  }
  if (rec.set !== undefined) {
    add(rec.set)
  }
  for (const run of rec.runs ?? []) {
    if ('set' in run && run.set !== undefined) {
      add(run.set)
    }
  }
  return n
}

const stripValues = (rec: DrainedRecord): void => {
  delete rec.set
  for (const run of rec.runs ?? []) {
    if ('set' in run) {
      delete run.set
    }
  }
}

const KEY_SEP = '\0'

/** Two run keys unioned, canonically — the same construction `writerKeyOf`
 *  makes, over keys that are already canonical. */
const mergeKeys = (
  a: WriterKey,
  b: WriterKey,
): WriterKey => {
  const names = new Set<string>()
  for (const part of [
    ...a.split(KEY_SEP),
    ...b.split(KEY_SEP),
  ]) {
    if (part.length > 0) {
      names.add(part)
    }
  }
  return [...names].sort().join(KEY_SEP)
}

export class ChangeFeed {
  private readonly buffers = new Map<string, FileBuffer>()

  /** Monotonic across the whole feed: the two maps are separate, so "the oldest
   *  distinct id" and "the longest-untouched shadow" are only answerable
   *  against a shared clock. */
  private clock = 0

  constructor(
    /** Fired whenever a buffer's count or state may have changed — the count
     *  mirror's write trigger. */
    private readonly onChange: (
      buffer: FileBuffer,
      reason: ChangeReason,
    ) => void = () => undefined,
    private readonly cap: number = BUFFER_CAP,
    /** `writer` is the ONE seam: production leaves it at `selfWriter`, so the
     *  identity the buffer subtracts and the one the count mirror files under
     *  are a single lookup. A test supplies it to stand up TWO consumers of the
     *  same broadcast frame in one process — which is the whole property this
     *  design turns on and the one a singleton makes unobservable. */
    opts: {
      runsPerId?: number
      writer?: () => string
    } = {},
  ) {
    this.runsPerId = opts.runsPerId ?? RUNS_PER_ID_CAP
    this.writer = opts.writer ?? selfWriter
  }

  private readonly runsPerId: number

  private readonly writer: () => string

  has(fileKey: string): boolean {
    return this.buffers.has(fileKey)
  }

  /**
   * Entries holding AT LEAST ONE FOREIGN RUN, across both maps — distinct
   * changed things, not actions and not runs. Shadow entries never count: they
   * record what this session itself did, and a count that rose on the agent's
   * own writing would be the exact signal the subtraction at ingest avoids.
   * Context slots never count either.
   */
  pendingCount(fileKey: string): number {
    const b = this.buffers.get(fileKey)
    if (b === undefined) {
      return 0
    }
    let n = 0
    for (const map of [b.nodes, b.styles]) {
      for (const entry of map.values()) {
        if (hasForeign(entry)) {
          n += 1
        }
      }
    }
    return n
  }

  /**
   * A baseline opens when the server successfully JOINS that file's channel —
   * the only event that makes it a recipient of the file's broadcasts.
   * Re-joining after a close does NOT open a clean baseline: an existing
   * buffer and its state are preserved (every server-side disconnect has
   * already marked it broken).
   *
   * The registry `epoch` is compared on that re-join, which is the LATE-JOINER
   * half of the reconnect arm: the in-band half (a push whose `meta.epoch`
   * differs) cannot fire for a server that was not in the channel to receive
   * the new connection's opening flush, and if the user then stops editing no
   * push ever arrives at all. Without the comparison the buffer would keep a
   * drained-clean `ok` over edits the server provably never saw.
   */
  openBaseline(
    fileKey: string,
    epoch: string | null,
  ): void {
    const existing = this.buffers.get(fileKey)
    if (existing !== undefined) {
      if (epoch === null || existing.epoch === epoch) {
        return // the genuine re-join: same connection, nothing lost
      }
      if (existing.epoch === null) {
        // Nothing to lose — the buffer never claimed a connection, so learning
        // one is the anchor it was missing, not a hole. No arm.
        existing.epoch = epoch
        return
      }
      existing.state = 'gap'
      existing.epoch = epoch
      // Reset alongside the epoch so the seq arm cannot double-fire on the
      // first frame of the new connection (seq restarts at 0).
      existing.lastSeq = null
      this.onChange(existing, 'arm')
      return
    }
    const buffer: FileBuffer = {
      fileKey,
      state: 'no_baseline',
      // Seeded from the registry entry the file gate already resolved.
      // Without it the first genuine user edit would arrive against a null
      // epoch and read as a reconnect — a full re-read on every file's first
      // real change.
      epoch,
      lastSeq: null,
      nodes: new Map(),
      styles: new Map(),
      page: null,
      select: null,
    }
    this.buffers.set(fileKey, buffer)
    this.onChange(buffer, 'open')
  }

  ingest(
    fileKey: string,
    params: DocumentChangedParams,
    meta: { epoch?: string; seq?: number },
  ): void {
    const b = this.buffers.get(fileKey)
    if (b === undefined) {
      return // never watched → nothing to buffer
    }

    const epoch = meta.epoch ?? null
    if (
      epoch !== null &&
      b.epoch !== null &&
      epoch !== b.epoch
    ) {
      // The plugin restarted; pushes may have been missed. `epoch` is compared
      // for EQUALITY only — it is a nonce, not a clock.
      b.state = 'gap'
      b.lastSeq = null
    }
    if (epoch !== null) {
      b.epoch = epoch
    }

    const { seq } = meta
    if (typeof seq === 'number') {
      // Trailing detection: a drop is observable only once a LATER frame
      // arrives on the same epoch (Limitations).
      if (b.lastSeq !== null && seq > b.lastSeq + 1) {
        b.state = 'gap'
      }
      b.lastSeq = seq
    }

    if (params.overflow === true) {
      b.state = 'gap'
    }

    // The frame's writer table. Every arriving record is resolved against THIS
    // server's own writer — the same value the count mirror keys its file on,
    // one lookup so the two cannot drift.
    const rawWriters = (params as { writers?: unknown })
      .writers
    const writers = Array.isArray(rawWriters)
      ? rawWriters.filter(
          (w): w is string => typeof w === 'string',
        )
      : undefined
    const self = this.writer()

    // The relay validates only `meta` and forwards `params` as a FREE record,
    // and the push path is the one path with no version gate (B2 guards the
    // FILE gate, which pushes never traverse) — so a non-conforming or future
    // plugin build reaches this unvalidated. A synchronous throw here is not
    // contained: the socket dispatch evaluates the handler while building the
    // argument to Promise.resolve, so it escapes every .catch and kills the
    // process. Malformed input is treated like `overflow` rather than dropped:
    // a frame the server cannot read is evidence that records were LOST, and
    // over-reporting is this feature's fail direction.
    const raw = params as { changes?: unknown }
    if (!Array.isArray(raw.changes)) {
      b.state = 'gap'
    } else {
      for (const item of raw.changes as unknown[]) {
        if (
          item === null ||
          typeof item !== 'object' ||
          typeof (item as ChangeRecord).op !== 'string'
        ) {
          b.state = 'gap'
          continue
        }
        this.route(b, item as ChangeRecord, writers, self)
      }
      this.enforceCap(b)
    }
    this.onChange(b, 'ingest')
  }

  /** Arm the broken baseline for one file (watchdog death). */
  markGap(fileKey: string): void {
    const b = this.buffers.get(fileKey)
    if (b === undefined) {
      return
    }
    b.state = 'gap'
    this.onChange(b, 'arm')
  }

  /** Arm every open buffer (the server↔relay socket closed). */
  markAllGap(): void {
    for (const b of this.buffers.values()) {
      b.state = 'gap'
      this.onChange(b, 'arm')
    }
  }

  /**
   * Drain-on-read: returns buffered records AND removes exactly the entries it
   * returned, so there is no cursor — the buffer IS the position. An entry is
   * removed WITH ALL ITS RUNS, self runs included (a partial drain of one id's
   * history would leave a fragment whose first run is not the first run) while
   * its `mine` stays behind as a shadow, because a shadow is not a change and
   * the question it answers outlives the answer.
   *
   * Returns null when no buffer exists (the caller answers `no_baseline`
   * WITHOUT creating one: a read must not smuggle in a join).
   */
  drain(
    fileKey: string,
    limit: number,
    detail: DrainDetail = 'folded',
  ): DrainResult | null {
    const b = this.buffers.get(fileKey)
    if (b === undefined) {
      return null
    }

    const { state } = b
    const changes: DrainedRecord[] = []
    let truncated = false
    const render =
      detail === 'runs' ? renderRuns : foldEntry

    const takeMap = (map: Map<string, Entry>): void => {
      for (const [id, entry] of [...map]) {
        // Shadows are invisible to `changes[]` — they exist only to answer a
        // later foreign change on the same id.
        if (!hasForeign(entry)) {
          continue
        }
        if (changes.length >= limit) {
          truncated = true
          return
        }
        const rendered = render(id, entry)
        if (rendered !== null) {
          changes.push(rendered)
        }
        if (
          entry.mine !== undefined &&
          entry.mine.size > 0
        ) {
          entry.runs = []
        } else {
          map.delete(id)
        }
      }
    }
    // Mutations first, context slots last: the slots are latest-wins and lose
    // nothing by waiting.
    takeMap(b.nodes)
    if (!truncated) {
      takeMap(b.styles)
    }
    if (!truncated && b.page !== null) {
      if (changes.length >= limit) {
        truncated = true
      } else {
        changes.push(b.page)
        b.page = null
      }
    }
    if (!truncated && b.select !== null) {
      if (changes.length >= limit) {
        truncated = true
      } else {
        changes.push(b.select)
        b.select = null
      }
    }

    this.spendValueBudget(changes)

    const empty =
      this.pendingCount(fileKey) === 0 &&
      b.page === null &&
      b.select === null
    // Clears to ok ONLY on a drain that (a) empties the buffer and (b) has an
    // established epoch. A buffer never anchored to a connection can never
    // claim a continuous history, however many times it is drained.
    // ESTABLISHED = seeded from the registry at open OR observed on a frame.
    // The join is the moment a continuous history can start, so the seeded
    // value counts; a registry epoch that has since gone stale self-corrects
    // to `gap` — in-band on the next push, and at the next re-join via
    // openBaseline's comparison. EMPTY means no FOREIGN RUN remains: shadow
    // entries survive a drain and never hold the state open.
    if (empty && b.epoch !== null) {
      b.state = 'ok'
    }
    this.onChange(b, 'drain')

    const out: DrainResult = { changes, truncated, state }
    if (truncated) {
      // A thousand-record backlog handed back a hundred at a time is not
      // actionable — ten more calls to learn what one re-read would have told
      // the agent. `remaining` is a MAP OF WHERE TO LOOK.
      const left: { fr?: string; pg?: string }[] = []
      for (const map of [b.nodes, b.styles]) {
        for (const entry of map.values()) {
          if (hasForeign(entry)) {
            left.push({ fr: entry.fr, pg: entry.pg })
          }
        }
      }
      out.remaining = hotspots(
        left,
        fr => b.nodes.get(fr)?.name,
        HOTSPOT_CAP,
      )
    }
    return out
  }

  /**
   * The BYTE bound on a response, spent the way RECORD_VALUE_BUDGET is one
   * layer down: entries in ASCENDING serialized size of their values, ties
   * broken by their position in `changes`, each keeping its `set` while the
   * budget holds. Allocation order is not render order — `changes` keeps its
   * stated order, so `limit` and truncation are unaffected.
   *
   * NO ENTRY IS EVER DROPPED FOR IT: the response degrades to names-only, which
   * is the record the design carries when it can carry nothing better. A budget
   * that dropped entries instead would trade a reported CHANGE for a reported
   * VALUE, which is the wrong way round.
   */
  private spendValueBudget(changes: DrainedRecord[]): void {
    const sized = changes
      .map((rec, i) => ({ i, size: valueBytes(rec) }))
      .filter(e => e.size > 0)
      .sort((a, b) =>
        a.size !== b.size ? a.size - b.size : a.i - b.i,
      )
    let used = 0
    const kept = new Set<number>()
    for (const e of sized) {
      if (used + e.size > DRAIN_VALUE_BUDGET) {
        break // ascending, so nothing after this one fits either
      }
      used += e.size
      kept.add(e.i)
    }
    for (const e of sized) {
      if (!kept.has(e.i)) {
        stripValues(changes[e.i])
      }
    }
  }

  private entryFor(
    b: FileBuffer,
    map: Map<string, Entry>,
    id: string,
  ): Entry {
    const held = map.get(id)
    this.clock += 1
    if (held !== undefined) {
      held.at = this.clock
      return held
    }
    const entry: Entry = {
      seq: this.clock,
      at: this.clock,
      runs: [],
    }
    map.set(id, entry)
    return entry
  }

  private route(
    b: FileBuffer,
    rec: ChangeRecord,
    writers: string[] | undefined,
    self: string,
  ): void {
    if (rec.op === 'page') {
      // The session that navigated discards its own; the others learn that the
      // page changed under them. A dropped page record leaves the slot as it
      // was — it is context, never a mutation.
      const bit = bitFor(writers, self)
      if (bit !== 0 && ((rec.by ?? 0) & bit) !== 0) {
        return
      }
      b.page = toSlot(rec)
      return
    }
    if (rec.op === 'select') {
      // The `select` slot appears in NO row of the ingest table: it carries no
      // id and therefore neither mask, so it is always kept and always replaces
      // the slot.
      b.select = toSlot(rec)
      return
    }
    const { id } = rec
    if (id === undefined) {
      return
    }
    // An update naming NO property is not a change this feed can represent:
    // the fold returns nothing for it and drops the entry, so counting it
    // would put a number in the presence block that the very next drain
    // cannot account for. Refused here rather than at the fold, so the rule
    // holds against ANY producer and not only against this plugin version.
    if (
      (rec.op === 'update' || rec.op === 'style_update') &&
      (rec.props ?? []).length === 0
    ) {
      return
    }
    // Node and style ids live in SEPARATE maps — the id spaces are distinct
    // and a collision between them would be a silent corruption.
    const map = rec.op.startsWith('style_')
      ? b.styles
      : b.nodes
    // A STYLE is keyed by its KEY, normalised to the form a command returns
    // (identityOf). The runtime hands out a different TRAILING segment per
    // event, so keying on the raw string split one style across several
    // entries: an inflated count, a collapse with nothing to fold, and an id
    // that matched neither the other events nor what create_styles returned.
    // Node ids pass through untouched — they are exact.
    const key = identityOf(rec.op, id)
    const res = resolveIngest(rec, writers, self)
    if (res.kind === 'foreign') {
      this.appendForeign(b, map, key, res.key, res.rec)
      return
    }
    if (res.kind === 'split') {
      this.appendForeign(b, map, key, res.key, res.rec)
    }
    this.appendSelf(b, map, key, res.mine)
  }

  private appendForeign(
    b: FileBuffer,
    map: Map<string, Entry>,
    id: string,
    key: WriterKey,
    rec: ChangeRecord,
  ): void {
    const entry = this.entryFor(b, map, id)
    const arriving = operandOfRecord(rec)
    const last = entry.runs[entry.runs.length - 1]

    // A self run's key matches nothing, so a foreign record arriving after one
    // always opens a new run — the boundary is what the fold reads.
    if (
      last !== undefined &&
      !isSelfRun(last) &&
      last.w === key
    ) {
      const next = collapseWithin(
        operandOf(entry, last),
        arriving,
      )
      if (next === null) {
        // create → delete under ONE writer inside one unbroken stretch.
        entry.runs.pop()
        if (
          entry.runs.length === 0 &&
          (entry.mine === undefined ||
            entry.mine.size === 0)
        ) {
          map.delete(id)
        }
        return
      }
      writeBack(entry, last, next)
      return
    }

    const seeded = collapseWithin(
      undefined,
      arriving,
    ) as CollapseRun
    const run: ForeignRun = { w: key, op: seeded.op }
    if (seeded.props !== undefined) {
      run.props = seeded.props
    }
    if (seeded.set !== undefined) {
      run.set = seeded.set
    }
    if (seeded.merged === true) {
      run.merged = true
    }
    seedIdentity(entry, seeded)
    entry.runs.push(run)
    this.capRuns(entry)
  }

  private appendSelf(
    b: FileBuffer,
    map: Map<string, Entry>,
    id: string,
    mine: string[],
  ): void {
    const entry = this.entryFor(b, map, id)
    const last = entry.runs[entry.runs.length - 1]
    if (last !== undefined && isSelfRun(last)) {
      // Two ADJACENT self runs are one unbroken stretch of this session's own
      // work — the definition of a run — and nothing separates them, so they
      // answer every per-property and existence question identically. Merging
      // them is what keeps a solo session's own build costing a set of short
      // strings per node rather than a history of it.
      for (const name of mine) {
        last.mine.add(name)
      }
    } else {
      entry.runs.push({ w: SELF, mine: new Set(mine) })
    }
    entry.mine ??= new Set()
    for (const name of mine) {
      entry.mine.add(name)
    }

    // An entry with nothing left to report becomes a shadow. Appending a self
    // run is the ONLY thing that can suppress, so this is the only place the
    // rule can reach zero — and it must be evaluated here rather than at drain,
    // because `pendingCount` falls with it.
    if (
      hasForeign(entry) &&
      foldEntry(id, entry) === null
    ) {
      entry.runs = []
    }
  }

  /** The two oldest foreign runs that are IMMEDIATELY ADJACENT merge: no self
   *  run between them, because two foreign runs fused over one would put a
   *  property's last writer on the wrong side of this session's own. Returns
   *  false when no such pair exists. */
  private mergeAdjacent(entry: Entry): boolean {
    for (let i = 0; i + 1 < entry.runs.length; i += 1) {
      const a = entry.runs[i]
      const bRun = entry.runs[i + 1]
      if (isSelfRun(a) || isSelfRun(bRun)) {
        continue
      }
      const next = collapseAcross(
        operandOf(entry, a),
        operandOf(entry, bRun),
      )
      const merged: ForeignRun = {
        // Their keys UNION — and a merged run's key is only ever compared for
        // equality, so the canonical join is what matters.
        w: a.w === bRun.w ? a.w : mergeKeys(a.w, bRun.w),
        op: next.op,
        merged: true,
      }
      if (next.props !== undefined) {
        merged.props = next.props
      }
      if (next.set !== undefined) {
        merged.set = next.set
      }
      entry.type = next.type
      entry.name = next.name
      entry.pg = next.pg
      entry.fr = next.fr
      entry.runs.splice(i, 2, merged)
      return true
    }
    return false
  }

  /** RUNS_PER_ID_CAP: a pathological alternation — a user dragging a node an
   *  agent keeps restyling — would grow one id's history without limit. Loses
   *  ORDER between two foreign runs and nothing else, so it never arms `gap`. */
  private capRuns(entry: Entry): void {
    while (entry.runs.length > this.runsPerId) {
      if (!this.mergeAdjacent(entry)) {
        return
      }
    }
  }

  /**
   * BUFFER_CAP — the MEMORY bound. It bounds RUNS plus SHADOW ENTRIES (a run
   * being the unit that costs memory and a shadow the unit that costs it
   * invisibly) and degrades in three stages, SPENDING ORDER BEFORE IT SPENDS
   * CHANGES:
   *
   *   1. shadow entries, longest-untouched first  — arms NOTHING
   *   2. merges of adjacent foreign runs           — arms NOTHING
   *   3. the oldest distinct id                    — arms `gap`
   *
   * Only stage 3 loses a change, and only stage 3 arms the baseline. Reaching
   * stage 1 or 2 is a buffer under pressure telling the reader less about HOW;
   * reaching stage 3 is a buffer that can no longer be trusted about WHAT.
   */
  private enforceCap(b: FileBuffer): void {
    while (this.load(b) > this.cap) {
      if (this.dropShadow(b)) {
        continue
      }
      if (this.mergeBiggest(b)) {
        continue
      }
      if (!this.evictOldest(b)) {
        return
      }
    }
  }

  private load(b: FileBuffer): number {
    let n = 0
    for (const map of [b.nodes, b.styles]) {
      for (const entry of map.values()) {
        n += entry.runs.length
        if (!hasForeign(entry)) {
          n += 1
        } // its `mine`
      }
    }
    return n
  }

  /** Stage 1. A lost shadow costs an EXPLANATION, never a change, so arming
   *  `gap` over one would oblige a full re-read to recover a label. */
  private dropShadow(b: FileBuffer): boolean {
    let victim: {
      map: Map<string, Entry>
      id: string
    } | null = null
    let at = Number.POSITIVE_INFINITY
    for (const map of [b.nodes, b.styles]) {
      for (const [id, entry] of map) {
        if (!hasForeign(entry) && entry.at < at) {
          at = entry.at
          victim = { map, id }
        }
      }
    }
    if (victim === null) {
      return false
    }
    victim.map.delete(victim.id)
    return true
  }

  /**
   * Stage 2. Order is lost, no change is.
   *
   * Candidates are tried in DESCENDING run count (ties by `seq`) until one
   * merges. The busiest entry is not necessarily a mergeable one — self runs
   * between its foreign runs leave it no adjacent pair — and stopping at the
   * first refusal would fall through to stage 3, which spends a change and
   * arms `gap`, while order was still there to spend elsewhere. False means
   * what the spec's ordering requires it to mean: NO entry has an adjacent
   * foreign pair left.
   */
  private mergeBiggest(b: FileBuffer): boolean {
    const candidates: Entry[] = []
    for (const map of [b.nodes, b.styles]) {
      for (const entry of map.values()) {
        if (entry.runs.length >= 2) {
          candidates.push(entry)
        }
      }
    }
    candidates.sort((x, y) =>
      x.runs.length !== y.runs.length
        ? y.runs.length - x.runs.length
        : x.seq - y.seq,
    )
    for (const entry of candidates) {
      if (this.mergeAdjacent(entry)) {
        return true
      }
    }
    return false
  }

  /** Stage 3, and the only one that destroys a CHANGE. It DESTROYS rather than
   *  pages, so it can never be the continuation mechanism — the baseline is
   *  broken and the agent must re-read. */
  private evictOldest(b: FileBuffer): boolean {
    let victim: {
      map: Map<string, Entry>
      id: string
    } | null = null
    let seq = Number.POSITIVE_INFINITY
    for (const map of [b.nodes, b.styles]) {
      for (const [id, entry] of map) {
        if (entry.seq < seq) {
          seq = entry.seq
          victim = { map, id }
        }
      }
    }
    if (victim === null) {
      return false
    }
    victim.map.delete(victim.id)
    b.state = 'gap'
    return true
  }
}
