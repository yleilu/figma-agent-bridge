import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleConnect } from '@figma-agent-bridge/server/tools/session'
import {
  handleCreateNode,
  handleCreateTree,
} from '@figma-agent-bridge/server/tools/create'
import { handleCreateComponent } from '@figma-agent-bridge/server/tools/create-component'
import { handleCreateFromSvg } from '@figma-agent-bridge/server/tools/create-svg'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3099
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-create-test'

describe('M3 create tools e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)

    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Create Test Doc',
      pageName: 'Main Page',
    })

    await plugin.start()
    await handleConnect({ channel: TEST_CHANNEL }, client)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('create_node creates a RECTANGLE', async () => {
    const result = await handleCreateNode(
      {
        parentId: 'page:1',
        node: {
          type: 'RECTANGLE',
          name: 'Test Rect',
          size: [200, 100],
          fills: ['#3B82F6'],
          radius: 8,
        },
      },
      client,
    )

    expect(result.content).toHaveLength(1)
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('RECTANGLE')
    expect(data.name).toBe('Test Rect')
    expect(data.id).toBeDefined()
  })

  it('create_node creates a TEXT node', async () => {
    const result = await handleCreateNode(
      {
        parentId: 'page:1',
        node: {
          type: 'TEXT',
          name: 'Title',
          size: [300, 32],
          text: {
            content: 'Hello World',
            font: 'Inter/Bold/24',
            color: '#000000',
          },
        },
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('TEXT')
  })

  it('create_tree creates a frame with children', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        node: {
          type: 'FRAME',
          name: 'Card',
          size: [320, 200],
          layout: {
            mode: 'V',
            spacing: 12,
            padding: [16, 16, 16, 16],
            align: ['MIN', 'MIN'],
          },
          fills: ['#FFFFFF'],
          effects: ['shadow(0,4,8,#00000040)'],
          children: [
            {
              type: 'TEXT',
              name: 'Title',
              size: [288, 24],
              text: {
                content: 'Card Title',
                font: 'Inter/SemiBold/18',
                color: '#1A1A1A',
              },
            },
            {
              type: 'RECTANGLE',
              name: 'Divider',
              size: [288, 1],
              fills: ['#E5E5E5'],
            },
          ],
        },
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('FRAME')
    expect(data.name).toBe('Card')
    expect(data.totalNodes).toBe(3) // Card + Title + Divider
  })

  it('create_component promotes a node', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT')
    expect(data.key).toBeDefined()
  })

  it('create_component combines as variants', async () => {
    const result = await handleCreateComponent(
      {
        nodeIds: ['1:42', '1:43'],
        combineAsVariants: true,
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
  })

  it('create_from_svg creates a frame from SVG', async () => {
    const result = await handleCreateFromSvg(
      {
        parentId: 'page:1',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 2L2 22h20z"/></svg>',
        name: 'Triangle',
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('FRAME')
    expect(data.name).toBe('Triangle')
    expect(data.childCount).toBeGreaterThan(0)
  })

  it('create_tree with gradient fills', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        node: {
          type: 'RECTANGLE',
          name: 'Gradient BG',
          size: [400, 300],
          fills: [
            'linear-gradient(135deg, #FF6B6B 0%, #4ECDC4 100%)',
          ],
        },
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('RECTANGLE')
  })

  it('create_component returns warning when createSlot unavailable', async () => {
    const result = await handleCreateComponent(
      {
        nodeId: '1:2',
        slots: ['Content'],
      },
      client,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.warning).toBeDefined()
    expect(parsed.warning as string).toContain('createSlot')
  })

  it('creates SECTION node ignoring unsupported fills gracefully', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        node: {
          type: 'SECTION',
          name: 'Test Section',
          size: [400, 300],
          fills: ['#FF0000'],
        },
      },
      client,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.type).toBe('SECTION')
    expect(parsed.name).toBe('Test Section')
  })

  it('create_node returns error when not connected', async () => {
    client.disconnect()

    const result = await handleCreateNode(
      {
        parentId: 'page:1',
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
})
