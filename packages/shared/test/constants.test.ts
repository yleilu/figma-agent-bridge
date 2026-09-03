import { describe, expect, it } from 'bun:test'
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  CONTEXT_NS,
  CONTEXT_KEY,
  CONTEXT_MAX_BYTES,
  CONTEXT_SUMMARY_MAX_BYTES,
} from '@figma-agent-bridge/shared/constants'

describe('shared constants', () => {
  it('exports correct app identity', () => {
    expect(APP_NAME).toBe('figma-agent-bridge')
    expect(typeof APP_VERSION).toBe('string')
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('exports DEFAULT_PORT as 18080', () => {
    expect(DEFAULT_PORT).toBe(18080)
  })
})

describe('context constants', () => {
  it('are the pinned literals', () => {
    expect(CONTEXT_NS).toBe('figmabridge')
    expect(CONTEXT_KEY).toBe('context')
    expect(CONTEXT_MAX_BYTES).toBe(2048)
    expect(CONTEXT_SUMMARY_MAX_BYTES).toBe(512)
  })
})
