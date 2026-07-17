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

/**
 * Apply a (possibly partial) layout to a frame.
 *
 * `mode` is always set: 'NONE' disables auto-layout (it is NOT 'V'); 'H'/'V'
 * map to HORIZONTAL/VERTICAL; 'GRID' maps to GRID.
 * Every other field is set ONLY when present (pure-emit contract mirror).
 *
 * T7 feature-detect for GRID: each grid field is guarded with `'field' in frame`.
 * On a runtime that does not expose gridRowCount etc., the assign is skipped and
 * a warning is pushed onto the optional `warnings` sink (never throw).
 */
export const applyLayout = (
  frame: LayoutTarget,
  layout: AppliedLayout,
  warnings?: string[],
): void => {
  frame.layoutMode =
    layout.mode === 'NONE'
      ? 'NONE'
      : layout.mode === 'H'
        ? 'HORIZONTAL'
        : layout.mode === 'GRID'
          ? 'GRID'
          : 'VERTICAL'

  if (layout.spacing !== undefined) {
    frame.itemSpacing = layout.spacing
  }

  if (layout.padding !== undefined) {
    frame.paddingTop = layout.padding[0]
    frame.paddingRight = layout.padding[1]
    frame.paddingBottom = layout.padding[2]
    frame.paddingLeft = layout.padding[3]
  }

  if (layout.align !== undefined) {
    frame.primaryAxisAlignItems = layout.align[0] as
      | 'MIN'
      | 'MAX'
      | 'CENTER'
      | 'SPACE_BETWEEN'
    frame.counterAxisAlignItems = layout.align[1] as
      | 'MIN'
      | 'MAX'
      | 'CENTER'
      | 'BASELINE'
  }

  if (layout.wrap) {
    frame.layoutWrap = 'WRAP'
  }

  // GRID-mode fields (M12). Feature-detect each property (T7): the runtime
  // may not expose gridRowCount etc. on older Plugin API versions. If none
  // of the grid properties exist on the frame and the caller supplied grid
  // keys, push a warning onto the sink (never throw).
  if (layout.mode === 'GRID') {
    const gridSupported = 'gridRowCount' in frame
    if (!gridSupported) {
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
    } else {
      if (layout.rows !== undefined && 'gridRowCount' in frame) {
        frame.gridRowCount = layout.rows
      }
      if (
        layout.cols !== undefined &&
        'gridColumnCount' in frame
      ) {
        frame.gridColumnCount = layout.cols
      }
      if (layout.rowGap !== undefined && 'gridRowGap' in frame) {
        frame.gridRowGap = layout.rowGap
      }
      if (
        layout.colGap !== undefined &&
        'gridColumnGap' in frame
      ) {
        frame.gridColumnGap = layout.colGap
      }
    }
  }
}
