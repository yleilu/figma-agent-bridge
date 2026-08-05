import { describe, expect, it } from 'bun:test'
import {
  applyCornersToVertices,
  cornersFromNetwork,
} from './vector-corners'

const v = (cornerRadius?: number) => ({ cornerRadius })

describe('cornersFromNetwork', () => {
  it('returns undefined when no point is rounded', () => {
    expect(
      cornersFromNetwork({ vertices: [v(0), v(), v(0)] }),
    ).toBeUndefined()
  })

  // The maintainer's hand-drawn shape: four points, the middle two rounded to
  // 10 and 20. Read live from Figma before this was built.
  it('keys the rounded points by their vertex index', () => {
    expect(
      cornersFromNetwork({
        vertices: [v(0), v(10), v(20), v(0)],
      }),
    ).toEqual({ 1: 10, 2: 20 })
  })

  it('is sparse — 500 points with three rounded gives three entries', () => {
    const vertices = Array.from({ length: 500 }, (_, i) =>
      i === 3 || i === 21 || i === 46 ? v(8) : v(0),
    )
    const out = cornersFromNetwork({ vertices })
    expect(Object.keys(out ?? {})).toEqual([
      '3',
      '21',
      '46',
    ])
  })

  it('never throws on a missing or malformed network', () => {
    expect(cornersFromNetwork(undefined)).toBeUndefined()
    expect(cornersFromNetwork(null)).toBeUndefined()
    expect(cornersFromNetwork({} as never)).toBeUndefined()
    expect(
      cornersFromNetwork({ vertices: 'nope' } as never),
    ).toBeUndefined()
  })

  it('ignores a non-finite radius', () => {
    expect(
      cornersFromNetwork({
        vertices: [v(Number.NaN), v(Infinity), v(5)],
      }),
    ).toEqual({ 2: 5 })
  })
})

describe('applyCornersToVertices', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]

  it('stamps the named points and leaves the rest alone', () => {
    const out = applyCornersToVertices(pts, { 1: 10 })
    expect(out.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0, cornerRadius: 10 },
      { x: 10, y: 10 },
    ])
    expect(out.skipped).toEqual([])
  })

  it('does not mutate the network it was given', () => {
    applyCornersToVertices(pts, { 0: 4 })
    expect(pts[0]).toEqual({ x: 0, y: 0 })
  })

  it('reports an out-of-range index instead of throwing', () => {
    const out = applyCornersToVertices(pts, { 1: 6, 9: 6 })
    expect(out.skipped).toEqual([9])
    expect(out.vertices[1]).toEqual({
      x: 10,
      y: 0,
      cornerRadius: 6,
    })
  })

  it('round-trips with cornersFromNetwork', () => {
    const corners = { 0: 12, 2: 4 }
    const { vertices } = applyCornersToVertices(
      pts,
      corners,
    )
    expect(cornersFromNetwork({ vertices })).toEqual(
      corners,
    )
  })
})
