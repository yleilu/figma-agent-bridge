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
// THE WRITE PROVES ITSELF (B58). Setting a Figma property is not the same as
// the property holding the value. Proven live: a REAL UI selection on the
// target at write time makes the align write silently drop — `ok`, `warnings:
// []`, read-back unchanged, geometry unchanged. Deselect and the identical
// write lands, every time. Seven agent-only variants had passed, an API
// `set_selection` on the target included, so the trigger is the UI selection
// specifically; Figma's properties panel re-asserting what it displays is the
// suspected mechanism.
//
// So every field this module writes is READ BACK. A mismatch is written once
// more — a transient re-assertion loses a race, not a rematch — and a field
// that still refuses is NAMED in `warnings`, with what was asked and what is
// actually there. What this module must never do is what it used to do: report
// nothing while the layout the caller stated is not the layout on the node.
//
// This module declares the FrameNode surface it touches structurally (the
// figma `FrameNode` is structurally assignable to it) so it stays free of the
// figma runtime and is independently unit-testable with a plain fake node.

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
  const out: Intent[] = [
    {
      field: 'layoutMode',
      value: layoutModeOf(layout.mode),
    },
  ]
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
      if (value !== undefined && field in frame) {
        out.push({ field, value })
      }
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

const droppedMessage = (
  { field, value }: Intent,
  actual: unknown,
): string =>
  `applyLayout: \`${field}\` did not hold — asked for ${String(value)}, ` +
  `the node reads ${String(actual)}. The write was retried once and refused ` +
  'again. A node SELECTED in the Figma UI is the known cause: the properties ' +
  'panel re-asserts what it displays. Deselect the node and repeat the call.'

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
  if (missed.length === 0) {
    return
  }
  writeLayout(frame, missed)
  for (const intent of missed) {
    const actual = reader[intent.field]
    if (!held(actual, intent.value)) {
      warnings?.push(droppedMessage(intent, actual))
    }
  }
}
