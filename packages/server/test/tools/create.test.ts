import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCreateNode,
  handleCreateTree,
} from '@figma-agent-bridge/server/tools/create'

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

describe('handleCreateNode', () => {
  it('returns error when not connected', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Test',
          size: [100, 100],
        },
      },
      client,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('sends create_node command with parsed fills', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:1',
          name: 'Card BG',
          type: 'RECTANGLE',
        }
      }
      return null
    })

    const result = await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Card BG',
          size: [320, 200],
          fills: ['#3B82F6'],
          radius: 8,
        },
      },
      client,
    )

    expect(result.content[0].text).toContain('99:1')
    expect(sentParams.node).toBeDefined()
    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('RECTANGLE')
    // Fills should be parsed from expression to paint objects
    const fills = node.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID')
  })

  it('sends create_node with parsed effects', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:2',
          name: 'Shadow Box',
          type: 'FRAME',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Shadow Box',
          size: [200, 200],
          effects: ['shadow(0,4,8,#00000040)'],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const effects = node.effects as { type: string }[]
    expect(effects[0].type).toBe('DROP_SHADOW')
  })

  it('sends create_node with parsed text properties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:3', name: 'Title', type: 'TEXT' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'TEXT',
          name: 'Title',
          size: [200, 24],
          text: {
            content: 'Hello World',
            font: 'Inter/SemiBold/18',
            color: '#1A1A1A',
            lineHeight: '24px',
            letterSpacing: '0.5px',
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const text = node.text as Record<string, unknown>
    expect(text.content).toBe('Hello World')
    const font = text.font as {
      family: string
      style: string
      size: number
    }
    expect(font.family).toBe('Inter')
    expect(font.style).toBe('SemiBold')
    expect(font.size).toBe(18)
    const lineHeight = text.lineHeight as {
      value: number
      unit: string
    }
    expect(lineHeight.value).toBe(24)
    expect(lineHeight.unit).toBe('PIXELS')
  })

  it('sends create_node with layout properties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:4', name: 'Row', type: 'FRAME' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Row',
          size: [400, 50],
          layout: {
            mode: 'H',
            spacing: 16,
            padding: [8, 16, 8, 16],
            align: ['MIN', 'CENTER'],
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.layout).toBeDefined()
  })

  it('sends create_node with counterAxisAlignContent and sizing modes', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:40', name: 'Grid', type: 'FRAME' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Grid',
          size: [400, 300],
          layout: {
            mode: 'H',
            spacing: 8,
            padding: [8, 8, 8, 8],
            align: ['MIN', 'MIN'],
            wrap: true,
            counterAxisAlignContent: 'SPACE_BETWEEN',
            primaryAxisSizingMode: 'AUTO',
            counterAxisSizingMode: 'FIXED',
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const layout = node.layout as Record<string, unknown>
    expect(layout.counterAxisAlignContent).toBe(
      'SPACE_BETWEEN',
    )
    expect(layout.primaryAxisSizingMode).toBe('AUTO')
    expect(layout.counterAxisSizingMode).toBe('FIXED')
  })

  it('sends create_node with gradient fill', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:5',
          name: 'Gradient',
          type: 'RECTANGLE',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Gradient',
          size: [400, 300],
          fills: [
            'linear-gradient(90deg, #FF0000 0%, #0000FF 100%)',
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const fills = node.fills as { type: string }[]
    expect(fills[0].type).toBe('GRADIENT_LINEAR')
  })

  it('sends create_node with image fill from URL', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:30',
          name: 'Photo',
          type: 'RECTANGLE',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Photo',
          size: [400, 300],
          fills: [
            'image(https://example.com/photo.jpg,FIT)',
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const fills = node.fills as {
      type: string
      imageUrl?: string
      scaleMode?: string
    }[]
    expect(fills[0].type).toBe('IMAGE')
    expect(fills[0].imageUrl).toBe(
      'https://example.com/photo.jpg',
    )
    expect(fills[0].scaleMode).toBe('FIT')
  })

  it('sends create_node with image fill from hash', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:31',
          name: 'Cached',
          type: 'RECTANGLE',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Cached',
          size: [200, 200],
          fills: ['image-hash(abc123def)'],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const fills = node.fills as {
      type: string
      imageHash?: string
    }[]
    expect(fills[0].type).toBe('IMAGE')
    expect(fills[0].imageHash).toBe('abc123def')
  })

  it('sends per-corner radius', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:6',
          name: 'Rounded',
          type: 'RECTANGLE',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Rounded',
          size: [100, 100],
          radius: [8, 8, 0, 0],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.radius).toEqual([8, 8, 0, 0])
  })

  it('sends ELLIPSE with arcData', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:7', name: 'Arc', type: 'ELLIPSE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'ELLIPSE',
          name: 'Arc',
          size: [100, 100],
          arcData: {
            startingAngle: 0,
            endingAngle: 3.14,
            innerRadius: 0.5,
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.arcData).toEqual({
      startingAngle: 0,
      endingAngle: 3.14,
      innerRadius: 0.5,
    })
  })

  it('sends STAR with pointCount and innerRadius', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:8', name: 'Star', type: 'STAR' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'STAR',
          name: 'Star',
          size: [100, 100],
          pointCount: 5,
          innerRadius: 0.4,
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.pointCount).toBe(5)
    expect(node.innerRadius).toBe(0.4)
  })

  it('sends TEXT_PATH with vectorNodeId', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:20',
          name: 'Path Text',
          type: 'TEXT_PATH',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'TEXT_PATH',
          name: 'Path Text',
          size: [200, 50],
          vectorNodeId: '3:15',
          startSegment: 0,
          startPosition: 0.1,
          text: {
            content: 'Along the path',
            font: 'Inter/Regular/14',
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('TEXT_PATH')
    expect(node.vectorNodeId).toBe('3:15')
    expect(node.startSegment).toBe(0)
    expect(node.startPosition).toBe(0.1)
  })

  it('sends INSTANCE with component key and properties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return {
          id: '99:9',
          name: 'Button',
          type: 'INSTANCE',
        }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'INSTANCE',
          name: 'Button',
          size: [120, 40],
          component: {
            key: 'abc123',
            properties: { Label: 'Click me' },
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.component).toEqual({
      key: 'abc123',
      properties: { Label: 'Click me' },
    })
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

    const result = await handleCreateNode(
      {
        parentId: '1:2',
        node: { type: 'FRAME', name: 'X', size: [10, 10] },
      },
      client,
    )

    expect(result.content[0].text).toBe(
      'Error: plugin exploded',
    )
  })
})

describe('handleCreateTree', () => {
  it('sends create_tree command with nested children', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:10', name: 'Card', type: 'FRAME' }
      }
      return null
    })

    const result = await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Card',
          size: [320, 200],
          fills: ['#FFFFFF'],
          children: [
            {
              type: 'TEXT',
              name: 'Title',
              size: [288, 24],
              text: {
                content: 'Hello',
                font: 'Inter/Bold/18',
              },
            },
          ],
        },
      },
      client,
    )

    expect(result.content[0].text).toContain('99:10')
    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('FRAME')
    const children = node.children as Record<
      string,
      unknown
    >[]
    expect(children).toHaveLength(1)
    expect(children[0].type).toBe('TEXT')
  })

  it('passes clone reference { id } through unchanged', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return {
          id: '99:11',
          name: 'Container',
          type: 'FRAME',
        }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Container',
          size: [400, 200],
          children: [{ id: '5:99' }],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const children = node.children as Record<
      string,
      unknown
    >[]
    expect(children[0]).toEqual({ id: '5:99' })
  })

  it('parses expressions recursively in children', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:12', name: 'Row', type: 'FRAME' }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Row',
          size: [400, 100],
          children: [
            {
              type: 'RECTANGLE',
              name: 'Box',
              size: [100, 100],
              fills: ['#FF0000'],
              effects: ['shadow(0,2,4,#000000)'],
            },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const children = node.children as Record<
      string,
      unknown
    >[]
    const box = children[0]
    const fills = box.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID')
    const effects = box.effects as { type: string }[]
    expect(effects[0].type).toBe('DROP_SHADOW')
  })

  it('sends GROUP type through to plugin', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return {
          id: '99:13',
          name: 'Icon Group',
          type: 'GROUP',
        }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'GROUP',
          name: 'Icon Group',
          size: [100, 100],
          children: [
            {
              type: 'ELLIPSE',
              name: 'Circle',
              size: [50, 50],
            },
            {
              type: 'RECTANGLE',
              name: 'Square',
              size: [50, 50],
            },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('GROUP')
  })

  it('sends TRANSFORM_GROUP with modifiers', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return {
          id: '99:21',
          name: 'Rotated Group',
          type: 'TRANSFORM_GROUP',
        }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'TRANSFORM_GROUP',
          name: 'Rotated Group',
          size: [100, 100],
          modifiers: { rotation: 45 },
          children: [
            {
              type: 'RECTANGLE',
              name: 'Inner',
              size: [50, 50],
            },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('TRANSFORM_GROUP')
    expect(node.modifiers).toEqual({ rotation: 45 })
  })

  it('sends BOOLEAN_OPERATION with operation type', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return {
          id: '99:14',
          name: 'Union',
          type: 'BOOLEAN_OPERATION',
        }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'BOOLEAN_OPERATION',
          name: 'Union',
          size: [100, 100],
          booleanOperation: 'UNION',
          children: [
            {
              type: 'RECTANGLE',
              name: 'A',
              size: [100, 100],
            },
            { type: 'ELLIPSE', name: 'B', size: [80, 80] },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('BOOLEAN_OPERATION')
    expect(node.booleanOperation).toBe('UNION')
  })
})
