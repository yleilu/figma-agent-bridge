import { describe, expect, it } from 'bun:test'
import {
  MAX_RUNS,
  fontsToLoad,
  runsToRangeOps,
  segmentsToRuns,
} from './text-runs'

// The shape the SERVER delivers — already parsed out of the atom form and with
// lh/ls lifted off the font object (node-spec-writer.ts convertFontInto).
const bold = {
  at: [0, 5],
  font: { family: 'Inter', style: 'Bold', size: 16 },
}
const regular = {
  at: [5, 11],
  font: { family: 'Inter', style: 'Regular', size: 12 },
}

describe('runsToRangeOps', () => {
  it('maps a run to its [start,end] and its font', () => {
    const { ops, skipped } = runsToRangeOps(
      [bold, regular],
      11,
    )
    expect(skipped).toEqual([])
    expect(ops).toEqual([
      {
        start: 0,
        end: 5,
        fontName: { family: 'Inter', style: 'Bold' },
        fontSize: 16,
      },
      {
        start: 5,
        end: 11,
        fontName: { family: 'Inter', style: 'Regular' },
        fontSize: 12,
      },
    ])
  })

  it('carries lineHeight, letterSpacing and colour', () => {
    const { ops } = runsToRangeOps(
      [
        {
          at: [0, 3],
          lineHeight: { value: 24, unit: 'PIXELS' },
          letterSpacing: { value: 0.5, unit: 'PIXELS' },
          color: {
            type: 'SOLID',
            color: { r: 1, g: 0, b: 0 },
          },
        },
      ],
      3,
    )
    expect(ops[0]).toEqual({
      start: 0,
      end: 3,
      lineHeight: { unit: 'PIXELS', value: 24 },
      letterSpacing: { unit: 'PIXELS', value: 0.5 },
      fills: [
        { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
      ],
    })
  })

  it('reads an AUTO line height as the valueless form', () => {
    const { ops } = runsToRangeOps(
      [{ at: [0, 3], lineHeight: { unit: 'AUTO' } }],
      3,
    )
    expect(ops[0].lineHeight).toEqual({ unit: 'AUTO' })
  })

  // The bug this module exists to prevent: a run past the end of the text used
  // to be applied to a Figma range that does not exist, which throws and takes
  // the whole node down. It is declined, and the decline is REPORTED.
  it('skips a run past the text length and says so', () => {
    const { ops, skipped } = runsToRangeOps(
      [bold, { ...regular, at: [5, 99] }],
      11,
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].end).toBe(5)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toContain('[5,99]')
    expect(skipped[0]).toContain('11 character(s)')
  })

  it('never throws on a malformed at', () => {
    const { ops, skipped } = runsToRangeOps(
      [
        { at: 'nope' },
        { at: [1] },
        { at: [null, 4] },
        { font: { family: 'Inter', style: 'Bold' } },
      ],
      10,
    )
    expect(ops).toEqual([])
    expect(skipped).toHaveLength(4)
    for (const s of skipped) {
      expect(s).toContain("'at' must be a [start,end] pair")
    }
  })

  it('declines an empty or inverted range', () => {
    const { ops, skipped } = runsToRangeOps(
      [{ at: [4, 4], fontSize: 9 }, { at: [8, 2] }],
      10,
    )
    expect(ops).toEqual([])
    expect(skipped[0]).toContain('empty or inverted')
    expect(skipped[1]).toContain('empty or inverted')
  })

  it('declines a run that names no style at all', () => {
    const { ops, skipped } = runsToRangeOps(
      [{ at: [0, 4] }],
      10,
    )
    expect(ops).toEqual([])
    expect(skipped[0]).toContain('nothing to apply')
  })

  it('yields no ops for an empty or absent list', () => {
    for (const empty of [undefined, null, [], 'runs', {}]) {
      expect(runsToRangeOps(empty, 10)).toEqual({
        ops: [],
        skipped: [],
      })
    }
  })

  it('ignores a half-named font rather than guessing a style', () => {
    const { ops } = runsToRangeOps(
      [{ at: [0, 4], font: { family: 'Inter', size: 20 } }],
      10,
    )
    expect(ops[0].fontName).toBeUndefined()
    expect(ops[0].fontSize).toBe(20)
  })
})

describe('fontsToLoad', () => {
  it('dedupes — five runs of one font cost one load', () => {
    const { ops } = runsToRangeOps(
      Array.from({ length: 5 }, (_, i) => ({
        at: [i, i + 1],
        font: {
          family: 'Inter',
          style: 'Bold',
          size: 10,
        },
      })),
      10,
    )
    expect(fontsToLoad(ops)).toEqual([
      { family: 'Inter', style: 'Bold' },
    ])
  })

  it('is empty when no run names a font', () => {
    expect(fontsToLoad([{ start: 0, end: 1 }])).toEqual([])
  })
})

// The shape getStyledTextSegments returns.
const seg = (
  start: number,
  end: number,
  style: string,
  extra: Record<string, unknown> = {},
) => ({
  start,
  end,
  fontName: { family: 'Inter', style },
  fontSize: 16,
  fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  ...extra,
})

describe('segmentsToRuns', () => {
  // An ordinary read must be byte-identical to what it was before runs existed.
  it('emits nothing for a single-style text', () => {
    expect(
      segmentsToRuns([seg(0, 11, 'Regular')]),
    ).toBeUndefined()
    expect(segmentsToRuns([])).toBeUndefined()
    expect(segmentsToRuns(undefined)).toBeUndefined()
  })

  it('projects two segments into the reader’s run shape', () => {
    const out = segmentsToRuns([
      seg(0, 5, 'Bold'),
      seg(5, 11, 'Regular'),
    ])
    expect(out?.omitted).toBe(0)
    expect(out?.runs).toEqual([
      {
        at: [0, 5],
        style: {
          fontFamily: 'Inter',
          fontStyle: 'Bold',
          fontSize: 16,
        },
        color: [
          { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
        ],
      },
      {
        at: [5, 11],
        style: {
          fontFamily: 'Inter',
          fontStyle: 'Regular',
          fontSize: 16,
        },
        color: [
          { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
        ],
      },
    ])
  })

  it('spells line height the way the reader parses it', () => {
    const out = segmentsToRuns([
      seg(0, 5, 'Bold', {
        lineHeight: { unit: 'PIXELS', value: 24 },
      }),
      seg(5, 9, 'Bold', {
        lineHeight: { unit: 'PERCENT', value: 150 },
      }),
      seg(9, 11, 'Bold', { lineHeight: { unit: 'AUTO' } }),
    ])
    expect(out?.runs[0].style).toMatchObject({
      lineHeightUnit: 'PIXELS',
      lineHeightPx: 24,
    })
    expect(out?.runs[1].style).toMatchObject({
      lineHeightUnit: 'PERCENT',
      lineHeightPercent: 150,
    })
    expect(out?.runs[2].style).not.toHaveProperty(
      'lineHeightUnit',
    )
  })

  it('converts PERCENT letter spacing to the px the reader expects', () => {
    const out = segmentsToRuns([
      seg(0, 5, 'Bold', {
        letterSpacing: { unit: 'PERCENT', value: 10 },
      }),
      seg(5, 9, 'Bold', {
        letterSpacing: { unit: 'PIXELS', value: 0.5 },
      }),
      seg(9, 11, 'Bold', {
        letterSpacing: { unit: 'PIXELS', value: 0 },
      }),
    ])
    // 10% of the 16px font size.
    expect(out?.runs[0].style?.letterSpacing).toBe(1.6)
    expect(out?.runs[1].style?.letterSpacing).toBe(0.5)
    expect(out?.runs[2].style).not.toHaveProperty(
      'letterSpacing',
    )
  })

  // T10: per-character styling is unbounded. Cap it, and REPORT the cap.
  it('caps a pathological segment list and reports what it dropped', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      seg(i, i + 1, i % 2 === 0 ? 'Bold' : 'Regular'),
    )
    const out = segmentsToRuns(many)
    expect(out?.runs).toHaveLength(MAX_RUNS)
    expect(out?.omitted).toBe(250 - MAX_RUNS)
  })

  it('skips a segment with no usable range rather than throwing', () => {
    const out = segmentsToRuns([
      { start: 'x', end: 4 },
      seg(4, 9, 'Bold'),
    ])
    expect(out?.runs).toHaveLength(1)
    expect(out?.runs[0].at).toEqual([4, 9])
  })
})
