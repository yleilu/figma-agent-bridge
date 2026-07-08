import { describe, expect, it } from 'bun:test'
import type { ChannelInfo } from '@figma-agent-bridge/shared/types'

describe('ChannelInfo fileKey', () => {
  it('carries a fileKey (string | null)', () => {
    const saved: ChannelInfo = {
      channel: 'ch1',
      fileName: 'Design File',
      fileKey: 'FILEKEY123',
      connectedAt: Date.now(),
    }
    expect(saved.fileKey).toBe('FILEKEY123')

    const unsaved: ChannelInfo = {
      channel: 'ch2',
      fileName: null,
      fileKey: null,
      connectedAt: Date.now(),
    }
    expect(unsaved.fileKey).toBeNull()
  })
})
