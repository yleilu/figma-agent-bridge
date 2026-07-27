// scripts/poc-collect.ts — the change-feed POC collector
// (docs/scratch/plans/2026-07-26-change-feed.md, Task 1a). THROWAWAY: deleted
// with the rest of the probe harness in Task 7.
//
// The plugin sandbox's console.log goes to Figma's dev console and cannot be
// harvested headlessly, so the probe ships its rows over the relay as a
// `feed_probe` message. This process joins the POC relay's channels and appends
// every row it sees to docs/scratch/poc/feed-poc.jsonl, ONE JSON OBJECT PER
// LINE — the format Task 1f's `jq -s` queries read.
//
// Two properties matter more than they look:
//
//   1. It NEVER goes silent without saying so. The Task 1 gate's pass criterion
//      is "case 11's kept-row count is exactly 0", so a collector that has
//      quietly stopped collecting produces a FALSE PASS on the one criterion
//      the whole POC exists to evaluate. The plan's inner sweep loop rebuilds
//      and reloads the plugin between runs, which drops the socket and can
//      change the channel — so this collector re-polls /channels, joins new
//      channels as they appear, reconnects on close, and prints a heartbeat
//      carrying its row count and joined channels.
//   2. Appends are SERIALIZED. `onmessage` fires re-entrantly; two overlapping
//      appendFile calls can interleave a partial line, and one corrupt line
//      makes `jq -s` fail over the WHOLE file.
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverChannels,
  toHttpUrl,
} from '@figma-agent-bridge/server/figma-client'
import { POC_RELAY_PORT, resolvePocPort } from './poc-relay'

// `.pathname` on a file: URL is PERCENT-ENCODED, so a repo path containing a
// space resolves to a directory that does not exist — and a collector writing
// into nowhere is exactly the silent false-pass this file exists to prevent.
const REPO_ROOT = fileURLToPath(
  new URL('../', import.meta.url),
)

/** The path Task 1f's jq queries name, resolved off this file so the collector
 *  can be started from any directory. */
export const DEFAULT_OUT = `${REPO_ROOT}docs/scratch/poc/feed-poc.jsonl`

type ProbeFrame = {
  type?: string
  message?: {
    command?: string
    params?: {
      rows?: unknown[]
      flushSeq?: unknown
      rowCount?: unknown
      session?: unknown
      channel?: unknown
    }
  }
}

export type ProbeFrameData = {
  rows: unknown[]
  /** Monotonic per sandbox session. `null` on a frame that carries none. */
  flushSeq: number | null
  rowCount: number | null
  /** The sandbox load that produced the frame. */
  session: string | null
  /** The relay channel the plugin registered on. NOT readable off the relay
   *  frame — `BroadcastMessage` carries no channel (packages/shared/src/
   *  types.ts) — so the plugin stamps it into the probe payload itself. */
  channel: string | null
}

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null

const EMPTY_FRAME: ProbeFrameData = {
  rows: [],
  flushSeq: null,
  rowCount: null,
  session: null,
  channel: null,
}

/** The probe payload carried by a relay frame; empty for anything else. Total
 *  over junk — the collector must never die mid-battery on an unexpected
 *  frame. */
export const extractProbeFrame = (
  frame: unknown,
): ProbeFrameData => {
  if (frame === null || typeof frame !== 'object') {
    return EMPTY_FRAME
  }
  const f = frame as ProbeFrame
  if (f.type !== 'broadcast') {
    return EMPTY_FRAME
  }
  if (f.message?.command !== 'feed_probe') {
    return EMPTY_FRAME
  }
  const p = f.message.params ?? {}
  return {
    rows: Array.isArray(p.rows) ? p.rows : [],
    flushSeq: numOrNull(p.flushSeq),
    rowCount: numOrNull(p.rowCount),
    session: strOrNull(p.session),
    channel: strOrNull(p.channel),
  }
}

/** The probe rows carried by a relay frame; `[]` for anything else. */
export const extractProbeRows = (
  frame: unknown,
): unknown[] => extractProbeFrame(frame).rows

export type SeqGap = {
  fromSeq: number
  toSeq: number
  lostFrames: number
}

export type SeqReport = {
  /** Frames that vanished between the sandbox and here. */
  gap: SeqGap | null
  /** The seq of the first frame seen for this key, if this was it. */
  started: number | null
  /** The sequence went backwards — a sandbox restart under a reused key. */
  restarted: boolean
}

/**
 * Contiguity of the sandbox's flush sequence, per session.
 *
 * WHY. Gate criterion 1 PASSES when the kept-row count is 0, so any loss
 * between the sandbox and this file reads as a pass. The loss paths are real
 * and none of them announces itself: the relay's 4 MiB inbound cap closes the
 * socket, Measurement D runs against the PRODUCTION relay whose token bucket
 * drops frames silently, and the sweep loop's rebuild/reload drops the socket
 * mid-flush. The heartbeat proves the COLLECTOR is alive; only this proves the
 * plugin's frames arrived.
 *
 * A jump becomes a `GAP` row in feed-poc.jsonl, so a deaf harness reads as a
 * number in the data rather than as an absence.
 */
export const trackFlushSeq = (
  state: Map<string, number>,
  key: string,
  seq: number | null,
): SeqReport => {
  if (seq === null) {
    return { gap: null, started: null, restarted: false }
  }
  const last = state.get(key)
  state.set(key, seq)
  if (last === undefined) {
    // A collector started after the plugin legitimately sees a nonzero seq
    // first. That is a known unknown, not a loss — report it as a start.
    return { gap: null, started: seq, restarted: false }
  }
  if (seq <= last) {
    return { gap: null, started: null, restarted: true }
  }
  if (seq === last + 1) {
    return { gap: null, started: null, restarted: false }
  }
  return {
    gap: {
      fromSeq: last,
      toSeq: seq,
      lostFrames: seq - last - 1,
    },
    started: null,
    restarted: false,
  }
}

/** JSONL: one self-contained JSON object per line, newline-terminated. This is
 *  the collector's entire output contract with Task 1f. */
export const toJsonl = (rows: readonly unknown[]): string =>
  rows.map(row => `${JSON.stringify(row)}\n`).join('')

export type CollectorOptions = {
  /** Relay WebSocket URL (default: the POC relay on localhost). */
  relayUrl?: string
  /** Output JSONL path (default: DEFAULT_OUT). */
  out?: string
  /** How often to re-poll /channels for channels to join. */
  pollMs?: number
  log?: (line: string) => void
}

export type Collector = {
  /** Rows appended so far — the liveness signal. */
  rows: () => number
  /** Channels currently joined. */
  channels: () => string[]
  /** Frames lost between the sandbox and this file. MUST be 0 for any case
   *  result to be readable. */
  lostFrames: () => number
  /** Distinct sandbox sessions seen. More than one means two plugins (or one
   *  reloaded plugin) wrote into the same file. */
  sessions: () => string[]
  /** Stop polling, close the socket, and flush pending appends. */
  stop: () => Promise<void>
}

export const startCollector = (
  opts: CollectorOptions = {},
): Collector => {
  const relayUrl =
    opts.relayUrl ?? `ws://localhost:${POC_RELAY_PORT}`
  const httpUrl = toHttpUrl(relayUrl)
  const out = opts.out ?? DEFAULT_OUT
  const pollMs = opts.pollMs ?? 2000
  const log =
    opts.log ?? ((line: string) => console.log(line))

  const joined = new Set<string>()
  const seqState = new Map<string, number>()
  const sessions = new Set<string>()
  let rowCount = 0
  let lostFrames = 0
  let stopped = false
  let socket: WebSocket | null = null
  let pollTimer: ReturnType<typeof setInterval> | null =
    null
  let retryTimer: ReturnType<typeof setTimeout> | null =
    null

  // Every append is chained onto this, so lines can never interleave.
  let writes: Promise<unknown> = mkdir(dirname(out), {
    recursive: true,
  })

  const append = (text: string): void => {
    writes = writes
      .then(() => appendFile(out, text))
      .catch(err => {
        log(`[poc-collect] WRITE FAILED: ${String(err)}`)
      })
  }

  const joinNewChannels = async (): Promise<void> => {
    const ws = socket
    if (
      stopped ||
      ws === null ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return
    }
    for (const info of await discoverChannels(httpUrl)) {
      if (stopped || joined.has(info.channel)) {
        continue
      }
      joined.add(info.channel)
      ws.send(
        JSON.stringify({
          type: 'join',
          channel: info.channel,
        }),
      )
      log(`[poc-collect] joined ${info.channel} → ${out}`)
    }
  }

  const connect = (): void => {
    if (stopped) {
      return
    }
    const ws = new WebSocket(relayUrl)
    socket = ws
    ws.onopen = () => {
      joined.clear()
      void joinNewChannels()
    }
    ws.onmessage = event => {
      let frame: unknown
      try {
        frame = JSON.parse(event.data as string)
      } catch {
        return
      }
      const probe = extractProbeFrame(frame)
      if (probe.rows.length === 0) {
        return
      }
      // Provenance is stamped HERE, not on the wire: one string per row on
      // disk costs nothing, one string per row in the frame counts against
      // the relay's 4 MiB inbound cap.
      const { channel: ch, session } = probe
      if (session !== null) {
        sessions.add(session)
      }
      const seq = trackFlushSeq(
        seqState,
        session ?? ch ?? relayUrl,
        probe.flushSeq,
      )
      if (seq.started !== null && seq.started > 0) {
        log(
          `[poc-collect] JOINED MID-STREAM at flushSeq ${seq.started} — ` +
            'frames before it were never seen; do not score a case across this point',
        )
      }
      if (seq.restarted) {
        log(
          `[poc-collect] flushSeq restarted (session ${session ?? 'unknown'}) — the sandbox reloaded`,
        )
      }
      if (seq.gap !== null) {
        lostFrames += seq.gap.lostFrames
        log(
          `[poc-collect] GAP — ${seq.gap.lostFrames} frame(s) LOST between ` +
            `flushSeq ${seq.gap.fromSeq} and ${seq.gap.toSeq}. Rows are missing; ` +
            'no case result may be read from this file.',
        )
        append(
          toJsonl([
            {
              raw: 'GAP',
              tEvent: Date.now(),
              ch,
              session,
              fromSeq: seq.gap.fromSeq,
              toSeq: seq.gap.toSeq,
              lostFrames: seq.gap.lostFrames,
            },
          ]),
        )
      }
      rowCount += probe.rows.length
      append(
        toJsonl(
          probe.rows.map(row =>
            row !== null && typeof row === 'object'
              ? { ...row, ch, session }
              : { raw: 'PROBE_JUNK', row, ch, session },
          ),
        ),
      )
    }
    ws.onerror = () => undefined
    ws.onclose = () => {
      joined.clear()
      if (!stopped) {
        log('[poc-collect] socket closed — reconnecting')
        retryTimer = setTimeout(connect, 500)
      }
    }
  }

  connect()
  pollTimer = setInterval(() => {
    void joinNewChannels()
  }, pollMs)

  return {
    rows: () => rowCount,
    channels: () => [...joined],
    lostFrames: () => lostFrames,
    sessions: () => [...sessions],
    stop: async () => {
      stopped = true
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      socket?.close()
      socket = null
      await writes
    },
  }
}

if (import.meta.main) {
  const relayUrl =
    process.env.POC_RELAY_URL ??
    `ws://localhost:${resolvePocPort(process.env.POC_RELAY_PORT)}`
  const out = process.env.POC_OUT ?? DEFAULT_OUT
  const collector = startCollector({ relayUrl, out })
  console.log(`[poc-collect] watching ${relayUrl} → ${out}`)
  if (out === DEFAULT_OUT) {
    // Task 1f scores each case with a jq over the WHOLE file, and appends
    // accumulate. Case 10's "exactly 20 distinct user ids" then has a false-
    // pass path: an earlier run's 20 ids satisfy it even when this actor run
    // silently no-opped. One file per case is the cheap fix.
    console.log(
      '[poc-collect] WARNING: writing to the shared default file. Run every ' +
        'case as POC_OUT=docs/scratch/poc/case-<n>.jsonl so its rows cannot ' +
        "be scored against an earlier run's.",
    )
  }
  // The heartbeat is the point: a collector that has gone quiet must look
  // different from a battery in which nothing survived the filter.
  setInterval(() => {
    const chans = collector.channels()
    const lost = collector.lostFrames()
    const sess = collector.sessions()
    console.log(
      `[poc-collect] ${collector.rows()} rows · channels: ${
        chans.length > 0 ? chans.join(', ') : 'none yet'
      }${lost > 0 ? ` · LOST ${lost} FRAME(S)` : ''}`,
    )
    if (chans.length > 1 || sess.length > 1) {
      // Two plugins (or a stale registration) interleaving into one file
      // makes case 11's "exactly 0 distinct kept ids" unanswerable rather
      // than merely noisy. Partition with `select(.ch == "…")`.
      console.log(
        `[poc-collect] WARNING: ${chans.length} channel(s) / ${sess.length} ` +
          'session(s) are writing into this file. Rows carry `ch` and ' +
          '`session` — scope every jq to ONE of them, or restart with a ' +
          'single plugin connected.',
      )
    }
  }, 5000)
}
