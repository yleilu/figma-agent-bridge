// grid-track.ts — the per-track sizing atom of a GRID layout (I56).
//
// One track of a Figma grid is a `GridTrackSize`: `{type: 'FLEX'|'FIXED'|'HUG',
// value?}`. `FLEX` is the CSS `fr` unit, `FIXED` is pixels, `HUG` sizes to the
// track's content. The grammar spells it the way CSS grid already does, because
// that is the vocabulary the concept has and inventing a second one would only
// be a thing to look up:
//
//   `1fr`  `2.5fr`  `fr`     a fractional track (bare `fr` means one fraction)
//   `240px`  `240`            a fixed track
//   `hug`                     a track that sizes to its content
//
// PARSE and RENDER live together on purpose. A read renders what a write must
// take back (T2), and that round trip is a property of ONE pair of functions —
// split across the reader and the writer it would be two lists someone has to
// keep aligned by hand, which is how the read face and the write face drift.

import { ToolError } from '../errors'

/** The Figma `GridTrackSize` shape, as it rides the wire to the plugin. */
export type GridTrack = {
  type: 'FLEX' | 'FIXED' | 'HUG'
  value?: number
}

/** What every refusal offers instead — one list, so it cannot drift from the parser. */
const SPELLINGS =
  'a fraction (`1fr`, `2.5fr`, or `fr` for one), a fixed size ' +
  '(`240px` or `240`), or `hug`'

const refuse = (atom: string, where: string): never => {
  throw new ToolError(
    'INVALID_PARAM',
    `layout.${where}: "${atom}" is not a track size. Write ${SPELLINGS}.`,
  )
}

/** A finite, non-negative number, or undefined when the text is not one. */
const size = (text: string): number | undefined => {
  if (text.trim() === '') {
    return undefined
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined
}

/**
 * Read one track atom.
 *
 * `where` names the slot in the caller's own words (`rowSizes[2]`) so a bad
 * entry in a five-track list says WHICH entry — the failure mode a bare "not a
 * track size" leaves the caller to find by bisection.
 */
export const parseTrack = (
  atom: string,
  where: string,
): GridTrack => {
  const text = atom.trim()
  if (text.toLowerCase() === 'hug') {
    return { type: 'HUG' }
  }
  if (text.toLowerCase() === 'fr') {
    return { type: 'FLEX', value: 1 }
  }
  if (text.toLowerCase().endsWith('fr')) {
    const value = size(text.slice(0, -2))
    return value === undefined
      ? refuse(atom, where)
      : { type: 'FLEX', value }
  }
  const body = text.toLowerCase().endsWith('px')
    ? text.slice(0, -2)
    : text
  const value = size(body)
  return value === undefined
    ? refuse(atom, where)
    : { type: 'FIXED', value }
}

/**
 * Render one track back to its atom.
 *
 * A `FLEX` track whose `value` Figma left unset renders `1fr`, not a bare `fr`:
 * one fraction is what it means, and the read face is the canonical one — two
 * spellings of one track there would put the choice on every reader.
 */
export const renderTrack = (track: {
  type?: unknown
  value?: unknown
}): string => {
  const value =
    typeof track.value === 'number'
      ? track.value
      : undefined
  if (track.type === 'HUG') {
    return 'hug'
  }
  if (track.type === 'FIXED') {
    return `${value ?? 0}px`
  }
  return `${value ?? 1}fr`
}

/**
 * Render a runtime track list, or undefined when the runtime carried none.
 *
 * A GRID frame on a runtime without the track API patches nothing across, and
 * an omitted key is the honest answer for it — unlike the two gaps, which are
 * always present and whose zero has to be stated (B63). There is no "no track
 * size" to confuse with a real one.
 */
export const renderTracks = (
  raw: unknown,
): string[] | undefined =>
  Array.isArray(raw) && raw.length > 0
    ? raw.map(track =>
        renderTrack(
          (track ?? {}) as {
            type?: unknown
            value?: unknown
          },
        ),
      )
    : undefined
