import { describe, it, expect } from 'bun:test'
import {
  collapse,
  MAX_DISPATCH_MS,
  RETAINED_COMMANDS,
  RETENTION_CEILING_MS,
  SENTINEL_TTL_MS,
  type BufferEntry,
} from '@figma-agent-bridge/shared/change-feed'

describe('tuning constants that must not drift', () => {
  // Every number below is read off docs/reference/change-feed-poc-results.md.
  // Update BOTH together, never one alone — that is the entire point of this
  // test.

  // The largest observed burst of dispatches outstanding with an earlier
  // event still undelivered: the 20-write battery produced NO frame while it
  // ran, then one frame of 19 records — eight of them from a PREVIOUS run of
  // the same script ("The idle-delivery leak").
  const MEASURED_OUTSTANDING_DISPATCHES = 28

  // The longest deferral ever measured between a command's exit and the
  // delivery of its documentchange (Probe 1).
  const MEASURED_MAX_DEFERRAL_MS = 49_200

  // The server's own dispatch timeout (figma-client.ts): a command it has
  // already abandoned and that is still open plugin-side is a wedge.
  const SERVER_DISPATCH_TIMEOUT_MS = 30_000

  it('RETAINED_COMMANDS is above the largest observed outstanding burst', () => {
    expect(Number.isInteger(RETAINED_COMMANDS)).toBe(true)
    expect(RETAINED_COMMANDS).toBeGreaterThan(
      MEASURED_OUTSTANDING_DISPATCHES,
    )
  })

  it('RETAINED_COMMANDS stays "in tens of commands" — it is THE memory bound', () => {
    // Both sides, or the assertion is not a pin: this is the constant that
    // bounds plugin-sandbox memory (up to this many generations, each
    // holding a reflow set capped only at MAX_CLOSURE_NODES), and it is
    // also how much of the user's work on nodes the agent touched is
    // dropped in silence. Without an upper bound it could drift to 4096
    // and this suite would stay green — the exact drift the test exists to
    // prevent. change-feed.md: "sized in TENS of commands".
    expect(RETAINED_COMMANDS).toBeLessThanOrEqual(100)
  })

  it('RETENTION_CEILING_MS is sized in minutes, above the longest deferral', () => {
    expect(RETENTION_CEILING_MS).toBeGreaterThan(
      MEASURED_MAX_DEFERRAL_MS,
    )
    // "Sized in MINUTES" (change-feed.md), pinned on both sides: too low and
    // retention lets go before a deferred batch lands; too high and the
    // user's post-hand-over edits stay invisible for that long.
    expect(RETENTION_CEILING_MS).toBeGreaterThanOrEqual(
      2 * 60_000,
    )
    expect(RETENTION_CEILING_MS).toBeLessThanOrEqual(
      15 * 60_000,
    )
  })

  it('MAX_DISPATCH_MS reaps a wedge well before the idle ceiling could', () => {
    expect(MAX_DISPATCH_MS).toBeGreaterThan(
      SERVER_DISPATCH_TIMEOUT_MS,
    )
    expect(MAX_DISPATCH_MS).toBeLessThan(
      RETENTION_CEILING_MS,
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
