import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleCreateComponent } from '@figma-agent-bridge/server/tools/create-component'

const createMockClient = (
  handler: (
    cmd: string,
    params: Record<string, unknown>,
  ) => unknown,
): FigmaClient => ({
  joinChannel: () => Promise.resolve(''),
  sendCommand: (cmd, params) =>
    Promise.resolve(handler(cmd, params ?? {})),
  disconnect: () => undefined,
  isConnected: () => true,
  currentChannel: () => 'test-ch',
})

describe('handleCreateComponent', () => {
  it('sends create_component with nodeId for promotion', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return {
          id: '1:42',
          name: 'Button',
          type: 'COMPONENT',
          key: 'key:abc',
        }
      }
      return null
    })

    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content[0].text).toContain('key:abc')
    expect(sentParams.nodeId).toBe('1:42')
  })

  it('sends create_component with combineAsVariants', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return {
          id: 'cs:1',
          name: 'Button Set',
          type: 'COMPONENT_SET',
          key: 'key:xyz',
        }
      }
      return null
    })

    const result = await handleCreateComponent(
      {
        nodeIds: ['1:42', '1:43'],
        combineAsVariants: true,
      },
      client,
    )

    expect(result.content[0].text).toContain(
      'COMPONENT_SET',
    )
    expect(sentParams.combineAsVariants).toBe(true)
    expect(sentParams.nodeIds).toEqual(['1:42', '1:43'])
  })

  it('sends create_component with slots', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return {
          id: '1:42',
          name: 'Card',
          type: 'COMPONENT',
          key: 'key:card',
        }
      }
      return null
    })

    await handleCreateComponent(
      { nodeId: '1:42', slots: ['Content', 'Footer'] },
      client,
    )

    expect(sentParams.slots).toEqual(['Content', 'Footer'])
  })

  it('sends create_component with componentProperties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return {
          id: '1:42',
          name: 'Button',
          type: 'COMPONENT',
          key: 'key:btn',
        }
      }
      return null
    })

    await handleCreateComponent(
      {
        nodeId: '1:42',
        componentProperties: [
          {
            name: 'Show Icon',
            type: 'BOOLEAN',
            default: true,
          },
          {
            name: 'Label',
            type: 'TEXT',
            default: 'Click me',
          },
        ],
      },
      client,
    )

    const props = sentParams.componentProperties as {
      name: string
      type: string
    }[]
    expect(props).toHaveLength(2)
    expect(props[0].name).toBe('Show Icon')
    expect(props[0].type).toBe('BOOLEAN')
    expect(props[1].name).toBe('Label')
  })

  it('returns error when neither nodeId nor nodeIds provided', async () => {
    const mockClient = createMockClient(() => null)
    const result = await handleCreateComponent(
      {},
      mockClient,
    )
    const { text } = result.content[0]
    expect(text).toContain('nodeId or nodeIds')
  })

  it('returns error when not connected', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content[0].text).toBe(
      'Error: plugin exploded',
    )
  })
})
