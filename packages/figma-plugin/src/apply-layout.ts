// Pure, side-effect-free auto-layout applier shared by create + update paths.
//
// The server's writer (`convertLayout` in node-spec-writer.ts) is PURE: it
// emits `spacing`/`padding`/`align`/`wrap` ONLY when present on the LayoutSpec.
// So this applier must mirror that contract — set each Figma field ONLY when
// the corresponding key is present, leaving Figma's own defaults untouched
// otherwise (no backfill). Setting them unconditionally indexed `padding[0]` /
// `align[0]` on a partial layout (e.g. `{mode:'H',wrap:true}`) and threw
// "Cannot read properties of undefined (reading '0')", failing the whole
// create/update.
//
// EVERY FIELD IS READ BACK (B58). Setting a Figma property is not the same as
// the property holding the value, so each field this module writes is read
// back, a mismatch is written once more, and a field that still refuses is
// NAMED in `warnings` with what was asked and what is actually there. What
// this module must never do is report nothing while the layout the caller
// stated is not the layout on the node.
//
// This is a THIN NET for unknown future drops, and deliberately nothing more.
// It was built to catch B58 and it could not: the value it read back was
// honest, and the write had still been destroyed. The real cause was never a
// dropped setter — it was `align: SPACE_BETWEEN` paired with a VARIABLE-BOUND
// `gap`, a self-contradictory pair that Figma's plugin API stores and renders
// while its properties panel silently normalizes it away. That pair is now
// refused before it can be written (see space-between-guard.ts), which is the
// actual fix; this net stays only for whatever comes next.
//
// It has no knowledge of the UI selection and does not touch it. Three earlier
// rounds deselected the target, waited for the deselection to render, and
// restored the selection afterwards, all on a mis-attributed trigger. A plain
// literal gap writes fine under a live selection, so none of that machinery
// was ever load-bearing.
//
// This module declares the FrameNode surface it touches structurally (the
// figma `FrameNode` is structurally assignable to it) so it stays free of the
// figma runtime and is independently unit-testable with a plain fake node.

/** One grid track, as the server's `parseTrack` emits it (Figma's GridTrackSize). */
export type AppliedTrack = {
  type: 'FLEX' | 'FIXED' | 'HUG'
  value?: number
}

/** The exact layout shape the server's `convertLayout` emits. */
export type AppliedLayout = {
  mode: 'H' | 'V' | 'NONE' | 'GRID'
  spacing?: number
  padding?: [number, number, number, number]
  align?: [string, string]
  wrap?: boolean
  /** Grid row count (GRID mode only). */
  rows?: number
  /** Grid column count (GRID mode only). */
  cols?: number
  /** Grid row gap in px (GRID mode only). */
  rowGap?: number
  /** Grid column gap in px (GRID mode only). */
  colGap?: number
  /** Per-row track sizes, top to bottom (GRID mode only, I56). */
  rowSizes?: AppliedTrack[]
  /** Per-column track sizes, left to right (GRID mode only, I56). */
  colSizes?: AppliedTrack[]
}

/** Structural subset of FrameNode this applier writes to. */
export type LayoutTarget = {
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  itemSpacing: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  primaryAxisAlignItems:
    | 'MIN'
    | 'MAX'
    | 'CENTER'
    | 'SPACE_BETWEEN'
  counterAxisAlignItems:
    | 'MIN'
    | 'MAX'
    | 'CENTER'
    | 'BASELINE'
  layoutWrap: 'NO_WRAP' | 'WRAP'
  // GRID fields (M12) — optional in the structural type so that runtimes
  // without GRID support remain structurally assignable. Presence is checked
  // at runtime via `'gridRowCount' in frame` (T7 feature-detect).
  gridRowCount?: number
  gridColumnCount?: number
  gridRowGap?: number
  gridColumnGap?: number
  // Per-track sizing (I56). Also optional, also feature-detected: a runtime
  // with the counts but not the tracks is a real intermediate — the two
  // capabilities landed in different Figma releases.
  gridRowSizes?: AppliedTrack[]
  gridColumnSizes?: AppliedTrack[]
}

/** One Figma field this call means to set, and the value it means to set it to. */
type Intent = {
  field: keyof LayoutTarget
  value: string | number
}

/**
 * The Figma layoutMode a spec `mode` asks for. 'NONE' disables auto-layout
 * (it is NOT 'V'); 'H'/'V' map to HORIZONTAL/VERTICAL; 'GRID' maps to GRID.
 */
const layoutModeOf = (
  mode: AppliedLayout['mode'],
): LayoutTarget['layoutMode'] =>
  mode === 'NONE'
    ? 'NONE'
    : mode === 'H'
      ? 'HORIZONTAL'
      : mode === 'GRID'
        ? 'GRID'
        : 'VERTICAL'

/**
 * Everything this layout means to write, as flat field→value intents.
 *
 * The list IS the contract: `writeLayout` sets exactly these and the verify
 * checks exactly these, so a field can never be written without being proved,
 * or proved without being written. A grid field the runtime does not expose is
 * left out here — its absence is reported once, as a capability degrade, and is
 * not a dropped write.
 */
const intentsOf = (
  frame: LayoutTarget,
  layout: AppliedLayout,
): Intent[] => {
  const out: Intent[] = []
  const targetMode = layoutModeOf(layout.mode)
  // A mode the frame already holds is skipped, not re-written: Figma's
  // layoutMode setter re-initializes the grid on a GRID→GRID write and throws
  // "Cannot delete occupied row/column" when a child SPANS rows (live-proven
  // 2026-08-29 — retracking the dashboard shell). Same law as the count guard
  // below and the cell anchor guard: what a read handed back must write back
  // as a no-op. A CHANGED mode always writes.
  if (frame.layoutMode !== targetMode) {
    out.push({ field: 'layoutMode', value: targetMode })
  }
  if (layout.spacing !== undefined) {
    out.push({
      field: 'itemSpacing',
      value: layout.spacing,
    })
  }
  if (layout.padding !== undefined) {
    out.push(
      { field: 'paddingTop', value: layout.padding[0] },
      { field: 'paddingRight', value: layout.padding[1] },
      { field: 'paddingBottom', value: layout.padding[2] },
      { field: 'paddingLeft', value: layout.padding[3] },
    )
  }
  if (layout.align !== undefined) {
    out.push(
      {
        field: 'primaryAxisAlignItems',
        value: layout.align[0],
      },
      {
        field: 'counterAxisAlignItems',
        value: layout.align[1],
      },
    )
  }
  // `wrap: false` is deliberately NOT an intent: the pure-emit contract never
  // sets NO_WRAP, so there is nothing to verify.
  if (layout.wrap === true) {
    out.push({ field: 'layoutWrap', value: 'WRAP' })
  }
  if (layout.mode === 'GRID') {
    const grid: [keyof LayoutTarget, number | undefined][] =
      [
        ['gridRowCount', layout.rows],
        ['gridColumnCount', layout.cols],
        ['gridRowGap', layout.rowGap],
        ['gridColumnGap', layout.colGap],
      ]
    for (const [field, value] of grid) {
      if (value === undefined || !(field in frame)) {
        continue
      }
      // A COUNT the frame already holds is skipped, not re-written: Figma's
      // count setter throws "Cannot delete occupied row/column" on an axis a
      // child SPANS — even at the unchanged value (live-proven 2026-08-29 on
      // the dashboard shell). A read-modify-write that hands rows/cols back
      // must be a no-op, the same law the cell anchor guard follows. A
      // CHANGED count still writes, so a genuine shrink into occupied tracks
      // stays a loud refusal.
      if (
        (field === 'gridRowCount' ||
          field === 'gridColumnCount') &&
        (frame as unknown as Record<string, unknown>)[
          field
        ] === value
      ) {
        continue
      }
      out.push({ field, value })
    }
  }
  return out
}

const writeLayout = (
  frame: LayoutTarget,
  intents: Intent[],
): void => {
  const target = frame as unknown as Record<string, unknown>
  for (const { field, value } of intents) {
    target[field] = value
  }
}

/**
 * Whether the field holds what was asked. Numbers are compared with a small
 * tolerance: Figma stores layout numbers as floats, and calling a 12 that came
 * back 11.999999 a dropped write would be a warning about nothing.
 */
const held = (actual: unknown, want: string | number) =>
  typeof want === 'number'
    ? typeof actual === 'number' &&
      Math.abs(actual - want) < 0.01
    : actual === want

// ─── per-track sizing (I56) ───────────────────────────────────────────────────
//
// ⚠️ THE MECHANISM IS DOCUMENTED, NOT LIVE-CONFIRMED.
//
// `gridRowSizes` returns an array of `GridTrackSize` objects, and Figma's own
// example mutates one IN PLACE — `frame.gridRowSizes[0].type = 'FIXED'` — then
// reads the new value back off the frame. That only works if the entries are
// LIVE handles. If the runtime hands back a detached snapshot, the mutation
// lands on a copy and the frame keeps its old tracks, silently: the exact shape
// of failure this campaign already met once, where the real effect happens at
// assignment time and a headless green proves nothing.
//
// So both mechanisms are used, in the order the docs put them. The entries are
// mutated first; the tracks are read back; and only if a track did not hold is
// the WHOLE array assigned (the property is writable in the typings). A track
// that survives neither is NAMED. Whichever runtime Figma turns out to be, the
// caller is told the truth about what landed.

/** Whether a track holds what was asked. HUG carries no size to compare. */
const trackHeld = (
  actual: AppliedTrack | undefined,
  want: AppliedTrack,
): boolean => {
  if (actual?.type !== want.type) {
    return false
  }
  if (want.type === 'HUG' || want.value === undefined) {
    return true
  }
  return (
    typeof actual.value === 'number' &&
    Math.abs(actual.value - want.value) < 0.01
  )
}

/** The tracks a frame currently reports on one axis, or [] when it reports none. */
const tracksOf = (
  frame: LayoutTarget,
  field: 'gridRowSizes' | 'gridColumnSizes',
): AppliedTrack[] => {
  const raw = (frame as unknown as Record<string, unknown>)[
    field
  ]
  return Array.isArray(raw) ? (raw as AppliedTrack[]) : []
}

/**
 * Size the tracks of one axis, and prove each one landed.
 *
 * The COUNT is not touched here — `gridRowCount` is an intent above, and a
 * track list is a description of tracks that already exist. Naming more tracks
 * than the grid has is therefore a caller error worth its own sentence: the
 * ones that fit are still applied, because dropping the whole list over one
 * extra entry would lose work the caller can use.
 */
const applyTracks = (
  frame: LayoutTarget,
  field: 'gridRowSizes' | 'gridColumnSizes',
  key: 'rowSizes' | 'colSizes',
  want: AppliedTrack[],
  warnings?: string[],
): void => {
  const tracks = tracksOf(frame, field)
  if (tracks.length !== want.length) {
    warnings?.push(
      `applyLayout: \`${key}\` names ${want.length} track(s) but the grid has ` +
        `${tracks.length} — the first ${Math.min(tracks.length, want.length)} ` +
        'were applied. Set `rows`/`cols` to the track count you mean.',
    )
  }
  const n = Math.min(tracks.length, want.length)
  for (let i = 0; i < n; i += 1) {
    tracks[i].type = want[i].type
    if (
      want[i].type !== 'HUG' &&
      want[i].value !== undefined
    ) {
      tracks[i].value = want[i].value
    }
  }

  // Read back. A snapshot runtime loses every write above, so the retry is the
  // OTHER mechanism (assign the whole array), not the same one again.
  const after = tracksOf(frame, field)
  const missed = want
    .slice(0, n)
    .some((track, i) => !trackHeld(after[i], track))
  if (missed) {
    try {
      ;(frame as unknown as Record<string, unknown>)[
        field
      ] = after.map((track, i) =>
        i < n
          ? {
              type: want[i].type,
              ...(want[i].type !== 'HUG' &&
              want[i].value !== undefined
                ? { value: want[i].value }
                : {}),
            }
          : track,
      )
    } catch {
      // A read-only getter refuses the assignment. The per-track report below
      // is the answer either way, so there is nothing to say twice here.
    }
  }

  const final = tracksOf(frame, field)
  for (let i = 0; i < n; i += 1) {
    if (!trackHeld(final[i], want[i])) {
      warnings?.push(
        `applyLayout: \`${key}[${i}]\` did not hold — asked for ` +
          `${want[i].type}${want[i].value !== undefined ? ` ${want[i].value}` : ''}, ` +
          `the track reads ${String(final[i]?.type)}. The write was retried as a ` +
          'whole-array assignment and refused again. Figma refused this track on ' +
          'this grid; the reply says so rather than reporting a layout the node ' +
          'does not have.',
      )
    }
  }
}

const droppedMessage = (
  { field, value }: Intent,
  actual: unknown,
): string =>
  `applyLayout: \`${field}\` did not hold — asked for ${String(value)}, ` +
  `the node reads ${String(actual)}. The write was retried once and refused ` +
  'again. Figma refused this value on this node; the reply says so rather ' +
  'than reporting a layout the node does not have.'

/**
 * Apply a (possibly partial) layout to a frame, and prove it landed.
 *
 * `mode` is always set; every other field is set ONLY when present (pure-emit
 * contract mirror). Each written field is read back; a mismatch is rewritten
 * once and then, if it still refuses, named on `warnings` (B58).
 *
 * T7 feature-detect for GRID: a runtime without `gridRowCount` etc. gets no
 * assignment and one capability warning on the optional `warnings` sink.
 */
export const applyLayout = (
  frame: LayoutTarget,
  layout: AppliedLayout,
  warnings?: string[],
): void => {
  // GRID-mode fields (M12). Feature-detect (T7): a runtime that does not expose
  // them gets ONE warning naming the capability, not four dropped-write
  // reports — an absent property is not a refused one.
  if (
    layout.mode === 'GRID' &&
    !('gridRowCount' in frame)
  ) {
    const hasGridKeys =
      layout.rows !== undefined ||
      layout.cols !== undefined ||
      layout.rowGap !== undefined ||
      layout.colGap !== undefined
    if (hasGridKeys && warnings) {
      warnings.push(
        'applyLayout: GRID mode grid fields (gridRowCount/gridColumnCount/gridRowGap/gridColumnGap) are not available in this runtime — keys ignored',
      )
    }
  }

  const intents = intentsOf(frame, layout)
  writeLayout(frame, intents)

  // Read back. Everything that did not take is rewritten ONCE — a transient
  // re-assertion loses a rematch — and then reported if it still refuses.
  const reader = frame as unknown as Record<string, unknown>
  const missed = intents.filter(
    i => !held(reader[i.field], i.value),
  )
  if (missed.length > 0) {
    writeLayout(frame, missed)
    for (const intent of missed) {
      const actual = reader[intent.field]
      if (!held(actual, intent.value)) {
        warnings?.push(droppedMessage(intent, actual))
      }
    }
  }

  // Track sizes LAST (I56): a track list describes tracks that already exist,
  // and the counts that create them are among the intents above. Sizing a row
  // the grid does not have yet would name nothing.
  if (layout.mode !== 'GRID') {
    return
  }
  const wantTracks =
    layout.rowSizes !== undefined ||
    layout.colSizes !== undefined
  if (!wantTracks) {
    return
  }
  if (!('gridRowSizes' in frame)) {
    warnings?.push(
      'applyLayout: GRID track sizing (gridRowSizes/gridColumnSizes) is not available in this runtime — rowSizes/colSizes ignored',
    )
    return
  }
  if (layout.rowSizes !== undefined) {
    applyTracks(
      frame,
      'gridRowSizes',
      'rowSizes',
      layout.rowSizes,
      warnings,
    )
  }
  if (layout.colSizes !== undefined) {
    applyTracks(
      frame,
      'gridColumnSizes',
      'colSizes',
      layout.colSizes,
      warnings,
    )
  }
}
