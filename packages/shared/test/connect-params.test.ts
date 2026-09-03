import { describe, expect, it } from 'bun:test'
import { connectParamsSchema } from '@figma-agent-bridge/shared/schemas'

describe('connectParamsSchema', () => {
  it('accepts a channel string', () => {
    const r = connectParamsSchema.safeParse({
      channel: 'abc123',
    })
    expect(r.success).toBe(true)
  })

  it('accepts an omitted channel (auto-discovery)', () => {
    const r = connectParamsSchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.channel).toBeUndefined()
    }
  })

  it('rejects an empty channel string', () => {
    const r = connectParamsSchema.safeParse({ channel: '' })
    expect(r.success).toBe(false)
  })

  it('exposes .shape.channel for SSOT tool registration', () => {
    expect(connectParamsSchema.shape.channel).toBeDefined()
  })

  it('accepts a fileKey target', () => {
    const r = connectParamsSchema.safeParse({
      fileKey: 'abc-file-key',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a fileName target', () => {
    const r = connectParamsSchema.safeParse({
      fileName: 'My Design File',
    })
    expect(r.success).toBe(true)
  })

  it('exposes .shape.fileKey and .shape.fileName for SSOT tool registration', () => {
    expect(connectParamsSchema.shape.fileKey).toBeDefined()
    expect(connectParamsSchema.shape.fileName).toBeDefined()
  })
})
