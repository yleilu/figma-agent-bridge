// grid-cell.ts — the child half of the GRID grammar (I56).
//
// `layout` is what a node does to its children; `cell` is what its parent's
// grid does to it. A header that spans every column and a sidebar that spans
// the remaining rows is the whole reason to reach for grid instead of wrap, and
// until this module existed the grammar stopped at uniform tracks: every child
// took exactly one cell.
//
// FOUR THINGS ABOUT THE FIGMA API SHAPE THIS FILE (Plugin API typings 1.132.0):
//
//   1. `gridRowAnchorIndex` / `gridColumnAnchorIndex` are READ-ONLY. The only
//      way to move a child is `setGridChildPosition(row, col)`. So the grammar
//      spells one concept — `cell.row` / `cell.col` — and this module knows
//      which side of the API each direction lands on.
//   2. Every setter THROWS rather than dropping the write: an anchor onto an
//      occupied cell, a span that overlaps a neighbour, a span that reaches
//      past the last track. A throw here would roll a whole create_tree back,
//      so each write is caught and NAMED instead (T7). One overlapping span is
//      not worth a dashboard.
//   3. `setGridChildPosition` also throws when the parent grid is in
//      `ROW_AUTO_FLOW`, where Figma owns the placement. Same treatment: the
//      refusal is reported in Figma's own words rather than guessed at.
//   4. `GridChildrenMixin` sits on `LayoutMixin`, so EVERY scene node answers
//      `gridRowSpan`. The property probe therefore proves nothing about
//      whether this node is in a grid — only the PARENT does, which is why the
//      parent's `layoutMode` is checked first and separately.
//
// ORDER: anchor, then spans, then align. The anchor moves while the node is
// still one cell wide, which is when the fewest neighbours are in the way; a
// span applied first would have to clear the cells the node is about to leave.

/** The exact cell shape the server's `convertCell` emits. */
export type GridCell = {
  row?: number
  col?: number
  rowSpan?: number
  colSpan?: number
  align?: [string, string]
}

/** Structural subset of a grid child this module reads and writes. */
export type GridCellTarget = {
  parent?: unknown
  readonly gridRowAnchorIndex?: number
  readonly gridColumnAnchorIndex?: number
  gridRowSpan?: number
  gridColumnSpan?: number
  gridChildHorizontalAlign?: string
  gridChildVerticalAlign?: string
  setGridChildPosition?: (row: number, col: number) => void
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Whether this node's parent lays its children out as a GRID. */
const inGrid = (node: GridCellTarget): boolean => {
  const parent = node.parent as
    | { layoutMode?: unknown }
    | null
    | undefined
  return (
    typeof parent === 'object' &&
    parent !== null &&
    parent.layoutMode === 'GRID'
  )
}

/**
 * Move the node to the cell the spec names.
 *
 * A cell the node ALREADY occupies is left alone. `setGridChildPosition` throws
 * on an occupied cell, and the cell a node sits in is occupied — by that node —
 * so re-stating the anchor a read just handed back would refuse a write that
 * asks for nothing. That is exactly the read-modify-write shape (T2), so it has
 * to be the quiet case.
 */
const applyAnchor = (
  node: GridCellTarget,
  cell: GridCell,
  warnings?: string[],
): void => {
  if (cell.row === undefined && cell.col === undefined) {
    return
  }
  const move = node.setGridChildPosition
  if (typeof move !== 'function') {
    return
  }
  const row = cell.row ?? node.gridRowAnchorIndex ?? 0
  const col = cell.col ?? node.gridColumnAnchorIndex ?? 0
  if (
    row === node.gridRowAnchorIndex &&
    col === node.gridColumnAnchorIndex
  ) {
    return
  }
  try {
    move.call(node, row, col)
  } catch (err) {
    warnings?.push(
      `applyGridCell: the cell [row ${row}, col ${col}] would not take this ` +
        `node — ${messageOf(err)}. It stays at [row ` +
        `${String(node.gridRowAnchorIndex)}, col ` +
        `${String(node.gridColumnAnchorIndex)}]. A cell is occupied by at most ` +
        'one node: give the neighbour a smaller span, or place this one ' +
        'somewhere the grid has room.',
    )
  }
}

/** Set one span, and say so when Figma refuses it. */
const applySpan = (
  node: GridCellTarget,
  field: 'gridRowSpan' | 'gridColumnSpan',
  key: 'rowSpan' | 'colSpan',
  want: number,
  warnings?: string[],
): void => {
  const target = node as unknown as Record<string, unknown>
  try {
    target[field] = want
  } catch (err) {
    warnings?.push(
      `applyGridCell: \`${key}: ${want}\` was refused — ${messageOf(err)}. The ` +
        `node still spans ${String(target[field])}. A span may not overlap ` +
        'another node or reach past the last track: raise the grid’s ' +
        '`rows`/`cols`, or move whatever is in the way.',
    )
    return
  }
  if (target[field] !== want) {
    warnings?.push(
      `applyGridCell: \`${key}\` did not hold — asked for ${want}, the node ` +
        `reads ${String(target[field])}.`,
    )
  }
}

/** Set one cell alignment, and say so when the node cannot carry it. */
const applyAlign = (
  node: GridCellTarget,
  field:
    | 'gridChildHorizontalAlign'
    | 'gridChildVerticalAlign',
  want: string,
  warnings?: string[],
): void => {
  const target = node as unknown as Record<string, unknown>
  try {
    target[field] = want
  } catch (err) {
    warnings?.push(
      `applyGridCell: \`${field}: ${want}\` was refused — ${messageOf(err)}.`,
    )
  }
}

/**
 * Place a node in its parent's grid.
 *
 * Nothing is written when the spec names no cell, when the parent is not a
 * GRID, or when the runtime has no grid-child API — and the last two SAY so
 * (T7), because a cell that quietly did nothing is indistinguishable from a
 * cell that landed, and the difference is the whole layout.
 */
export const applyGridCell = (
  node: GridCellTarget,
  cell: GridCell | undefined,
  warnings?: string[],
): void => {
  if (
    cell === undefined ||
    Object.keys(cell).length === 0
  ) {
    return
  }
  if (!inGrid(node)) {
    const parent = node.parent as
      | { layoutMode?: unknown; type?: unknown }
      | null
      | undefined
    warnings?.push(
      'applyGridCell: `cell` places a node in its parent’s GRID, and this ' +
        `node’s parent lays out as ${String(parent?.layoutMode ?? 'nothing')}` +
        ' — the cell was ignored. Set `layout:{mode:"GRID"}` on the parent, ' +
        'or drop `cell`.',
    )
    return
  }
  // ONE probe for the whole capability. `gridColumnSpan` and
  // `setGridChildPosition` arrived together, and four separate degrade notes
  // for one missing API would bury the fact that it is one API.
  if (
    !('gridColumnSpan' in node) ||
    typeof node.setGridChildPosition !== 'function'
  ) {
    warnings?.push(
      'applyGridCell: grid child placement (gridRowSpan/gridColumnSpan/' +
        'setGridChildPosition) is not available in this runtime — `cell` ignored',
    )
    return
  }

  applyAnchor(node, cell, warnings)
  if (cell.rowSpan !== undefined) {
    applySpan(
      node,
      'gridRowSpan',
      'rowSpan',
      cell.rowSpan,
      warnings,
    )
  }
  if (cell.colSpan !== undefined) {
    applySpan(
      node,
      'gridColumnSpan',
      'colSpan',
      cell.colSpan,
      warnings,
    )
  }
  if (cell.align !== undefined) {
    applyAlign(
      node,
      'gridChildHorizontalAlign',
      cell.align[0],
      warnings,
    )
    applyAlign(
      node,
      'gridChildVerticalAlign',
      cell.align[1],
      warnings,
    )
  }
}
