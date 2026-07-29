import { describe, it, expect } from 'bun:test'
import { createSessionIdentity } from '@figma-agent-bridge/server/change-feed/session-identity'

describe('sessionIdentity', () => {
  it('the FIRST non-empty id wins for the life of the process', () => {
    const s = createSessionIdentity()
    s.remember(undefined)
    s.remember('')
    expect(s.current()).toBeUndefined()
    s.remember('sess-a')
    s.remember('sess-b')
    expect(s.current()).toBe('sess-a')
  })

  it('onAdopt fires exactly ONCE, on the first id', () => {
    const s = createSessionIdentity()
    const seen: string[] = []
    s.onAdopt(id => seen.push(id))
    s.remember('sess-a')
    s.remember('sess-b')
    expect(seen).toEqual(['sess-a'])
  })

  it('onAdopt registered AFTER adoption fires immediately', () => {
    const s = createSessionIdentity()
    s.remember('sess-a')
    const seen: string[] = []
    s.onAdopt(id => seen.push(id))
    expect(seen).toEqual(['sess-a'])
  })
})
