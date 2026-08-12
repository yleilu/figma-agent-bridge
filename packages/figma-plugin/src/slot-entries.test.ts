// slot-entries.test.ts — the two shapes a slot entry arrives in (B30).

import { describe, expect, it } from 'bun:test'
import { readSlotEntry } from './slot-entries'

describe('readSlotEntry', () => {
  it('reads a bare name and asks for no spec (back-compat)', () => {
    expect(readSlotEntry('Content')).toEqual({
      name: 'Content',
    })
  })

  it('reads the name off an object entry and keeps the spec', () => {
    const entry = {
      name: 'Content',
      layout: { mode: 'V', spacing: 8 },
      fills: [],
    }
    const read = readSlotEntry(entry)
    expect(read.name).toBe('Content')
    expect(read.spec).toBe(entry)
  })

  it('never stringifies a missing name — an unnamed entry keeps Figma auto-name', () => {
    const read = readSlotEntry({ fills: [] })
    expect(read.name).toBe('')
    expect(read.spec).toEqual({ fills: [] })
  })

  it('treats a non-string name the same way (no [object Object] slot)', () => {
    expect(readSlotEntry({ name: 42 }).name).toBe('')
  })

  it('survives a null entry', () => {
    expect(
      readSlotEntry(null as unknown as string),
    ).toEqual({ name: '' })
  })
})
