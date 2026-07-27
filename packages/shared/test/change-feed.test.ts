import { describe, it, expect } from 'bun:test'
import {
  collapse,
  SETTLE_MS,
  SENTINEL_TTL_MS,
  type BufferEntry,
} from '@figma-agent-bridge/shared/change-feed'

describe('tuning constants that must not drift', () => {
  // The POC's measured value, copied from
  // docs/reference/change-feed-poc-results.md. Update BOTH together, never
  // one alone — that is the entire point of this test.
  const MEASURED_SETTLE_MS = 400

  // The two measurements SETTLE_MS is derived FROM, same document: the p99.9
  // of the documentchange batch period, and the empirical floor of the sweep
  // (120 ms passed, 80 ms failed open).
  const MEASURED_BATCH_P999_MS = 100
  const MEASURED_FILTER_FLOOR_MS = 120

  it('SETTLE_MS is the POC-measured value, not the placeholder', () => {
    expect(SETTLE_MS).toBe(MEASURED_SETTLE_MS)
    // The plan's placeholder was ALSO 400, so equality with it cannot by
    // itself tell a measured value from a forgotten edit. The two bounds
    // below are what make the number legible: under the floor the filter
    // fails OPEN and every agent write reads as a user edit.
    expect(SETTLE_MS).toBeGreaterThan(
      MEASURED_BATCH_P999_MS,
    )
    expect(SETTLE_MS).toBeGreaterThan(
      MEASURED_FILTER_FLOOR_MS,
    )
  })

  it('SENTINEL_TTL_MS is a whole number of seconds (the hook pins seconds)', () => {
    expect(SENTINEL_TTL_MS % 1000).toBe(0)
  })
})

const e = (
  op: BufferEntry['op'],
  over: Partial<BufferEntry> = {},
): BufferEntry => ({ op, ...over })

describe('collapse algebra (total)', () => {
  it('(none) → arriving', () => {
    expect(collapse(undefined, e('update'))?.op).toBe(
      'update',
    )
  })

  it('create → delete CANCELS the entry', () => {
    expect(collapse(e('create'), e('delete'))).toBe(null)
  })

  it('create → update stays create and DROPS props', () => {
    const r = collapse(
      e('create', { name: 'A' }),
      e('update', { props: new Set(['x']) }),
    )
    expect(r?.op).toBe('create')
    expect(r?.props).toBeUndefined()
  })

  it('update → update UNIONS props (never latest-wins)', () => {
    const r = collapse(
      e('update', { props: new Set(['name']) }),
      e('update', { props: new Set(['x']) }),
    )
    expect([...(r?.props ?? [])].sort()).toEqual([
      'name',
      'x',
    ])
  })

  it('update → delete drops props and name', () => {
    const r = collapse(
      e('update', {
        name: 'A',
        props: new Set(['x']),
      }),
      e('delete', { type: 'FRAME' }),
    )
    expect(r).toEqual({ op: 'delete', type: 'FRAME' })
  })

  it('delete → create becomes create (undo/redo restores the id)', () => {
    expect(collapse(e('delete'), e('create'))?.op).toBe(
      'create',
    )
  })

  it('delete → update (cannot happen, still specified)', () => {
    const r = collapse(
      e('delete'),
      e('update', { props: new Set(['y']) }),
    )
    expect(r?.op).toBe('update')
    expect([...(r?.props ?? [])]).toEqual(['y'])
  })

  it('update → create (cannot happen) drops props', () => {
    const r = collapse(
      e('update', { props: new Set(['x']) }),
      e('create'),
    )
    expect(r?.op).toBe('create')
    expect(r?.props).toBeUndefined()
  })

  it('takes the LATEST DEFINED name and type on a merge', () => {
    const r = collapse(
      e('update', { name: 'old', type: 'FRAME' }),
      e('update', { name: 'new' }),
    )
    expect(r?.name).toBe('new')
    expect(r?.type).toBe('FRAME')
  })

  it('applies identically over style ops', () => {
    const r = collapse(
      e('style_update', { props: new Set(['paints']) }),
      e('style_update', { props: new Set(['name']) }),
    )
    expect(r?.op).toBe('style_update')
    expect([...(r?.props ?? [])].sort()).toEqual([
      'name',
      'paints',
    ])
  })
})
