// The remembered Claude Code session id (request-envelope.md: SHALL). The
// server is 1:1 with a CC session, so the FIRST injected id is its identity for
// the life of the process. Required because the count mirror is written on a
// PUSH, and a push carries no sessionId at all.
import { UNATTRIBUTED } from '@figma-agent-bridge/shared/change-feed'

export type SessionIdentity = {
  remember(id: string | undefined): void
  current(): string | undefined
  /** Fired once, when the first id is remembered (or immediately if already). */
  onAdopt(cb: (id: string) => void): void
}

export const createSessionIdentity =
  (): SessionIdentity => {
    let id: string | undefined
    const cbs: ((id: string) => void)[] = []
    return {
      remember(next) {
        if (id !== undefined) {
          return
        }
        if (next === undefined || next.length === 0) {
          return
        }
        id = next
        for (const cb of cbs) {
          cb(id)
        }
        cbs.length = 0
      },
      current: () => id,
      onAdopt(cb) {
        if (id !== undefined) {
          cb(id)
          return
        }
        cbs.push(cb)
      },
    }
  }

/** The process-wide instance every registration wrapper calls `remember` on. */
export const sessionIdentity = createSessionIdentity()

/** A fixed point of `sanitizeKey`; no UUID session id can sanitize to it, and
 *  the same literal is the reserved WRITER name a frame's `writers[]` may
 *  carry. One degrade, named once — and named in `shared`, because the plugin
 *  stamps the same value at source. */
export const SENTINEL = UNATTRIBUTED

/**
 * ONE IDENTITY, TWO USES: the writer this server subtracts at ingest, and the
 * stem of the count file it writes. A server that filed its counts under one
 * identity while discarding another session's records would report a number it
 * did not compute — so both resolve through this single lookup and cannot
 * drift.
 *
 * A buffer can exist before its server has an identity, and `_unattributed` is
 * the RIGHT writer for that window rather than a placeholder: a server with no
 * identity also sends no `sessionId`, so the commands it issued then were
 * stamped `_unattributed` AT SOURCE, and subtracting that writer discards
 * exactly its own work.
 */
export const selfWriter = (): string =>
  sessionIdentity.current() ?? SENTINEL
