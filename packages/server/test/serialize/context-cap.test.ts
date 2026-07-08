import { describe, expect, it } from 'bun:test'
import { assertContextWithinCap } from '../../src/serialize/context-cap'

describe('assertContextWithinCap', () => {
  it('accepts <= 2048 bytes and undefined', () => {
    expect(() => assertContextWithinCap({})).not.toThrow()
    expect(() =>
      assertContextWithinCap({ context: 'a'.repeat(2048) }),
    ).not.toThrow()
  })
  it('throws a clean message over 2048 UTF-8 bytes (byte, not char)', () => {
    // '🙂' = 4 UTF-8 bytes; 513 of them = 2052 bytes > 2048 but only 513 chars
    expect(() =>
      assertContextWithinCap({ context: '🙂'.repeat(513) }),
    ).toThrow(/context is 2052 bytes; limit is 2048/)
  })
})
