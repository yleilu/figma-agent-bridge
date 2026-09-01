// construction-defaults.test.ts — B86, and the B12/B16/I13 family it belongs
// to.
//
// THE DEDUP FIRST, because the row asked for it. B16 ruled this family NOT A
// DEFECT on 2026-08-06: Figma's create APIs return a painted node, a designer
// drawing the same shape by hand gets the same paint, the defaults round-trip
// stably, and `fills: []` / `strokes: []` clears them. That ruling closed B12
// and I13 with it, and its remedy was the table in `expression-formats.md`.
// This suite does NOT reopen it — nothing here changes what lands.
//
// What it fixes is that the remedy never reached a caller. Four sightings
// across four builds:
//   2026-07-18 Northwind   — I13, the single biggest time sink of the run
//   2026-07-19 Aster       — every block/* and card frame needed `fills: []`
//   2026-08-13 dashboard   — 16 wrapper frames rendered as opaque white slabs
//                            over a dark screen, found by eye in a PNG
//   2026-09-01 dashboard   — B86: a logo VECTOR with no `strokes` key came back
//                            with `strokes:['#000000']`, `stroke:'stroke(1)'`
//                            — a 1px black rim on a gradient mark, invisible on
//                            a black ground and off-palette in every audit
//
// So the declaration moves from the spec to the reply.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  constructionDefaultsWarning,
  unstatedDefaultOf,
} from './construction-defaults'

/** What `figma.createVector()` hands back, per the family's own table. */
const bornVector = {
  type: 'VECTOR',
  strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  fills: [],
}
const bornFrame = {
  type: 'FRAME',
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
  strokes: [],
}

describe('unstatedDefaultOf', () => {
  it('reports the black stroke on a VECTOR that named none', () => {
    expect(
      unstatedDefaultOf(
        {
          type: 'VECTOR',
          name: 'Mark',
          fills: ['linear(135, #7C5CFF@0, #22D3EE@100)'],
          vectorPaths: ['path(NONE,"M 0 0 L 8 8")'],
        },
        bornVector,
      ),
    ).toEqual({ type: 'VECTOR', field: 'strokes' })
  })

  it('says nothing when the spec stated the field', () => {
    expect(
      unstatedDefaultOf(
        { type: 'VECTOR', strokes: [] },
        bornVector,
      ),
    ).toBeUndefined()
    expect(
      unstatedDefaultOf(
        { type: 'VECTOR', strokes: ['#FF0000'] },
        bornVector,
      ),
    ).toBeUndefined()
  })

  it('reports the white fill on a FRAME that named none', () => {
    expect(
      unstatedDefaultOf({ type: 'FRAME' }, bornFrame),
    ).toEqual({ type: 'FRAME', field: 'fills' })
  })

  it('reads the field Figma actually paints for the type', () => {
    // A frame's default is its FILL, so its empty strokes are not news.
    expect(
      unstatedDefaultOf({ type: 'FRAME' }, {
        type: 'FRAME',
        fills: [],
        strokes: [],
      }),
    ).toBeUndefined()
  })

  it('leaves a TEXT node alone when the spec stated its colour', () => {
    // `text:{color}` IS the fill on a TEXT node, and the grammar spells it that
    // way — so reporting it would be noise on the one type where the caller
    // almost always does say.
    expect(
      unstatedDefaultOf(
        {
          type: 'TEXT',
          text: { content: 'Hi', color: '#FFFFFF' },
        },
        { type: 'TEXT', fills: [{ type: 'SOLID' }] },
      ),
    ).toBeUndefined()
    expect(
      unstatedDefaultOf({ type: 'TEXT', text: {} }, {
        type: 'TEXT',
        fills: [{ type: 'SOLID' }],
      }),
    ).toEqual({ type: 'TEXT', field: 'fills' })
  })

  it('has nothing to say about a type Figma does not paint', () => {
    expect(
      unstatedDefaultOf({ type: 'SECTION' }, {
        type: 'SECTION',
        fills: [{ type: 'SOLID' }],
      }),
    ).toBeUndefined()
  })

  it('survives a node that refuses the read', () => {
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'strokes', {
      get() {
        throw new Error('The node does not exist')
      },
    })
    expect(
      unstatedDefaultOf({ type: 'VECTOR' }, hostile),
    ).toBeUndefined()
  })
})

describe('constructionDefaultsWarning', () => {
  it('says nothing when nothing was inherited', () => {
    expect(constructionDefaultsWarning([])).toBeUndefined()
  })

  it('is ONE line for sixteen frames, not sixteen', () => {
    // The 2026-08-13 shape. One line per node would be the noise I41 is filed
    // about, and the count is the news.
    const many = Array.from({ length: 16 }, () => ({
      type: 'FRAME' as const,
      field: 'fills' as const,
    }))
    const message = constructionDefaultsWarning(
      many,
    ) as string
    expect(message).toContain('16 node(s)')
    expect(message).toContain('FRAME fills ×16')
    expect(message).toContain('`fills: []`')
    expect(message.split('\n')).toHaveLength(1)
  })

  it('counts each type and field separately, commonest first', () => {
    const message = constructionDefaultsWarning([
      { type: 'VECTOR', field: 'strokes' },
      { type: 'FRAME', field: 'fills' },
      { type: 'FRAME', field: 'fills' },
    ]) as string
    expect(message).toContain('FRAME fills ×2')
    expect(message).toContain('VECTOR strokes ×1')
    expect(message.indexOf('FRAME')).toBeLessThan(
      message.indexOf('VECTOR'),
    )
  })
})

// `code.ts` cannot be imported outside Figma (it calls `figma.showUI` at module
// scope), so the wiring is asserted by source scan — the house pattern.
describe('create-path wiring', () => {
  const source =
    // eslint-disable-next-line n/no-sync -- test-only source scan
    readFileSync(join(import.meta.dir, 'code.ts'), 'utf8')

  it('reads the default BEFORE the spec is applied', () => {
    const read = source.indexOf('unstatedDefaultOf(')
    const apply = source.indexOf(
      'await applyCommonProperties(node, spec, parent',
    )
    expect(read).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(-1)
    // Order is the whole measurement: one line later the node wears the
    // caller's paint and there is nothing left to report.
    expect(read).toBeLessThan(apply)
  })

  it('says it on BOTH create doors', () => {
    const nodeCase = source.slice(
      source.indexOf('case COMMANDS.CREATE_NODE'),
      source.indexOf('case COMMANDS.CREATE_TREE'),
    )
    const treeCase = source.slice(
      source.indexOf('case COMMANDS.CREATE_TREE'),
    )
    expect(nodeCase).toContain(
      'constructionDefaultsWarning(',
    )
    expect(treeCase.slice(0, 8000)).toContain(
      'constructionDefaultsWarning(',
    )
  })
})
