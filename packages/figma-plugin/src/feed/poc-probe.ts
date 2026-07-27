// POC ONLY (docs/scratch/plans/2026-07-26-change-feed.md, Task 1).
// DELETE this file, its test, and every `poc*` reference in code.ts /
// useRelay.ts in Task 7.
//
// The two PURE parts of the sandbox probe, split out so they can be unit
// tested — the rest of the probe is `figma.on` wiring that only means
// anything against the live runtime.

/** Why a row was or was not emitted.
 *
 *  `dropped-unfiltered` is deliberately NOT one of the filter's verdicts: it
 *  covers every drop the self-write window did not cause (an unmapped
 *  DocumentChange type, a change with no reachable id, a drop while the
 *  window was closed). Folding those into `dropped-cascade` would inflate
 *  Measurement B's cascade histogram with shapes the filter never touched.
 *
 *  `kept-context` is an ADMITTED context event (a page switch or a selection
 *  change the window did not suppress) and is deliberately NOT spelled
 *  `kept`. The POC pending count is
 *  `select(.verdict == "kept") | .id | unique | length`, and a context event
 *  is never a mutation — the spec is explicit that it "never counts toward
 *  pending_edits". Labelling one `kept` would put the current page's id, and
 *  a `null` for every selection change, into case 10's expected-20 count and
 *  into case 11's must-be-0. Only the two context listeners emit it; the
 *  classifier below never returns it. */
export type PocVerdict =
  | 'kept'
  | 'kept-context'
  | 'dropped-touched'
  | 'dropped-cascade'
  | 'dropped-context'
  | 'dropped-unfiltered'

type RawChange = {
  type?: unknown
  id?: unknown
  node?: { id?: unknown } | null
  style?: { id?: unknown } | null
}

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : null

/**
 * The id the filter keys on, resolved the SAME way
 * `createSelfWriteFilter.admit` resolves it: STYLE_* reads `change.style`,
 * everything else reads `change.node`, and `change.id` is the fallback
 * (StyleDeleteChange narrows `style` to null).
 *
 * The probe must not resolve this differently. A probe that logged
 * `change.node?.id` alone would record `null` for every style change, and the
 * POC pending count — distinct ids among `kept` rows — would then collapse N
 * leaked style writes into one, understating exactly the failure case 11
 * exists to catch.
 */
export const pocChangeId = (
  change: unknown,
): string | null => {
  const c = (change ?? {}) as RawChange
  const target =
    typeof c.type === 'string' &&
    c.type.startsWith('STYLE_')
      ? c.style
      : c.node
  return str(target?.id) ?? str(c.id)
}

/** Attribute a drop to the mechanism that caused it. `kept` is simply
 *  whether `admit` returned a record; everything else is read off the same
 *  scope the filter consulted. */
export const pocVerdict = (input: {
  kept: boolean
  id: string | null
  open: boolean
  touched: ReadonlySet<string>
  reflow: ReadonlySet<string>
}): PocVerdict => {
  if (input.kept) return 'kept'
  const { id } = input
  if (id === null || !input.open) {
    return 'dropped-unfiltered'
  }
  // Order mirrors admit(): the whole-record touched drop is tested before
  // the per-property cascade subtraction.
  if (input.touched.has(id)) return 'dropped-touched'
  if (input.reflow.has(id)) return 'dropped-cascade'
  return 'dropped-unfiltered'
}

export type PocFlushBatch = {
  /** Rows to put on the wire now. */
  frame: unknown[]
  /** Rows held back for the next tick. */
  rest: unknown[]
  /** Rows the backlog cap discarded — reported, never silent. */
  dropped: number
}

/**
 * Split the pending rows into one frame plus a deferred remainder.
 *
 * TWO independent drop paths make this necessary, and neither announces
 * itself:
 *   - the relay's `MAX_PAYLOAD_BYTES` (4 MiB) is a module constant wired
 *     straight into Bun's `maxPayloadLength`, NOT a `StartRelayOptions` field,
 *     so the POC relay cannot disarm it the way it disarms the token bucket.
 *     Bun answers an oversize inbound frame by CLOSING the socket, taking the
 *     whole flush with it — and the heaviest flushes are exactly the samples
 *     of the measurement that exists to characterise load;
 *   - an unbounded `pocRows` grows without limit if the sandbox produces
 *     faster than the 500 ms flush drains.
 *
 * Capping the frame handles the first; `backlogCap` handles the second. Drops
 * come off the NEWEST end so the emitted stream stays contiguous in time and
 * the hole sits at the end of the burst, where the caller's `PROBE_OVERFLOW`
 * row marks it — a gap in the middle of a batch would be indistinguishable
 * from a batch that simply carried fewer changes.
 */
export const pocTakeFlush = (
  rows: readonly unknown[],
  cap: number,
  backlogCap: number,
): PocFlushBatch => {
  const frame = rows.slice(0, cap)
  const held = rows.slice(cap)
  if (held.length <= backlogCap) {
    return { frame, rest: held, dropped: 0 }
  }
  return {
    frame,
    rest: held.slice(0, backlogCap),
    dropped: held.length - backlogCap,
  }
}
