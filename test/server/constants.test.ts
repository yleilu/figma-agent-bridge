import { describe, expect, it } from 'bun:test'
import {
  APP_NAME,
  APP_VERSION,
} from '../../packages/shared/src/constants'

describe('shared constants', () => {
  it('exports correct app identity', () => {
    expect(APP_NAME).toBe('figma-agent-bridge')
    expect(typeof APP_VERSION).toBe('string')
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
