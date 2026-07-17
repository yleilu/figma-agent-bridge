// masks.test.ts — TDD tests for isMask / maskType NodeSpec fields (M9)
//
// Tests the full round-trip:
//   Writer: specToFigma({ isMask, maskType }) → FigmaWritePayload
//   Reader: buildNode({ isMask, maskType }) → NodeSpec
//   Round-trip: reader output → writer → same payload keys

import { describe, expect, it } from 'bun:test'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'
import { toNodeSpec } from '@figma-agent-bridge/server/serialize/node-spec-reader'

// ─── Writer tests ─────────────────────────────────────────────────────────────

describe('specToFigma — isMask / maskType', () => {
  it('emits isMask:true and maskType when both are set', () => {
    const payload = specToFigma({
      type: 'RECTANGLE',
      isMask: true,
      maskType: 'ALPHA',
    })
    expect(payload.isMask).toBe(true)
    expect(payload.maskType).toBe('ALPHA')
  })

  it('emits isMask:false without maskType when only isMask:false is set', () => {
    const payload = specToFigma({
      type: 'RECTANGLE',
      isMask: false,
    })
    expect(payload.isMask).toBe(false)
    expect('maskType' in payload).toBe(false)
  })

  it('emits maskType:VECTOR when isMask:true and maskType:VECTOR', () => {
    const payload = specToFigma({
      isMask: true,
      maskType: 'VECTOR',
    })
    expect(payload.isMask).toBe(true)
    expect(payload.maskType).toBe('VECTOR')
  })

  it('emits maskType:LUMINANCE when isMask:true and maskType:LUMINANCE', () => {
    const payload = specToFigma({
      isMask: true,
      maskType: 'LUMINANCE',
    })
    expect(payload.isMask).toBe(true)
    expect(payload.maskType).toBe('LUMINANCE')
  })

  it('does not emit isMask or maskType when neither is set', () => {
    const payload = specToFigma({ name: 'Test' })
    expect('isMask' in payload).toBe(false)
    expect('maskType' in payload).toBe(false)
  })
})

// ─── Reader tests ─────────────────────────────────────────────────────────────

// Minimal raw Figma node for reader tests — mimics what exportAsync returns
const makeRawNode = (
  extras: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'test:1',
  name: 'TestNode',
  type: 'RECTANGLE',
  absoluteBoundingBox: {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  },
  ...extras,
})

describe('toNodeSpec — isMask / maskType', () => {
  it('produces isMask:true and maskType from raw with isMask:true and maskType:LUMINANCE', () => {
    const raw = makeRawNode({
      isMask: true,
      maskType: 'LUMINANCE',
    })
    const spec = toNodeSpec(raw, { depth: 0 })
    expect(spec.isMask).toBe(true)
    expect(spec.maskType).toBe('LUMINANCE')
  })

  it('produces isMask:true and maskType:ALPHA from raw', () => {
    const raw = makeRawNode({
      isMask: true,
      maskType: 'ALPHA',
    })
    const spec = toNodeSpec(raw, { depth: 0 })
    expect(spec.isMask).toBe(true)
    expect(spec.maskType).toBe('ALPHA')
  })

  it('does not emit isMask or maskType when isMask is false', () => {
    const raw = makeRawNode({
      isMask: false,
      maskType: 'ALPHA',
    })
    const spec = toNodeSpec(raw, { depth: 0 })
    expect('isMask' in spec).toBe(false)
    expect('maskType' in spec).toBe(false)
  })

  it('does not emit isMask or maskType when isMask is absent', () => {
    const raw = makeRawNode()
    const spec = toNodeSpec(raw, { depth: 0 })
    expect('isMask' in spec).toBe(false)
    expect('maskType' in spec).toBe(false)
  })

  it('emits isMask:true without maskType when maskType is absent', () => {
    const raw = makeRawNode({ isMask: true })
    const spec = toNodeSpec(raw, { depth: 0 })
    expect(spec.isMask).toBe(true)
    expect('maskType' in spec).toBe(false)
  })
})

// ─── Round-trip tests ─────────────────────────────────────────────────────────

describe('isMask / maskType round-trip (reader → writer)', () => {
  it('reader output with isMask:true → writer emits same isMask and maskType', () => {
    const raw = makeRawNode({
      isMask: true,
      maskType: 'ALPHA',
    })
    const spec = toNodeSpec(raw, { depth: 0 })
    const payload = specToFigma(spec)
    expect(payload.isMask).toBe(true)
    expect(payload.maskType).toBe('ALPHA')
  })

  it('reader output with isMask:false → writer emits no isMask/maskType', () => {
    const raw = makeRawNode({ isMask: false })
    const spec = toNodeSpec(raw, { depth: 0 })
    const payload = specToFigma(spec)
    expect('isMask' in payload).toBe(false)
    expect('maskType' in payload).toBe(false)
  })

  it('reader output with no mask → writer emits no isMask/maskType', () => {
    const raw = makeRawNode()
    const spec = toNodeSpec(raw, { depth: 0 })
    const payload = specToFigma(spec)
    expect('isMask' in payload).toBe(false)
    expect('maskType' in payload).toBe(false)
  })
})
