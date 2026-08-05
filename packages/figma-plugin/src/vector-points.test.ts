import { describe, expect, it } from 'bun:test'
import {
  applyPointDetail,
  capsFromNetwork,
  cornersFromNetwork,
} from './vector-points'

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

describe('applyPointDetail', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]

  it('stamps the named points and leaves the rest alone', () => {
    const out = applyPointDetail(pts, {
      corners: { 1: 10 },
    })
    expect(out.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0, cornerRadius: 10 },
      { x: 10, y: 10 },
    ])
    expect(out.skipped).toEqual([])
  })

  it('does not mutate the network it was given', () => {
    applyPointDetail(pts, { corners: { 0: 4 } })
    expect(pts[0]).toEqual({ x: 0, y: 0 })
  })

  it('reports an out-of-range index instead of throwing', () => {
    const out = applyPointDetail(pts, {
      corners: { 1: 6, 9: 6 },
    })
    expect(out.skipped).toEqual([9])
    expect(out.vertices[1]).toEqual({
      x: 10,
      y: 0,
      cornerRadius: 6,
    })
  })

  it('round-trips with cornersFromNetwork', () => {
    const corners = { 0: 12, 2: 4 }
    const { vertices } = applyPointDetail(pts, { corners })
    expect(cornersFromNetwork({ vertices })).toEqual(
      corners,
    )
  })
})

describe('capsFromNetwork', () => {
  // The arrow case: a two-point line pointing one way. The node-level cap
  // cannot hold two values, which is the whole reason this key exists.
  it('keys an overriding cap by its vertex index', () => {
    expect(
      capsFromNetwork({
        vertices: [{}, { strokeCap: 'ARROW_LINES' }],
      }),
    ).toEqual({ 1: 'ARROW_LINES' })
  })

  it('is undefined when every point inherits the node cap', () => {
    expect(
      capsFromNetwork({ vertices: [{}, {}] }),
    ).toBeUndefined()
  })

  // Figma stamps the node's cap onto every vertex rather than leaving them
  // blank, so a node set to ROUND must still emit nothing — verified live.
  it('skips points that merely echo the node cap', () => {
    expect(
      capsFromNetwork(
        {
          vertices: [
            { strokeCap: 'ROUND' },
            { strokeCap: 'ROUND' },
          ],
        },
        'ROUND',
      ),
    ).toBeUndefined()
  })

  it('names only the point that disagrees with the node', () => {
    expect(
      capsFromNetwork(
        {
          vertices: [
            { strokeCap: 'ROUND' },
            { strokeCap: 'ARROW_LINES' },
          ],
        },
        'ROUND',
      ),
    ).toEqual({ 1: 'ARROW_LINES' })
  })

  it('never throws on a missing or malformed network', () => {
    expect(capsFromNetwork(undefined)).toBeUndefined()
    expect(capsFromNetwork(null)).toBeUndefined()
    expect(
      capsFromNetwork({ vertices: 'nope' } as never),
    ).toBeUndefined()
  })
})

describe('applyPointDetail — corners and caps together', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]

  it('stamps both onto the same vertex list', () => {
    expect(
      applyPointDetail(pts, {
        corners: { 0: 4 },
        caps: { 1: 'ARROW_LINES' },
      }).vertices,
    ).toEqual([
      { x: 0, y: 0, cornerRadius: 4 },
      { x: 10, y: 0, strokeCap: 'ARROW_LINES' },
    ])
  })

  it('reports an out-of-range index from either key, once', () => {
    expect(
      applyPointDetail(pts, {
        corners: { 7: 4 },
        caps: { 7: 'ROUND', 9: 'ROUND' },
      }).skipped,
    ).toEqual([7, 9])
  })

  it('round-trips a cap with capsFromNetwork', () => {
    const caps = { 1: 'ARROW_EQUILATERAL' }
    const { vertices } = applyPointDetail(pts, { caps })
    expect(capsFromNetwork({ vertices })).toEqual(caps)
  })
})
