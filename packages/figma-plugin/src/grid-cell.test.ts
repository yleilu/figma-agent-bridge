import { expect, test } from 'bun:test'

import {
  applyGridCell,
  type GridCell,
  type GridCellTarget,
} from './grid-cell'

// grid-cell.test.ts — the child half of the GRID grammar (I56).
//
// Every setter here THROWS in the real runtime rather than dropping the write:
// an anchor onto an occupied cell, a span that overlaps a neighbour, a span
// that reaches past the last track. So the fake models a real grid — it holds
// an occupancy map and refuses the same three ways — and the applier is
// required to degrade with a named warning rather than take the tree down with
// it. A create_tree that rolled a whole dashboard back over one overlapping
// span would be the wrong trade.
//
// `gridRowAnchorIndex` / `gridColumnAnchorIndex` are READONLY in the Plugin API
// (typings 1.132.0). The only way to move a child is `setGridChildPosition`,
// which is why the fake exposes the anchors as getters and the move as a
// method.

type Occupant = {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

/** A fake GRID parent that refuses overlap and overflow the way Figma does. */
const makeGrid = (rows: number, cols: number) => {
  const children: Occupant[] = []
  const collides = (self: Occupant, next: Occupant) =>
    children.some(
      other =>
        other !== self &&
        next.row < other.row + other.rowSpan &&
        other.row < next.row + next.rowSpan &&
        next.col < other.col + other.colSpan &&
        other.col < next.col + next.colSpan,
    )
  const check = (self: Occupant, next: Occupant) => {
    if (
      next.row + next.rowSpan > rows ||
      next.col + next.colSpan > cols
    ) {
      throw new Error('out of bounds')
    }
    if (collides(self, next)) {
      throw new Error('cell is occupied')
    }
  }
  const parent = {
    layoutMode: 'GRID',
    gridRowCount: rows,
    gridColumnCount: cols,
  }
  const child = (
    row: number,
    col: number,
  ): GridCellTarget => {
    const self: Occupant = {
      row,
      col,
      rowSpan: 1,
      colSpan: 1,
    }
    children.push(self)
    const node = {
      parent,
      gridChildHorizontalAlign: 'AUTO',
      gridChildVerticalAlign: 'AUTO',
      setGridChildPosition(r: number, c: number) {
        check(self, { ...self, row: r, col: c })
        self.row = r
        self.col = c
      },
    }
    Object.defineProperty(node, 'gridRowAnchorIndex', {
      get: () => self.row,
      enumerable: true,
    })
    Object.defineProperty(node, 'gridColumnAnchorIndex', {
      get: () => self.col,
      enumerable: true,
    })
    Object.defineProperty(node, 'gridRowSpan', {
      get: () => self.rowSpan,
      set: (v: number) => {
        check(self, { ...self, rowSpan: v })
        self.rowSpan = v
      },
      enumerable: true,
    })
    Object.defineProperty(node, 'gridColumnSpan', {
      get: () => self.colSpan,
      set: (v: number) => {
        check(self, { ...self, colSpan: v })
        self.colSpan = v
      },
      enumerable: true,
    })
    return node as unknown as GridCellTarget
  }
  return { parent, child }
}

test('a stated span reaches across the tracks it names', () => {
  const grid = makeGrid(3, 3)
  const header = grid.child(0, 0)
  const warnings: string[] = []
  applyGridCell(header, { colSpan: 3 }, warnings)
  expect(header.gridColumnSpan).toBe(3)
  expect(warnings).toEqual([])
})

test('the dashboard shell: a header across the columns, a sidebar down the rows', () => {
  // The capability this item exists for. Children are placed one at a time —
  // the order create_tree builds them in — so each span is set while the cells
  // it wants are still empty.
  const grid = makeGrid(3, 3)
  const warnings: string[] = []

  const header = grid.child(0, 0)
  applyGridCell(
    header,
    { row: 0, col: 0, colSpan: 3 },
    warnings,
  )

  const sidebar = grid.child(1, 0)
  applyGridCell(
    sidebar,
    { row: 1, col: 0, rowSpan: 2 },
    warnings,
  )

  const main = grid.child(1, 1)
  applyGridCell(
    main,
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
    warnings,
  )

  expect(header.gridColumnSpan).toBe(3)
  expect(sidebar.gridRowSpan).toBe(2)
  expect(main.gridRowSpan).toBe(2)
  expect(main.gridColumnSpan).toBe(2)
  expect(warnings).toEqual([])
})

test('an anchor that is already the node’s own is not re-set', () => {
  // setGridChildPosition throws on an occupied cell, and the cell a node is
  // already in is occupied — by that node. Asking for the anchor it holds must
  // therefore be a no-op, not a refusal.
  const grid = makeGrid(2, 2)
  const child = grid.child(0, 0)
  const warnings: string[] = []
  applyGridCell(child, { row: 0, col: 0 }, warnings)
  expect(child.gridRowAnchorIndex).toBe(0)
  expect(warnings).toEqual([])
})

test('a move to an occupied cell is named, and the node keeps the cell it had', () => {
  const grid = makeGrid(2, 2)
  grid.child(1, 1)
  const mover = grid.child(0, 0)
  const warnings: string[] = []
  applyGridCell(mover, { row: 1, col: 1 }, warnings)
  expect(mover.gridRowAnchorIndex).toBe(0)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('cell')
  expect(warnings[0]).toContain('occupied')
})

test('a span that overruns the grid is named, and does not take the build down', () => {
  const grid = makeGrid(2, 2)
  const child = grid.child(0, 0)
  const warnings: string[] = []
  expect(() =>
    applyGridCell(child, { colSpan: 5 }, warnings),
  ).not.toThrow()
  expect(child.gridColumnSpan).toBe(1)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('colSpan')
})

test('one axis refusing does not lose the other', () => {
  const grid = makeGrid(3, 2)
  const child = grid.child(0, 0)
  const warnings: string[] = []
  applyGridCell(child, { rowSpan: 3, colSpan: 9 }, warnings)
  expect(child.gridRowSpan).toBe(3)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('colSpan')
})

test('align lands on both axes', () => {
  const grid = makeGrid(1, 1)
  const child = grid.child(0, 0)
  const warnings: string[] = []
  applyGridCell(
    child,
    { align: ['CENTER', 'MAX'] },
    warnings,
  )
  expect(child.gridChildHorizontalAlign).toBe('CENTER')
  expect(child.gridChildVerticalAlign).toBe('MAX')
  expect(warnings).toEqual([])
})

test('a cell on a child of a non-GRID parent is refused, and says which parent', () => {
  const child = {
    parent: { layoutMode: 'VERTICAL' },
    gridRowSpan: 1,
    gridColumnSpan: 1,
    setGridChildPosition: () => {},
  } as unknown as GridCellTarget
  const warnings: string[] = []
  applyGridCell(child, { colSpan: 2 }, warnings)
  expect(child.gridColumnSpan).toBe(1)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('GRID')
})

test('a runtime with no grid-child API degrades once, naming the capability', () => {
  const child = {
    parent: { layoutMode: 'GRID' },
  } as unknown as GridCellTarget
  const warnings: string[] = []
  expect(() =>
    applyGridCell(
      child,
      { row: 1, col: 1, colSpan: 2, align: ['MIN', 'MIN'] },
      warnings,
    ),
  ).not.toThrow()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toMatch(/gridColumnSpan|grid/i)
})

test('an absent cell writes nothing at all', () => {
  const grid = makeGrid(2, 2)
  const child = grid.child(0, 0)
  const warnings: string[] = []
  applyGridCell(
    child,
    undefined as unknown as GridCell,
    warnings,
  )
  expect(warnings).toEqual([])
  expect(child.gridColumnSpan).toBe(1)
})
