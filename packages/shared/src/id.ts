import { customAlphabet } from 'nanoid/non-secure'

// Lowercase alphanumeric: channel-safe, case-insensitive. See
// docs/specs/id-generation.md. non-secure = Math.random RNG, so this
// carries no secure-context dependency and runs identically in Node,
// the plugin sandbox, and the non-secure plugin UI iframe.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const id12 = customAlphabet(ALPHABET, 12)

/** A fresh random identifier. With a prefix: `<prefix>-<12 chars>`. */
export const genId = (prefix?: string): string =>
  prefix ? `${prefix}-${id12()}` : id12()

/** A fresh fixed-length token (default 8). */
export const genToken = (size = 8): string =>
  customAlphabet(ALPHABET, size)()
