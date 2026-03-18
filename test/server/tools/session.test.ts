import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import {
  handleConnect,
  handleStatus,
} from '../../../packages/server/src/tools/session'

describe('handleConnect', () => {
  it('returns success with channel', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve('joined test-ch'),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleConnect(
      { channel: 'test-ch' },
      mockClient,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('test-ch')
  })
})

describe('handleStatus', () => {
  it('returns disconnected when no channel', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleStatus(mockClient)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('disconnected')
  })

  it('returns connected with channel info', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () =>
        Promise.resolve('joined my-channel'),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'my-channel',
    }

    const result = await handleStatus(mockClient)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('connected')
    expect(result.content[0].text).toContain('my-channel')
  })
})
