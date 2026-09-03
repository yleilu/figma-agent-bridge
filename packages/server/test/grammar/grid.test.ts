// grid.test.ts — the layout-grid head converter (atomToGrid / gridToAtom).
//
// atomToGrid must emit a COMPLETE Figma LayoutGrid: COLUMNS/ROWS REQUIRE
// pattern + alignment + count + gutterSize + sectionSize; GRID REQUIRES
// pattern + sectionSize. Omitting any of these is the A2 bug Figma rejected at
// runtime (create_styles grid + node grids). The shape guard below catches the
// drift at the converter (the source). The auto count rides the wire as the
// STRING 'auto' (JSON has no Infinity); the plugin maps 'auto' ↔ Infinity.

import { describe, expect, it } from 'bun:test'
import {
  atomToGrid,
  gridToAtom,
} from '@figma-agent-bridge/server/grammar'
import type { FigmaLayoutGrid } from '@figma-agent-bridge/server/grammar'

// --- shape: atomToGrid emits the Figma-required fields ---
describe('grid: atomToGrid emits Figma-required fields', () => {
  it('columns(12,80,20) STRETCH carries required fields + offset, no sectionSize', () => {
    const g = atomToGrid('columns(12,80,20)')
    expect(g).toEqual({
      pattern: 'COLUMNS',
      alignment: 'STRETCH',
      count: 12,
      gutterSize: 20,
      offset: 0,
    })
  })

  it('rows(...) yields pattern ROWS with the same required fields', () => {
    const g = atomToGrid('rows(6,40,8)')
    expect(g).toEqual({
      pattern: 'ROWS',
      alignment: 'STRETCH',
      count: 6,
      gutterSize: 8,
      offset: 0,
    })
  })

  it('non-STRETCH carries sectionSize; STRETCH omits it', () => {
    const min = atomToGrid(
      'columns(4,40,8){align=MIN}',
    ) as Extract<FigmaLayoutGrid, { pattern: 'COLUMNS' }>
    expect(min.sectionSize).toBe(40)
    expect(min.offset).toBe(0)
    const stretch = atomToGrid(
      'columns(4,40,8)',
    ) as Extract<FigmaLayoutGrid, { pattern: 'COLUMNS' }>
    expect(stretch.sectionSize).toBeUndefined()
  })

  it('columns(auto,...) keeps count as the STRING auto', () => {
    const g = atomToGrid('columns(auto,60,16)') as Extract<
      FigmaLayoutGrid,
      { pattern: 'COLUMNS' }
    >
    expect(g.count).toBe('auto')
    expect(g.alignment).toBe('STRETCH')
    expect(g.gutterSize).toBe(16)
    expect(g.offset).toBe(0)
    expect(g.sectionSize).toBeUndefined()
  })

  it('grid(8) → {pattern:GRID, sectionSize:8}', () => {
    const g = atomToGrid('grid(8)')
    expect(g).toEqual({ pattern: 'GRID', sectionSize: 8 })
  })

  it('grid() with no size defaults sectionSize to 0 (required)', () => {
    const g = atomToGrid('grid()')
    expect(g).toEqual({ pattern: 'GRID', sectionSize: 0 })
  })

  it('explicit {align=} overrides the STRETCH default', () => {
    const g = atomToGrid(
      'columns(12,80,20){align=CENTER}',
    ) as Extract<FigmaLayoutGrid, { pattern: 'COLUMNS' }>
    expect(g.alignment).toBe('CENTER')
  })
})

// --- round-trip: atomToGrid(gridToAtom(g)) is an identity (T4) ---
describe('grid: atomToGrid(gridToAtom(g)) deep-equals g', () => {
  const cases: { name: string; g: FigmaLayoutGrid }[] = [
    {
      name: 'columns (defaulted STRETCH)',
      g: {
        pattern: 'COLUMNS',
        alignment: 'STRETCH',
        count: 12,
        gutterSize: 20,
        offset: 0,
      },
    },
    {
      name: 'columns with explicit alignment + offset',
      g: {
        pattern: 'COLUMNS',
        alignment: 'CENTER',
        count: 12,
        gutterSize: 16,
        sectionSize: 60,
        offset: 24,
      },
    },
    {
      name: 'columns with auto count',
      g: {
        pattern: 'ROWS',
        alignment: 'STRETCH',
        count: 'auto',
        gutterSize: 8,
        offset: 0,
      },
    },
    {
      name: 'grid',
      g: { pattern: 'GRID', sectionSize: 8 },
    },
  ]
  for (const { name, g } of cases) {
    it(name, () => {
      expect(atomToGrid(gridToAtom(g))).toEqual(g)
    })
  }

  it('a defaulted STRETCH does NOT leak into the atom', () => {
    const g: FigmaLayoutGrid = {
      pattern: 'COLUMNS',
      alignment: 'STRETCH',
      count: 12,
      gutterSize: 20,
      sectionSize: 80,
    }
    // STRETCH is the default; gridToAtom must not re-emit it as {align=}.
    expect(gridToAtom(g)).not.toContain('align')
    expect(gridToAtom(g)).toBe('columns(12,80,20)')
  })

  it('a non-default alignment IS emitted into the atom', () => {
    const g: FigmaLayoutGrid = {
      pattern: 'COLUMNS',
      alignment: 'MIN',
      count: 12,
      gutterSize: 20,
      sectionSize: 80,
    }
    expect(gridToAtom(g)).toContain('align=MIN')
  })
})

// --- read-side: Figma's raw auto-count maps back to the STRING auto ---
describe('grid: gridToAtom maps Figma auto count → auto', () => {
  // Live-verified: creating columns(auto,60,20){align=MIN} and reading it
  // back off the real plugin yields raw layoutGrids count -1, NOT Infinity
  // — JSON can't carry Infinity over the wire, so Figma never actually sends
  // it. -1 is the value this must handle; Infinity is exercised separately
  // below as a harmless superset, not the live contract.
  it('-1 count (the value Figma actually sends) renders as the string auto', () => {
    const g = {
      pattern: 'COLUMNS',
      alignment: 'STRETCH',
      count: -1,
      gutterSize: 8,
      sectionSize: 40,
    } as unknown as FigmaLayoutGrid
    expect(gridToAtom(g)).toBe('columns(auto,40,8)')
  })

  it('Infinity count also renders as the string auto (harmless superset)', () => {
    const g = {
      pattern: 'COLUMNS',
      alignment: 'STRETCH',
      count: Infinity,
      gutterSize: 8,
      sectionSize: 40,
    } as unknown as FigmaLayoutGrid
    expect(gridToAtom(g)).toBe('columns(auto,40,8)')
  })
})
