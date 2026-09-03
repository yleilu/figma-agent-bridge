// cursor.ts — opaque cursor encode/decode for paginated list reads.
//
// The cursor is base64url(JSON.stringify({ pos, treeVersion })).
// It is opaque: decoding requires this module — consumers never parse it
// directly. Stale cursors (treeVersion mismatch) are detected and rejected
// with reason 'STALE' so the agent knows to re-query.

import type { Cursor } from '@figma-agent-bridge/shared/read-model'

/** Encode a cursor payload to an opaque base64url token. */
export const encodeCursor = (p: Cursor): string =>
  Buffer.from(JSON.stringify(p), 'utf8').toString(
    'base64url',
  )

/**
 * Decode a cursor token.
 *
 * Returns:
 *   { ok: true, pos } on valid token matching currentVersion
 *   { ok: false, reason: 'STALE' } when treeVersion != currentVersion
 *   { ok: false, reason: 'MALFORMED' } for any parse/shape error
 *
 * Never throws — all errors are returned as { ok: false }.
 */
export const decodeCursor = (
  token: string,
  currentVersion: string,
):
  | { ok: true; pos: number }
  | { ok: false; reason: 'STALE' | 'MALFORMED' } => {
  if (!token) {
    return { ok: false, reason: 'MALFORMED' }
  }

  // Buffer.from(..., 'base64url') does not throw on malformed input (it
  // decodes leniently / yields garbage bytes), so the real guard is the
  // JSON.parse below — no try/catch is needed around the decode.
  const json = Buffer.from(token, 'base64url').toString(
    'utf8',
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).pos !==
      'number' ||
    typeof (parsed as Record<string, unknown>)
      .treeVersion !== 'string'
  ) {
    return { ok: false, reason: 'MALFORMED' }
  }

  // `pos` is an index into the result list — it must be a non-negative
  // integer. Reject -5 / 1.5 / NaN rather than trusting the token blindly.
  const pos = (parsed as Record<string, unknown>)
    .pos as number
  if (!Number.isInteger(pos) || pos < 0) {
    return { ok: false, reason: 'MALFORMED' }
  }

  const payload = parsed as Cursor

  if (payload.treeVersion !== currentVersion) {
    return { ok: false, reason: 'STALE' }
  }

  return { ok: true, pos: payload.pos }
}
