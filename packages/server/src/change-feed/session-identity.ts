// The remembered Claude Code session id (request-envelope.md: SHALL). The
// server is 1:1 with a CC session, so the FIRST injected id is its identity for
// the life of the process. Required because the count mirror is written on a
// PUSH, and a push carries no sessionId at all.
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
