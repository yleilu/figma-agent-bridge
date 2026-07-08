import { describe, it, expect } from 'bun:test'
import {
  deriveChannel,
  isTargetMismatch,
} from './file-channel'

describe('deriveChannel', () => {
  it('is deterministic — same fileKey → same channel', () => {
    expect(deriveChannel('AbC123')).toBe(
      deriveChannel('AbC123'),
    )
  })

  it('maps distinct fileKeys to distinct channels', () => {
    expect(deriveChannel('fileOne')).not.toBe(
      deriveChannel('fileTwo'),
    )
  })

  it('returns a non-empty channel', () => {
    expect(deriveChannel('k').length).toBeGreaterThan(0)
  })
})

describe('isTargetMismatch (B3 guard)', () => {
  it('does not refuse when the command targets this file', () => {
    expect(isTargetMismatch('fk1', 'fk1')).toBe(false)
  })

  it('REFUSES when the command targets a different file', () => {
    expect(isTargetMismatch('fk1', 'fk2')).toBe(true)
  })

  it('does not refuse when local fileKey is unknown', () => {
    expect(isTargetMismatch(null, 'fk2')).toBe(false)
  })

  it('does not refuse when the command carries no target', () => {
    expect(isTargetMismatch('fk1', null)).toBe(false)
  })
})
