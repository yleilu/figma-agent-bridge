import { describe, expect, it } from 'bun:test'
import {
  isTargetMismatch,
  targetGuardError,
} from '../src/identity-guard'

describe('isTargetMismatch (B3)', () => {
  it('refuses only when both keys are known and differ', () => {
    expect(isTargetMismatch('a', 'b')).toBe(true)
    expect(isTargetMismatch('a', 'a')).toBe(false)
    expect(isTargetMismatch(null, 'b')).toBe(false)
    expect(isTargetMismatch('a', null)).toBe(false)
    expect(isTargetMismatch('a', undefined)).toBe(false)
  })
})

describe('targetGuardError', () => {
  it('names both files', () => {
    const m = targetGuardError('target-k', 'own-k')
    expect(m).toContain('target-k')
    expect(m).toContain('own-k')
  })
})
