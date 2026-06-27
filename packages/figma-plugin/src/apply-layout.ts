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
  mode: 'H' | 'V' | 'NONE'
  spacing?: number
  padding?: [number, number, number, number]
  align?: [string, string]
  wrap?: boolean
}

/** Structural subset of FrameNode this applier writes to. */
export type LayoutTarget = {
  // Widened to match figma's FrameNode.layoutMode (which includes 'GRID') so
  // a real FrameNode is structurally assignable here; we only ever WRITE
  // 'NONE'/'HORIZONTAL'/'VERTICAL'.
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
}

/**
 * Apply a (possibly partial) layout to a frame.
 *
 * `mode` is always set: 'NONE' disables auto-layout (it is NOT 'V'); 'H'/'V'
 * map to HORIZONTAL/VERTICAL. Every other field is set ONLY when present.
 */
export const applyLayout = (
  frame: LayoutTarget,
  layout: AppliedLayout,
): void => {
  frame.layoutMode =
    layout.mode === 'NONE'
      ? 'NONE'
      : layout.mode === 'H'
        ? 'HORIZONTAL'
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
}
