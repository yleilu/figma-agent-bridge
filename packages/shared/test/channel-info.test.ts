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

describe('ChannelInfo presence fields', () => {
  it('carries optional presence fields', () => {
    const info: ChannelInfo = {
      channel: 'file-abc',
      fileName: 'Design',
      fileKey: 'abc',
      connectedAt: 0,
      version: '0.2.0',
      currentPage: 'Icons',
      selected: 2,
      epoch: 'epoch-abc123def456',
    }
    expect(info.currentPage).toBe('Icons')
    expect(info.selected).toBe(2)
    expect(info.epoch).toBe('epoch-abc123def456')
  })
})
