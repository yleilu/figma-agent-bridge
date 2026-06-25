import { describe, expect, it } from 'bun:test'
import { encodeCursor, decodeCursor } from '../cursor'

describe('cursor', () => {
  it('round-trip: encode then decode returns the original pos', () => {
    const token = encodeCursor({
      pos: 42,
      treeVersion: 'v1',
    })
    const result = decodeCursor(token, 'v1')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('Expected ok')
    }
    expect(result.pos).toBe(42)
  })

  it('staleness: same token with different version returns STALE', () => {
    const token = encodeCursor({
      pos: 42,
      treeVersion: 'v1',
    })
    const result = decodeCursor(token, 'v2')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('STALE')
  })

  it('malformed: garbage string returns MALFORMED', () => {
    const result = decodeCursor('!!!not-base64!!!', 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('malformed: valid base64 of non-JSON returns MALFORMED', () => {
    const nonJson = Buffer.from(
      'not-json',
      'utf8',
    ).toString('base64url')
    const result = decodeCursor(nonJson, 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('malformed: valid base64 JSON missing required fields returns MALFORMED', () => {
    const partial = Buffer.from(
      JSON.stringify({ pos: 10 }),
      'utf8',
    ).toString('base64url')
    const result = decodeCursor(partial, 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('opacity: token is not the plaintext JSON', () => {
    const token = encodeCursor({
      pos: 42,
      treeVersion: 'v1',
    })
    const plaintext = JSON.stringify({
      pos: 42,
      treeVersion: 'v1',
    })
    expect(token).not.toBe(plaintext)
  })

  it('opacity: token does not contain the raw decimal offset', () => {
    // pos=42, treeVersion='v1' — base64url of JSON won't contain "42" in plaintext
    const token = encodeCursor({
      pos: 42,
      treeVersion: 'v1',
    })
    // The token is base64url-encoded so it should not expose "42" as substring
    expect(token).not.toContain('42')
  })

  it('empty string returns MALFORMED', () => {
    const result = decodeCursor('', 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('malformed: negative pos returns MALFORMED', () => {
    const token = Buffer.from(
      JSON.stringify({ pos: -5, treeVersion: 'v1' }),
      'utf8',
    ).toString('base64url')
    const result = decodeCursor(token, 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('malformed: non-integer pos returns MALFORMED', () => {
    const token = Buffer.from(
      JSON.stringify({ pos: 1.5, treeVersion: 'v1' }),
      'utf8',
    ).toString('base64url')
    const result = decodeCursor(token, 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('malformed: NaN pos returns MALFORMED', () => {
    // NaN is not representable in JSON, so encode the raw token by hand.
    const token = Buffer.from(
      '{"pos":NaN,"treeVersion":"v1"}',
      'utf8',
    ).toString('base64url')
    const result = decodeCursor(token, 'v1')
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected not ok')
    }
    expect(result.reason).toBe('MALFORMED')
  })

  it('accepts pos === 0 (valid lower bound)', () => {
    const token = encodeCursor({
      pos: 0,
      treeVersion: 'v1',
    })
    const result = decodeCursor(token, 'v1')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('Expected ok')
    }
    expect(result.pos).toBe(0)
  })
})
