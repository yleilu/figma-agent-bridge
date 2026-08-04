// import-by-key.ts — resolve a published `key` to a component, with a deadline.
//
// `figma.importComponentByKeyAsync` returns a promise that NEVER SETTLES when
// the key is not an importable published component. Verified live four ways:
// a fake 40-hex key, a malformed key, a real local unpublished key, and the
// same API behind swap_component's own try/catch — none replied, while
// `status` answered instantly afterwards. It is not a network lookup (a
// malformed key hangs identically) and not our error handling (two nested
// catches never fire). There is nothing to catch, so the only defence is to
// stop waiting.

/** Server command timeout is 30s; leave room for the error to travel back. */
export const DEFAULT_IMPORT_DEADLINE_MS = 10_000

export type KeyImporters<C> = {
  component: (key: string) => Promise<C>
  set: (key: string) => Promise<{ defaultVariant: C }>
}

/**
 * Resolve `key` to a component, whether it names a COMPONENT or a
 * COMPONENT_SET, within `ms`.
 *
 * The two importers run CONCURRENTLY and the first *fulfilment* wins. A key
 * does not say which kind it is, and the wrong importer hangs rather than
 * rejecting — so trying them in sequence never reaches the second one, which
 * is why a `try/catch` fallback here is silently inert.
 *
 * A losing importer's promise stays pending forever; nothing can settle it.
 * That leak is Figma's. Bounding the command is the part we control.
 */
export const importComponentByKeyWithDeadline = <C>(
  key: string,
  importers: KeyImporters<C>,
  ms: number = DEFAULT_IMPORT_DEADLINE_MS,
): Promise<C> =>
  new Promise<C>((resolve, reject) => {
    let settled = false
    let rejections = 0

    const finish = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      fn()
    }

    // Only give up on rejection once BOTH have rejected — one importer
    // rejecting just means the key was the other kind.
    const fail = (e: unknown): void => {
      rejections += 1
      if (rejections === 2) {
        finish(() => reject(e))
      }
    }

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `component key "${key}" could not be imported within ${
                ms / 1000
              }s — it must be a PUBLISHED component or component set`,
            ),
          ),
        ),
      ms,
    )

    importers.component(key).then(
      c => finish(() => resolve(c)),
      fail,
    )
    importers.set(key).then(
      s => finish(() => resolve(s.defaultVariant)),
      fail,
    )
  })
