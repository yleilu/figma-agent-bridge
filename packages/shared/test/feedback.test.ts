import { describe, it, expect } from 'bun:test'
import { FEEDBACK_CATEGORIES } from '@figma-agent-bridge/shared'

describe('feedback types', () => {
  it('exposes the two starter categories, matching directory names', () => {
    expect(FEEDBACK_CATEGORIES).toEqual(['bugs', 'proposals'])
  })
})
