import { describe, it, expect } from 'bun:test'
import { genId, genToken } from '@figma-agent-bridge/shared'

const ALNUM = /^[0-9a-z]+$/

describe('genId', () => {
  it('is a 12-char lowercase-alphanumeric id with no prefix', () => {
    const id = genId()
    expect(id).toHaveLength(12)
    expect(id).toMatch(ALNUM)
  })
  it('prefixes as `<prefix>-<12 chars>`', () => {
    const id = genId('cmd')
    expect(id.startsWith('cmd-')).toBe(true)
    const body = id.slice('cmd-'.length)
    expect(body).toHaveLength(12)
    expect(body).toMatch(ALNUM)
  })
  it('is unique across many calls', () => {
    const n = 10_000
    const set = new Set(
      Array.from({ length: n }, () => genId()),
    )
    expect(set.size).toBe(n)
  })
})

describe('genToken', () => {
  it('defaults to 8 chars, lowercase-alphanumeric', () => {
    const t = genToken()
    expect(t).toHaveLength(8)
    expect(t).toMatch(ALNUM)
  })
  it('honors an explicit size', () => {
    expect(genToken(16)).toHaveLength(16)
  })
  it('is unique across many calls', () => {
    const n = 10_000
    const set = new Set(
      Array.from({ length: n }, () => genToken()),
    )
    expect(set.size).toBe(n)
  })
})

describe('non-secure runtime safety', () => {
  // The plugin UI iframe (Figma desktop) is a non-secure context where
  // the secure Web Crypto surface is absent. genId/genToken must not
  // touch it — prove ids still mint with crypto removed.
  it('mints ids without any secure-context Web Crypto API', () => {
    const g = globalThis as { crypto?: unknown }
    const saved = Object.getOwnPropertyDescriptor(
      g,
      'crypto',
    )
    let simulated = false
    try {
      Object.defineProperty(g, 'crypto', {
        value: undefined,
        configurable: true,
      })
      simulated = true
    } catch {
      /* if this runtime forbids it, the assertion below fails loudly */
    }
    try {
      // The simulation MUST have taken effect, else this test would
      // silently pass against the real crypto without exercising the
      // crypto-absent path it exists to guard.
      expect(simulated).toBe(true)
      expect(g.crypto).toBeUndefined()
      expect(genId()).toMatch(ALNUM)
      expect(genToken()).toHaveLength(8)
    } finally {
      if (simulated && saved) {
        Object.defineProperty(g, 'crypto', saved)
      }
    }
  })
})
