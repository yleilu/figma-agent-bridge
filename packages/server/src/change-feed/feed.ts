// The per-fileKey server buffer (change-feed.md, Server buffer model). The
// buffer belongs to the CONSUMER: the relay broadcasts one push to every
// channel member and each session's server buffers and drains independently,
// so one session's drain never empties another's view.
import {
  BUFFER_CAP,
  collapse,
  toEntry,
  toRecord,
  type BaselineState,
  type BufferEntry,
  type ChangeRecord,
  type DocumentChangedParams,
} from '@figma-agent-bridge/shared/change-feed'

export type FileBuffer = {
  fileKey: string
  state: BaselineState
  /** The connection this buffer's history belongs to. */
  epoch: string | null
  lastSeq: number | null
  nodes: Map<string, BufferEntry>
  styles: Map<string, BufferEntry>
  page: ChangeRecord | null
  select: ChangeRecord | null
}

export type DrainResult = {
  changes: ChangeRecord[]
  truncated: boolean
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

export class ChangeFeed {
  private readonly buffers = new Map<string, FileBuffer>()

  constructor(
    /** Fired whenever a buffer's count or state may have changed — the count
     *  mirror's write trigger. */
    private readonly onChange: (
      buffer: FileBuffer,
      reason: ChangeReason,
    ) => void = () => undefined,
    private readonly cap: number = BUFFER_CAP,
  ) {}

  has(fileKey: string): boolean {
    return this.buffers.has(fileKey)
  }

  pendingCount(fileKey: string): number {
    const b = this.buffers.get(fileKey)
    return b === undefined
      ? 0
      : b.nodes.size + b.styles.size
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
        this.fold(b, item as ChangeRecord)
      }
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
   * Drain-on-read: returns buffered records AND removes exactly the records it
   * returned, so there is no cursor — the buffer IS the position. Returns null
   * when no buffer exists (the caller answers `no_baseline` WITHOUT creating
   * one: a read must not smuggle in a join).
   */
  drain(
    fileKey: string,
    limit: number,
  ): DrainResult | null {
    const b = this.buffers.get(fileKey)
    if (b === undefined) {
      return null
    }

    const { state } = b
    const changes: ChangeRecord[] = []
    let truncated = false

    const takeMap = (
      map: Map<string, BufferEntry>,
    ): void => {
      for (const [id, entry] of [...map]) {
        if (changes.length >= limit) {
          truncated = true
          return
        }
        changes.push(toRecord(id, entry))
        map.delete(id)
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

    const empty =
      b.nodes.size === 0 &&
      b.styles.size === 0 &&
      b.page === null &&
      b.select === null
    // Clears to ok ONLY on a drain that (a) empties the buffer and (b) has an
    // established epoch. A buffer never anchored to a connection can never
    // claim a continuous history, however many times it is drained.
    // ESTABLISHED = seeded from the registry at open OR observed on a frame.
    // The join is the moment a continuous history can start, so the seeded
    // value counts; a registry epoch that has since gone stale self-corrects
    // to `gap` — in-band on the next push, and at the next re-join via
    // openBaseline's comparison.
    if (empty && b.epoch !== null) {
      b.state = 'ok'
    }
    this.onChange(b, 'drain')

    return { changes, truncated, state }
  }

  private fold(b: FileBuffer, rec: ChangeRecord): void {
    if (rec.op === 'page') {
      b.page = rec
      return
    }
    if (rec.op === 'select') {
      b.select = rec
      return
    }
    const { id } = rec
    if (id === undefined) {
      return
    }
    // Node and style ids live in SEPARATE maps — the id spaces are distinct
    // and a collision between them would be a silent corruption.
    const map = rec.op.startsWith('style_')
      ? b.styles
      : b.nodes
    const next = collapse(map.get(id), toEntry(rec))
    if (next === null) {
      map.delete(id)
      return
    }
    if (!map.has(id) && map.size >= this.cap) {
      map.delete(map.keys().next().value as string)
      // Memory bound, NOT the drain limit: it DESTROYS records rather than
      // paging them, so it can never be the continuation mechanism — the
      // baseline is broken and the agent must re-read.
      b.state = 'gap'
    }
    map.set(id, next)
  }
}
