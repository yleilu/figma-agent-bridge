// Emission policy (change-feed.md, Plugin-side pipeline §4). The INVARIANT is
// that no record is ever dropped by the timer — excess is folded back into the
// accumulator by simply not emitting yet.
export type Flusher = {
  /** A record arrived. Arms the trailing debounce under the max-wait ceiling. */
  schedule(): void
  /** Emit now if anything is pending (the opening flush uses `emit` directly). */
  flushNow(): void
  cancel(): void
}

export const createFlusher = (opts: {
  debounceMs: number
  maxWaitMs: number
  /** 1000 / FEED_FRAMES_PER_SEC — an order below the relay bucket's refill. */
  minIntervalMs: number
  emit: () => void
  now?: () => number
}): Flusher => {
  const now = opts.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstPendingAt = 0
  let lastEmitAt = 0

  const fire = (): void => {
    timer = undefined
    const since = now() - lastEmitAt
    if (since < opts.minIntervalMs) {
      // Self-cap: re-arm at the earliest legal moment. Records stay in the
      // accumulator — the feed must never spend budget a command REPLY needs.
      timer = setTimeout(fire, opts.minIntervalMs - since)
      return
    }
    firstPendingAt = 0
    lastEmitAt = now()
    opts.emit()
  }

  return {
    schedule() {
      if (firstPendingAt === 0) firstPendingAt = now()
      if (timer !== undefined) clearTimeout(timer)
      const untilCeiling =
        firstPendingAt + opts.maxWaitMs - now()
      timer = setTimeout(
        fire,
        Math.max(
          0,
          Math.min(opts.debounceMs, untilCeiling),
        ),
      )
    },
    flushNow() {
      if (timer !== undefined) clearTimeout(timer)
      fire()
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      firstPendingAt = 0
    },
  }
}
