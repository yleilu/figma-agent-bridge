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

export type FigmaLayoutGrid = {
  pattern: 'COLUMNS' | 'ROWS' | 'GRID'
  alignment?: 'MIN' | 'MAX' | 'CENTER' | 'STRETCH'
  /** number, or 'auto' for an auto count. */
  count?: number | 'auto'
  sectionSize?: number
  gutterSize?: number
  offset?: number
  color?: RGBA
  visible?: boolean
}

const scalar = (
  a: AtomArg | undefined,
): string | number | boolean | undefined =>
  a !== undefined && a.kind === 'scalar'
    ? a.value
    : undefined

const applyGridAttrs = (
  out: FigmaLayoutGrid,
  attrs: Attrs | undefined,
): void => {
  if (attrs === undefined) {
    return
  }
  if (typeof attrs.align === 'string') {
    out.alignment =
      attrs.align as FigmaLayoutGrid['alignment']
  }
  if (typeof attrs.offset === 'number') {
    out.offset = attrs.offset
  }
  if (typeof attrs.color === 'string') {
    out.color = hexToRgba(attrs.color)
  }
  if (attrs.vis === false) {
    out.visible = false
  }
}

const gridToAst = (g: FigmaLayoutGrid): AtomAST => {
  const attrs: Attrs = {}
  if (g.alignment !== undefined) {
    attrs.align = g.alignment
  }
  if (g.offset !== undefined) {
    attrs.offset = g.offset
  }
  if (g.color !== undefined) {
    attrs.color = rgbaToHex(g.color)
  }
  if (g.visible === false) {
    attrs.vis = false
  }
  const wrap =
    Object.keys(attrs).length > 0 ? { attrs } : {}
  if (g.pattern === 'GRID') {
    return {
      kind: 'head',
      head: 'grid',
      args: [{ kind: 'scalar', value: g.sectionSize ?? 0 }],
      ...wrap,
    }
  }
  const head = g.pattern === 'COLUMNS' ? 'columns' : 'rows'
  const args: AtomArg[] = [
    { kind: 'scalar', value: g.count ?? 'auto' },
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
    const out: FigmaLayoutGrid = { pattern: 'GRID' }
    const size = scalar(args[0])
    if (typeof size === 'number') {
      out.sectionSize = size
    }
    applyGridAttrs(out, attrs)
    return out
  }
  if (head !== 'columns' && head !== 'rows') {
    throw new Error(`atomToGrid: unknown grid "${head}"`)
  }
  const out: FigmaLayoutGrid = {
    pattern: head === 'columns' ? 'COLUMNS' : 'ROWS',
  }
  const c = scalar(args[0])
  if (c === 'auto') {
    out.count = 'auto'
  } else if (typeof c === 'number') {
    out.count = c
  }
  const sec = scalar(args[1])
  if (typeof sec === 'number') {
    out.sectionSize = sec
  }
  const gut = scalar(args[2])
  if (gut === 'auto') {
    // gutter 'auto' is left implicit
  } else if (typeof gut === 'number') {
    out.gutterSize = gut
  }
  applyGridAttrs(out, attrs)
  return out
}

export const gridToAtom = (g: FigmaLayoutGrid): string =>
  renderAtom(gridToAst(g))
