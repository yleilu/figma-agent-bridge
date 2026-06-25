// serialize/value-convert.ts — pure grammar WRITE-face converters for the
// design-system authoring tools (create_styles / update_styles /
// create_variables / update_variables).
//
// These were extracted verbatim from tools/design-system-authoring.ts so that
// BOTH the individual tool handlers AND the generic `batch` tool can convert an
// op's params server-side with identical semantics (T8: one grammar, the write
// face — the server parses atoms to Figma objects before the plugin assigns).
// Each function is PURE and throws on a malformed atom; the caller catches and
// reports the error (never a throw out of a handler).

import {
  atomToPaint,
  atomToFont,
  atomToEffect,
  hexToRgba,
  atomToGrid,
} from '../grammar'

// Single source for the hex→RGBA write-face converter used by the DS authoring
// tools AND the generic batch tool: re-export it here so neither imports it
// directly from `../grammar` (M3-D Minor 1). Both already depend on this module
// for the other value converters.
export { hexToRgba }

export type StyleCategory =
  | 'paint'
  | 'text'
  | 'effect'
  | 'grid'

/** 6- or 8-char hex (no shorthand) — the grammar's color form. */
export const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/**
 * Convert a style VALUE atom to its Figma object for a KNOWN category. paint →
 * Paint, text → FontName, effect → Effect, grid → LayoutGrid. Throws on a
 * malformed atom.
 */
export const styleValueToFigma = (
  category: StyleCategory,
  value: string,
): unknown => {
  switch (category) {
    case 'paint':
      return atomToPaint(value)
    case 'text':
      return atomToFont(value)
    case 'effect':
      return atomToEffect(value)
    case 'grid':
      return atomToGrid(value)
    default:
      throw new Error(`Unknown style category: ${category}`)
  }
}

/**
 * Infer the style category from an atom's syntactic shape. update_styles does
 * not carry a `type` (the style id determines it), so the server infers the
 * category from the head/literal: font(...) → text; shadow/inner-shadow/blur/
 * bg-blur → effect; columns/rows/grid → grid; anything else → paint.
 */
export const inferStyleCategory = (
  value: string,
): StyleCategory => {
  const head = value.trim().match(/^([A-Za-z-]+)\s*\(/)
  const kind = head?.[1]?.toLowerCase()
  if (kind === 'font') {
    return 'text'
  }
  if (
    kind === 'shadow' ||
    kind === 'inner-shadow' ||
    kind === 'blur' ||
    kind === 'bg-blur'
  ) {
    return 'effect'
  }
  if (
    kind === 'columns' ||
    kind === 'rows' ||
    kind === 'grid'
  ) {
    return 'grid'
  }
  return 'paint'
}

/**
 * Parse a COLOR variable value (a hex atom) to {r,g,b,a}. Validates the hex
 * shape first so a malformed atom throws a clear error (never a NaN color).
 */
export const colorValueToRgba = (val: unknown): unknown => {
  const s = String(val)
  if (!HEX_RE.test(s)) {
    throw new Error(
      `COLOR variable value must be a 6/8-char hex (e.g. "#3B82F6"); got "${s}"`,
    )
  }
  return hexToRgba(s)
}
