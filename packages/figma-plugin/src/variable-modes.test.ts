import { describe, expect, it } from 'bun:test'
import { modeIdFor } from './variable-modes'

const modes = [
  { modeId: 'm1', name: 'Light' },
  { modeId: 'm2', name: 'Dark' },
]

describe('modeIdFor (I70)', () => {
  it('resolves a mode NAME', () => {
    expect(modeIdFor('Dark', modes)).toBe('m2')
  })

  it('resolves a mode ID too — a read that emitted one must still write', () => {
    expect(modeIdFor('m1', modes)).toBe('m1')
  })

  it('prefers the NAME when a name and an id collide', () => {
    // A collection whose SECOND mode is literally named `m1`. The name is the
    // documented vocabulary, so it wins; the id path is the fallback.
    const odd = [
      { modeId: 'm1', name: 'Light' },
      { modeId: 'm2', name: 'm1' },
    ]
    expect(modeIdFor('m1', odd)).toBe('m2')
  })

  it('answers undefined for a mode the collection does not have', () => {
    expect(modeIdFor('Sepia', modes)).toBeUndefined()
  })
})
