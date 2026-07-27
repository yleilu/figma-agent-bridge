// The on-disk count + state mirror (change-feed.md, Count mirror). The
// UserPromptSubmit hook is a separate process and cannot read server memory,
// so the server mirrors the COUNT and the STATE — never the records.
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeKey } from '@figma-agent-bridge/shared/paths'
import type { BaselineState } from '@figma-agent-bridge/shared/change-feed'

/** Honoured by BOTH the server and the presence hook. A hardcoded directory on
 *  one side of a two-process contract is a drift waiting to happen. */
export const resolveChangesDir = (): string =>
  process.env.FIGMA_BRIDGE_CHANGES_DIR ??
  join(homedir(), '.figma-agent-bridge', 'changes')

/** A fixed point of sanitizeKey; no UUID session id can sanitize to it. */
export const SENTINEL = '_unattributed'
export const COUNT_SCHEMA = 1

export type CountRecord = {
  schema: number
  /** The UNSANITIZED addressable identity, for debuggability. */
  fileKey: string
  /** genId('srv') — identifies the writing process (migration ownership). */
  writer: string
  pendingCount: number
  state: BaselineState
  updatedAt: number
}

export type CountMirror = {
  /**
   * `immediate` bypasses the trailing debounce. It exists because the spec's
   * trigger table lists `drain → immediate` unconditionally, and a TRUNCATED
   * drain (positive → positive, state unchanged) is indistinguishable from an
   * ordinary ingest by count and state alone. The caller — and only the caller
   * — knows a write came from a drain.
   */
  write(
    fileKey: string,
    pendingCount: number,
    state: BaselineState,
    writeOpts?: { immediate?: boolean },
  ): Promise<void>
  /**
   * On adoption: discard any session file left by a DIFFERENT writer, then
   * rewrite this process's sentinels under the real session id.
   */
  migrate(sessionId: string): Promise<void>
  /** Clean shutdown: unlink this process's own sentinels (sync — exit handler). */
  shutdown(): void
}

export const createCountMirror = (opts: {
  writer: string
  debounceMs: number
  sessionId: () => string | undefined
}): CountMirror => {
  // Files this process has written a SENTINEL into: fileKey → dir path.
  const sentinels = new Map<string, string>()
  const lastCount = new Map<string, number>()
  const lastState = new Map<string, BaselineState>()
  const timers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  // The in-flight write chain per fileKey (see `put`).
  const queues = new Map<string, Promise<void>>()
  let tmpSeq = 0

  /** A temp name no other writer can be using: a fixed `<file>.tmp` is shared
   *  state, and two writers racing on it lose a record or fail the rename. */
  const tmpFor = (target: string): string => {
    tmpSeq += 1
    return `${target}.${opts.writer}.${tmpSeq}.tmp`
  }

  const pathFor = (
    fileKey: string,
  ): { dir: string; file: string; isSentinel: boolean } => {
    const sid = opts.sessionId()
    const stem =
      sid === undefined ? SENTINEL : sanitizeKey(sid)
    const dir = join(
      resolveChangesDir(),
      sanitizeKey(fileKey),
    )
    return {
      dir,
      file: join(dir, `${stem}.json`),
      isSentinel: sid === undefined,
    }
  }

  const putNow = async (
    fileKey: string,
    pendingCount: number,
    state: BaselineState,
  ): Promise<void> => {
    const { dir, file, isSentinel } = pathFor(fileKey)
    await mkdir(dir, { recursive: true })
    const rec: CountRecord = {
      schema: COUNT_SCHEMA,
      fileKey,
      writer: opts.writer,
      pendingCount,
      state,
      updatedAt: Date.now(),
    }
    // Atomic: .tmp then rename — a kill mid-write can never leave a
    // half-written record for the hook to choke on.
    const tmp = tmpFor(file)
    await writeFile(tmp, JSON.stringify(rec), 'utf8')
    await rename(tmp, file)
    if (isSentinel) {
      sentinels.set(fileKey, dir)
    }
  }

  /**
   * Serialized per file, because the feed's triggers genuinely overlap — a
   * baseline open followed immediately by an ingest, or an ingest and a drain
   * in the same tick — and two concurrent write+rename pairs on one path race:
   * the later record can land first, mirroring a count the buffer no longer
   * holds. NEVER rejects: the callers are fire-and-forget (`void write(...)`),
   * so a filesystem error must degrade the mirror, not kill the MCP server.
   *
   * Migration and the adoption sweep run on this same chain: both read a
   * record, decide, then write or unlink, and anything that interleaves
   * between the decision and the write undoes it.
   */
  const enqueue = (
    fileKey: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const settled = (
      queues.get(fileKey) ?? Promise.resolve()
    )
      .then(task)
      .catch(() => undefined)
    queues.set(fileKey, settled)
    return settled
  }

  const put = (
    fileKey: string,
    pendingCount: number,
    state: BaselineState,
  ): Promise<void> => {
    // Recorded at ENQUEUE time, so the debounce decisions see the latest
    // INTENDED value rather than the last one that finished landing.
    lastCount.set(fileKey, pendingCount)
    lastState.set(fileKey, state)
    return enqueue(fileKey, () =>
      putNow(fileKey, pendingCount, state),
    )
  }

  /**
   * A count file is keyed on the SESSION, not on the process. An MCP server
   * that crashes, is `/mcp`-reconnected, or is restarted mid-session leaves its
   * last record behind — and the next process starts with NO buffers at all.
   * The `UserPromptSubmit` hook runs at the START of the next turn, before any
   * tool call, so it would read the dead writer's `{0, ok}` and render "safe to
   * act" over a server that is watching nothing, across user edits made through
   * the restart. A MISSING file reads as "no signal" (both fields omitted),
   * which is the honest answer for a process holding no buffers, so the
   * inherited file is discarded rather than trusted.
   *
   * Deleting another writer's SAME-SESSION file is sound because the server is
   * 1:1 with a Claude Code session (change-feed.md, "sessionId at write
   * time"): two writers under one session id are that session's old and new
   * process, never two live peers. Sentinels are deliberately NOT swept — they
   * are cross-session by construction, and the reader expires one older than
   * SENTINEL_TTL_MS instead.
   */
  const sweepForeign = async (
    stem: string,
  ): Promise<void> => {
    const root = resolveChangesDir()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return // nothing written yet — nothing to inherit
    }
    for (const entry of entries) {
      const path = join(root, entry, stem)
      // Partial, not CountRecord: this is another process's file and nothing
      // guarantees its shape. An absent `writer` is unknown provenance, which
      // sweeps for the same reason a foreign one does.
      let rec: Partial<CountRecord>
      try {
        rec = JSON.parse(
          await readFile(path, 'utf8'),
        ) as Partial<CountRecord>
      } catch {
        continue // absent, unreadable, or not a file dir
      }
      if (rec.writer === opts.writer) {
        continue
      }
      // On the file's OWN write chain, so a write this process enqueues during
      // the adoption window is never deleted by its own sweep. The directory
      // name is the fallback key: it is sanitizeKey(fileKey), so it partitions
      // the chain per file either way.
      const key =
        typeof rec.fileKey === 'string'
          ? rec.fileKey
          : entry
      await enqueue(key, async () => {
        try {
          const held = JSON.parse(
            await readFile(path, 'utf8'),
          ) as Partial<CountRecord>
          if (held.writer === opts.writer) {
            return
          }
        } catch {
          return
        }
        await unlink(path).catch(() => undefined)
      })
    }
  }

  return {
    async write(fileKey, pendingCount, state, writeOpts) {
      const prevCount = lastCount.get(fileKey)
      const prevState = lastState.get(fileKey)
      const immediate =
        writeOpts?.immediate === true || // caller says so (drain)
        prevCount === undefined || // baseline open
        prevState !== state || // state change
        pendingCount === 0 || // return to quiet
        (prevCount === 0 && pendingCount > 0) // LEADING edge
      const pending = timers.get(fileKey)
      if (pending !== undefined) {
        clearTimeout(pending)
        timers.delete(fileKey)
      }
      if (immediate) {
        await put(fileKey, pendingCount, state)
        return
      }
      // positive → positive: trailing debounce.
      timers.set(
        fileKey,
        setTimeout(() => {
          timers.delete(fileKey)
          void put(fileKey, pendingCount, state)
        }, opts.debounceMs),
      )
    },

    async migrate(sessionId) {
      const stem = `${sanitizeKey(sessionId)}.json`
      // FIRST: a file this session's PREVIOUS process left behind would
      // otherwise be inherited as truth by a server that holds no buffers.
      await sweepForeign(stem)
      for (const [fileKey, dir] of [...sentinels]) {
        const sentinelPath = join(dir, `${SENTINEL}.json`)
        const target = join(dir, stem)
        // The whole read → decide → write runs ON this file's write chain. A
        // write enqueued during the adoption window (a push landing right as
        // the id is learned) must not interleave between the freshness check
        // and the rename, or the older sentinel record wins the race the check
        // exists to settle.
        await enqueue(fileKey, async () => {
          let rec: CountRecord
          try {
            rec = JSON.parse(
              await readFile(sentinelPath, 'utf8'),
            ) as CountRecord
          } catch {
            return
          }
          // Ownership check: without it a CONCURRENT unattributed session's
          // sentinel would be adopted and deleted.
          if (rec.writer !== opts.writer) {
            return
          }
          // NEWER-WINS. A write can already have landed under the real session
          // id between adoption and this loop; copying the sentinel over it
          // would replay an older count — and an older `{0, ok}` reads as
          // "safe to act" in the presence block.
          let fresher = false
          try {
            const held = JSON.parse(
              await readFile(target, 'utf8'),
            ) as CountRecord
            fresher = held.updatedAt >= rec.updatedAt
          } catch {
            fresher = false
          }
          if (!fresher) {
            const tmp = tmpFor(target)
            await writeFile(
              tmp,
              JSON.stringify(rec),
              'utf8',
            )
            await rename(tmp, target)
          }
          await unlink(sentinelPath).catch(() => undefined)
        })
        sentinels.delete(fileKey)
      }
    },

    shutdown() {
      // A pending debounce must not resurrect a sentinel we are about to
      // unlink — clearing first makes the order irrelevant.
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      // The sentinel has no session to end: no SessionEnd hook can retire it,
      // so the writer unlinks ITS OWN on a clean exit. A kill leaves it —
      // which is why the reader expires one older than SENTINEL_TTL_MS.
      for (const dir of sentinels.values()) {
        const path = join(dir, `${SENTINEL}.json`)
        try {
          // shutdown runs from a process 'exit' handler, where no promise can
          // settle: sync is the only way to retire a sentinel that no
          // SessionEnd hook will ever clean up.
          // The same ownership guard migrate applies, for the same reason:
          // two concurrent unattributed sessions share this file
          // last-writer-wins, so a clean exit here must not delete the record
          // the OTHER process just wrote — that would blank its presence
          // fields entirely until its next write.
          const rec = JSON.parse(
            // eslint-disable-next-line n/no-sync -- exit handler, see above
            readFileSync(path, 'utf8'),
          ) as Partial<CountRecord>
          if (rec.writer !== opts.writer) {
            continue
          }
          // eslint-disable-next-line n/no-sync -- exit handler, see above
          unlinkSync(path)
        } catch {
          // already gone, or unreadable — nothing safe to do
        }
      }
      sentinels.clear()
    },
  }
}
