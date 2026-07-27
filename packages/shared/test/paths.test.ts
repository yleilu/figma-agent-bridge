import { describe, it, expect } from 'bun:test'
import { sanitizeKey } from '@figma-agent-bridge/shared/paths'

describe('sanitizeKey', () => {
  // The fixture table pinned by plugin-presence.md, over the ASCII alphabet
  // real keys are drawn from. The hook's `LC_ALL=C sed 's/[^A-Za-z0-9_-]/_/g'`
  // must produce the same output for every row (test/presence-hook.test.ts).
  const table: [string, string][] = [
    ['Yv8QhK2nRb0aC1dE3fG4hJ', 'Yv8QhK2nRb0aC1dE3fG4hJ'],
    ['sess-9f2c8d7a_b1', 'sess-9f2c8d7a_b1'],
    [
      '4b8e1f60-2c3a-4d5e-8f01-9ab2cd3ef456',
      '4b8e1f60-2c3a-4d5e-8f01-9ab2cd3ef456',
    ],
    ['_unattributed', '_unattributed'],
    ['fk/a.b:c', 'fk_a_b_c'],
    ['../secrets', '___secrets'],
  ]
  for (const [input, expected] of table) {
    it(`maps ${input} → ${expected}`, () => {
      expect(sanitizeKey(input)).toBe(expected)
    })
  }

  it('returns a path SEGMENT with no extension', () => {
    expect(sanitizeKey('abc').endsWith('.json')).toBe(false)
  })
})
