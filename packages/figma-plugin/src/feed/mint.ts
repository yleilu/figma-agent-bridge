// Names → masks (change-feed.md, "The attributor stamps names").
//
// A bit index is meaningful only against a table, and the table is a property
// of a FRAME: `writers[]` holds the sessions named by the records in ONE flush.
// It cannot exist while records are being admitted — the documentchange handler
// runs one event at a time, FLUSH_DEBOUNCE_MS before the frame is assembled, and
// a writer first appearing late in the window would renumber bits already
// stamped. So `admit` returns NAMES, the accumulator folds names, and the
// indices are assigned exactly once, here, over the drained batch.
//
// A pure function on the flush path rather than a method on the flusher: the
// flusher is an emission TIMER, and what matters is that the minting happens
// once, over the whole batch, at flush.
import {
  WRITERS_CAP,
  type AttributedRecord,
  type ChangeRecord,
} from '@figma-agent-bridge/shared/change-feed'

const maskOf = (
  names: ReadonlySet<string> | undefined,
  bits: Map<string, number>,
): number => {
  let mask = 0
  for (const name of names ?? []) {
    // A writer past the cap won NO BIT: its records go out unattributed and
    // are kept by everyone including itself — over-reporting, never a wrong
    // drop.
    mask |= bits.get(name) ?? 0
  }
  return mask
}

/**
 * Rewrite a drained batch's writer NAME SETS as integer masks over a
 * per-frame table.
 *
 * `writers` is ABSENT when no record in the flush is attributed, so an
 * all-user frame costs nothing for a mechanism it does not use.
 *
 * The table order is FIRST APPEARANCE in `changes`, which is stable for a
 * given batch and therefore testable. It bounds the distinct writers in ONE
 * FLUSH WINDOW — a few hundred milliseconds of document activity — not the
 * sessions a plugin has ever seen, so minting per frame keeps `WRITERS_CAP`
 * a per-flush accident rather than a state the connection can settle into.
 */
export const mintFrame = (
  records: readonly AttributedRecord[],
  cap: number = WRITERS_CAP,
): { changes: ChangeRecord[]; writers?: string[] } => {
  const bits = new Map<string, number>()
  const writers: string[] = []
  for (const rec of records)
    for (const names of [rec.by, rec.rf])
      for (const name of names ?? []) {
        if (bits.has(name) || writers.length >= cap)
          continue
        bits.set(name, 1 << writers.length)
        writers.push(name)
      }

  const changes = records.map(rec => {
    const { by, rf, ...rest } = rec
    const out: ChangeRecord = rest
    const byMask = maskOf(by, bits)
    const rfMask = maskOf(rf, bits)
    if (byMask !== 0) out.by = byMask
    if (rfMask !== 0) out.rf = rfMask
    return out
  })

  return writers.length > 0
    ? { changes, writers }
    : { changes }
}
