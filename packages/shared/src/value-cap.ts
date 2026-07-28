// Value measurement under the size caps (change-feed.md, "Values, and the cap
// that bounds them"). Pure and shared: the plugin measures at admit time,
// inside the synchronous documentchange handler, and the server measures again
// when it spends DRAIN_VALUE_BUDGET — one measure, so the two cannot disagree.
//
// SIZE decides which values are carried, never the property NAME: a table of
// expensive property names would drift against the runtime, a byte count
// cannot.

import {
  VALUE_MAX_BYTES,
  VALUE_MAX_ITEMS,
} from './change-feed'

/** Returned by the walker when the running total has passed the cap. */
const OVER = -1

// \b \t \n \f \r — the escapes JSON writes in two bytes. Every other control
// character costs six ().
const SHORT_ESCAPES = new Set([
  0x08, 0x09, 0x0a, 0x0c, 0x0d,
])

/**
 * UTF-8 byte length of the JSON serialization of `s`, quotes included, ABORTING
 * once the running total passes `cap` (the return is then simply > cap). Never
 * under-counts: escapes are charged at their serialized width.
 */
const stringBytes = (s: string, cap: number): number => {
  let n = 2 // the quotes
  for (let i = 0; i < s.length && n <= cap; i += 1) {
    const c = s.charCodeAt(i)
    if (c === 0x22 || c === 0x5c) {
      n += 2 // \" and \\
    } else if (c < 0x20) {
      n += SHORT_ESCAPES.has(c) ? 2 : 6
    } else if (c < 0x80) {
      n += 1
    } else if (c < 0x800) {
      n += 2
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1)
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        n += 4 // a surrogate PAIR is one 4-byte code point
        i += 1
      } else {
        n += 6 // a LONE surrogate: JSON.stringify escapes it
      }
    } else {
      n += 3
    }
  }
  return n
}

/** True for the three values JSON.stringify omits from an object and renders
 *  as `null` inside an array. */
const isJsonHole = (v: unknown): boolean =>
  v === undefined ||
  typeof v === 'function' ||
  typeof v === 'symbol'

/**
 * True only for an object that is JSON DATA — a plain bag of own enumerable
 * keys. Anything else is refused, and that refusal is still a SIZE test rather
 * than a table of property names: a value JSON cannot carry has no size.
 *
 * It exists because a Figma node exposes its properties as PROTOTYPE
 * ACCESSORS. `Object.keys(node)` is empty, so a walk measures a whole node at
 * the two bytes of `{}` — the smallest measurement possible, which under
 * ascending order is carried FIRST and always. Two of the properties a change
 * event names are node-valued (`parent`, `prototypeStartNode`), and `parent`
 * is what a human's reorder inside an auto-layout frame emits. Carrying one
 * would put a fabricated `{}` on the wire at best, and at worst hand
 * `postMessage` a value it cannot clone.
 */
const isPlainData = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Accumulate the serialized byte length of `v` onto `used`, aborting the moment
 * the total passes `cap`. Returns the new total, or OVER.
 *
 * The cap bounds DEPTH as well as breadth — every nesting level costs at least
 * the two bytes of its brackets — so a cyclic value aborts rather than
 * recursing away, and the caller's try/catch is a backstop, not the mechanism.
 */
const walk = (
  v: unknown,
  used: number,
  cap: number,
): number => {
  if (used > cap) {
    return OVER
  }
  if (v === null) {
    return used + 4
  }
  if (typeof v === 'boolean') {
    return used + (v ? 4 : 5)
  }
  if (typeof v === 'number') {
    // A non-finite number serializes as `null`.
    return (
      used + (Number.isFinite(v) ? String(v).length : 4)
    )
  }
  if (typeof v === 'string') {
    const n = used + stringBytes(v, cap - used)
    return n > cap ? OVER : n
  }
  if (typeof v !== 'object') {
    // bigint (JSON.stringify THROWS on one), and the holes, which cannot
    // reach here: the caller renders them without a walk.
    return OVER
  }

  if (Array.isArray(v)) {
    let n = used + 2 // []
    for (let i = 0; i < v.length; i += 1) {
      if (i > 0) {
        n += 1 // the comma
      }
      const el = v[i]
      n = isJsonHole(el) ? n + 4 : walk(el, n, cap)
      if (n === OVER || n > cap) {
        return OVER
      }
    }
    return n
  }

  if (!isPlainData(v)) {
    return OVER
  }

  const obj = v as Record<string, unknown>
  let n = used + 2 // {}
  let first = true
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (!isJsonHole(val)) {
      if (!first) {
        n += 1 // the comma
      }
      first = false
      n += stringBytes(key, cap - n) + 1 // "key":
      if (n > cap) {
        return OVER
      }
      n = walk(val, n, cap)
      if (n === OVER) {
        return OVER
      }
    }
  }
  return n > cap ? OVER : n
}

/**
 * The serialized size of one property value in bytes, or `null` when it does
 * not fit VALUE_MAX_BYTES (or cannot be serialized at all). Never throws.
 *
 * The O(1) PRE-CHECK RUNS FIRST — a string longer than VALUE_MAX_BYTES, an
 * array longer than VALUE_MAX_ITEMS — so learning that an eight-kilobyte
 * string or a sixty-paint array is over the cap costs nothing, and only what
 * survives it is serialized, by a walker free to abort at the cap. The
 * pre-check is a size test too: it is the same test performed on the cheapest
 * available measure of size.
 */
export const measureValue = (v: unknown): number | null => {
  if (typeof v === 'string' && v.length > VALUE_MAX_BYTES) {
    // A JSON string is at least its length in bytes, plus quotes.
    return null
  }
  if (Array.isArray(v) && v.length > VALUE_MAX_ITEMS) {
    return null
  }
  if (isJsonHole(v)) {
    return null // nothing JSON can carry
  }
  try {
    const n = walk(v, 0, VALUE_MAX_BYTES)
    return n === OVER ? null : n
  } catch {
    return null
  }
}

/** One candidate property. `read` is deferred so a value that is never
 *  considered is never touched, and so a read that THROWS costs only itself. */
export type ValueEntry = {
  name: string
  read: () => unknown
}

type Sized = {
  name: string
  value: unknown
  size: number
}

const readSafely = (
  read: () => unknown,
): { ok: boolean; value?: unknown } => {
  try {
    return { ok: true, value: read() }
  } catch {
    // An access that throws — a node on a page the runtime has not loaded —
    // yields NO value: the property keeps its place in `props` and gains no
    // entry in `set`. Reading fails toward the names-only record, never toward
    // an exception in the handler.
    return { ok: false }
  }
}

/**
 * Choose which of `entries` a record (or a response) can afford to carry.
 *
 * Properties are considered in ASCENDING serialized size, TIES BROKEN BY NAME,
 * and each is kept while it fits both VALUE_MAX_BYTES (enforced by
 * measureValue) and the remaining `budget`. Ascending order maximises how many
 * properties one budget answers; the tie-break makes the outcome deterministic,
 * and therefore testable, rather than dependent on the order the runtime
 * happened to list them in.
 *
 * The result is a SUBSET of the names it was given, never a different key set:
 * a property considered and not carried stays in `props` and is the honest
 * "this changed and you must re-read it".
 */
export const pickValues = (
  entries: readonly ValueEntry[],
  budget: number,
): Map<string, unknown> => {
  const sized: Sized[] = []
  for (const entry of entries) {
    const r = readSafely(entry.read)
    if (r.ok) {
      const size = measureValue(r.value)
      if (size !== null) {
        sized.push({
          name: entry.name,
          value: r.value,
          size,
        })
      }
    }
  }

  sized.sort((a, b) => {
    if (a.size !== b.size) {
      return a.size - b.size
    }
    if (a.name === b.name) {
      return 0
    }
    return a.name < b.name ? -1 : 1
  })

  const picked = new Map<string, unknown>()
  let used = 0
  for (const item of sized) {
    if (used + item.size > budget) {
      // Ascending, so nothing after this one fits either.
      break
    }
    picked.set(item.name, item.value)
    used += item.size
  }
  return picked
}
