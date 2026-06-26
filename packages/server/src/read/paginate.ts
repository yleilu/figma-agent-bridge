// paginate.ts — the one reusable limit+cursor helper for bounded list reads
// (T10). Every list-returning read pages through this so the contract is owned
// in ONE place: a default `limit`, a `truncated` flag, and an opaque,
// version-stamped continuation `cursor`.
//
// Generalizes the limit+cursor logic `search` carried inline. The cursor reuses
// read/cursor.ts (encodeCursor/decodeCursor) — opaque (base64url JSON, never
// parsed by callers) and version-stamped (a content-hash of the ordered id-set)
// so resuming a token against a CHANGED list is reported STALE rather than
// silently mis-paged. A MALFORMED token (garbage / wrong shape) is likewise
// rejected. Both are surfaced as a typed `CursorError` the caller catches.

import { createHash } from 'node:crypto'
import { encodeCursor, decodeCursor } from './cursor'

/** Default page size for every list read (T10). */
export const DEFAULT_LIMIT = 100

/**
 * A rejected continuation cursor. Thrown by `paginateList` when a supplied
 * cursor is STALE (minted against a different id-set) or MALFORMED (garbage /
 * wrong shape). The caller catches it and surfaces the reason — the cursor is
 * opaque, so a wrong/old token must be reported (T7), never silently resumed.
 */
export class CursorError extends Error {
  readonly reason: 'STALE' | 'MALFORMED'
  constructor(reason: 'STALE' | 'MALFORMED') {
    super(`Cursor rejected (${reason})`)
    this.name = 'CursorError'
    this.reason = reason
  }
}

/** A paginated slice of a list read. `cursor` present only when `truncated`. */
export type Page<T> = {
  page: T[]
  truncated: boolean
  cursor?: string
}

/**
 * Version-stamp for a list. A cursor minted against one ordered id-set must not
 * silently resume against a different one — we hash the ordered ids so a changed
 * set yields a different treeVersion (→ decodeCursor STALE).
 */
const versionOf = (items: { id?: string }[]): string =>
  createHash('sha1')
    .update(items.map(i => i.id ?? '').join('\n'))
    .digest('base64url')
    .slice(0, 12)

/**
 * Bound a list read to one page.
 *
 * @param items the full, ordered result list (the server's matched/projected
 *              candidates; each carries an `id` used for the version stamp)
 * @param limit page size, defaults to 100
 * @param cursor opaque continuation token from a prior page (optional)
 * @returns `{ page, truncated, cursor? }`
 * @throws {CursorError} when `cursor` is STALE or MALFORMED
 */
export const paginateList = <T extends { id?: string }>(
  items: T[],
  {
    limit = DEFAULT_LIMIT,
    cursor,
  }: { limit?: number; cursor?: string },
): Page<T> => {
  // Clamp to >=1 so a caller passing limit<=0 can't make a zero-width page
  // that reports truncated forever (no-progress loop). This helper is the one
  // implementation behind every bounded list read (T10), so it self-defends.
  const lim = Math.max(1, Math.floor(limit))
  const treeVersion = versionOf(items)

  let start = 0
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor, treeVersion)
    if (!decoded.ok) {
      throw new CursorError(decoded.reason)
    }
    start = decoded.pos
  }

  const end = start + lim
  const page = items.slice(start, end)
  const truncated = end < items.length

  const out: Page<T> = { page, truncated }
  if (truncated) {
    out.cursor = encodeCursor({ pos: end, treeVersion })
  }
  return out
}
