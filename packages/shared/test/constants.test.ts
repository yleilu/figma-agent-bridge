import { describe, expect, it } from 'bun:test'
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
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
