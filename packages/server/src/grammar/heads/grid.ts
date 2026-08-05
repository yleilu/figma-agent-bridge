// grammar/heads/grid.ts — the layout-grid head (columns()/rows()/grid()).
//
// columns(count, sectionSize, gutterSize){align=, offset=, color=}
// rows(...) likewise; grid(size) is the square-cell form. The generic
// parse-atom/render-atom already round-trip the STRING; this module maps
// the atom <-> a Figma LayoutGrid object.

import type { AtomAST, AtomArg, Attrs } from '../types'
import { parseAtom } from '../parse-atom'
import { renderAtom } from '../render-atom'
import { hexToRgba, rgbaToHex } from '../figma-paint'
import type { RGBA } from '../figma-paint'

type GridAlignment = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH'

/**
 * The square-cell pattern. Figma's GridLayoutGrid REQUIRES pattern + sectionSize.
 */
type FigmaGridLayoutGrid = {
  pattern: 'GRID'
  /** REQUIRED by Figma. */
  sectionSize: number
  visible?: boolean
  color?: RGBA
}

/**
 * The columns/rows pattern. Figma's RowsColsLayoutGrid REQUIRES pattern +
 * alignment + gutterSize + count + offset. `sectionSize` is required for
 * non-STRETCH alignments but is REJECTED under STRETCH (Figma's set_layoutGrids
 * validation: STRETCH variant disallows sectionSize, all variants require
 * offset), so it is emitted only when alignment !== STRETCH.
 * `count` is a number on the wire, or the STRING 'auto' for an auto count
 * (JSON can't carry Infinity over the WS transport; the plugin translates
 * 'auto' → Infinity before assigning to Figma).
 */
type FigmaRowsColsLayoutGrid = {
  pattern: 'COLUMNS' | 'ROWS'
  /** REQUIRED by Figma. */
  alignment: GridAlignment
  /** REQUIRED by Figma. number, or 'auto' for an auto count. */
  count: number | 'auto'
  /** REQUIRED by Figma. */
  gutterSize: number
  /** REQUIRED by Figma (always sent — STRETCH still requires it). */
  offset: number
  /** Required for non-STRETCH; OMITTED under STRETCH (Figma rejects it there). */
  sectionSize?: number
  color?: RGBA
  visible?: boolean
}

export type FigmaLayoutGrid =
  | FigmaGridLayoutGrid
  | FigmaRowsColsLayoutGrid

const scalar = (
  a: AtomArg | undefined,
): string | number | boolean | undefined =>
  a !== undefined && a.kind === 'scalar'
    ? a.value
    : undefined

// Apply the shared attrs (color/vis) that both patterns carry.
const applySharedAttrs = (
  out: FigmaLayoutGrid,
  attrs: Attrs | undefined,
): void => {
  if (attrs === undefined) {
    return
  }
  if (typeof attrs.color === 'string') {
    out.color = hexToRgba(attrs.color)
  }
  if (attrs.vis === false) {
    out.visible = false
  }
}

// Apply the columns/rows-only attrs (align/offset) on top of the shared ones.
// `out.alignment` is pre-seeded to STRETCH by the caller, so an explicit
// {align=} here overrides the default.
const applyRowsColsAttrs = (
  out: FigmaRowsColsLayoutGrid,
  attrs: Attrs | undefined,
): void => {
  applySharedAttrs(out, attrs)
  if (attrs === undefined) {
    return
  }
  if (typeof attrs.align === 'string') {
    out.alignment = attrs.align as GridAlignment
  }
  if (typeof attrs.offset === 'number') {
    out.offset = attrs.offset
  }
}

const gridToAst = (g: FigmaLayoutGrid): AtomAST => {
  const attrs: Attrs = {}
  if (g.color !== undefined) {
    attrs.color = rgbaToHex(g.color)
  }
  if (g.visible === false) {
    attrs.vis = false
  }
  if (g.pattern === 'GRID') {
    const wrap =
      Object.keys(attrs).length > 0 ? { attrs } : {}
    return {
      kind: 'head',
      head: 'grid',
      args: [{ kind: 'scalar', value: g.sectionSize ?? 0 }],
      ...wrap,
    }
  }
  // Columns/rows-only attrs. Skip the defaulted STRETCH so a freshly-defaulted
  // alignment never leaks back into the atom (T4 round-trip identity); an
  // explicit non-STRETCH alignment is still emitted.
  if (
    g.alignment !== undefined &&
    g.alignment !== 'STRETCH'
  ) {
    attrs.align = g.alignment
  }
  if (g.offset !== undefined && g.offset !== 0) {
    attrs.offset = g.offset
  }
  const wrap =
    Object.keys(attrs).length > 0 ? { attrs } : {}
  const head = g.pattern === 'COLUMNS' ? 'columns' : 'rows'
  // 'auto' on the wire. The live plugin's raw layoutGrids export surfaces an
  // auto count as -1 (confirmed live — JSON can't carry Infinity anyway, so
  // Figma never actually sends it over the wire); keep the Infinity check too
  // since it is a harmless superset and symmetric with the plugin's
  // 'auto' → Infinity on assign.
  const count =
    g.count === Infinity || g.count === -1
      ? 'auto'
      : (g.count ?? 'auto')
  const args: AtomArg[] = [
    { kind: 'scalar', value: count },
    { kind: 'scalar', value: g.sectionSize ?? 0 },
    { kind: 'scalar', value: g.gutterSize ?? 'auto' },
  ]
  return { kind: 'head', head, args, ...wrap }
}

export const atomToGrid = (s: string): FigmaLayoutGrid => {
  const ast = parseAtom(s)
  if (ast.kind !== 'head') {
    throw new Error('atomToGrid: not a grid atom')
  }
  const { head, args, attrs } = ast
  if (head === 'grid') {
    // GRID REQUIRES sectionSize; default to 0 when absent.
    const size = scalar(args[0])
    const out: FigmaGridLayoutGrid = {
      pattern: 'GRID',
      sectionSize: typeof size === 'number' ? size : 0,
    }
    applySharedAttrs(out, attrs)
    return out
  }
  if (head !== 'columns' && head !== 'rows') {
    throw new Error(`atomToGrid: unknown grid "${head}"`)
  }
  // COLUMNS/ROWS REQUIRE alignment + count + gutterSize + sectionSize.
  // Seed the required fields with Figma-valid defaults; an explicit {align=}
  // overrides the STRETCH default in applyRowsColsAttrs below. The 'auto'
  // count stays as the STRING on the wire (plugin maps it → Infinity).
  const c = scalar(args[0])
  const sec = scalar(args[1])
  const gut = scalar(args[2])
  const out: FigmaRowsColsLayoutGrid = {
    pattern: head === 'columns' ? 'COLUMNS' : 'ROWS',
    alignment: 'STRETCH',
    count:
      c === 'auto'
        ? 'auto'
        : typeof c === 'number'
          ? c
          : 'auto',
    gutterSize: typeof gut === 'number' ? gut : 0,
    offset: 0,
  }
  applyRowsColsAttrs(out, attrs)
  // sectionSize is required for non-STRETCH alignments but REJECTED under
  // STRETCH (Figma's set_layoutGrids) — add it only when the final alignment
  // (after an explicit {align=} override) isn't STRETCH.
  if (out.alignment !== 'STRETCH') {
    out.sectionSize = typeof sec === 'number' ? sec : 0
  }
  return out
}

export const gridToAtom = (g: FigmaLayoutGrid): string =>
  renderAtom(gridToAst(g))
