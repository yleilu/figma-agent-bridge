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
import { transformToAngle } from '@figma-agent-bridge/server/grammar'
import { handleConnect } from '@figma-agent-bridge/server/tools/session'
// create_node and create_component were rebuilt on NodeSpec (M3 chunks A/B);
// their handlers live in tools/create-node.ts and tools/components.ts and are
// covered by create-node.test.ts / e2e-slice.test.ts and components.test.ts /
// e2e-components.test.ts. The legacy tools/create.ts and tools/create-component.ts
// were retired in M3-E. This file keeps the create_tree / create_from_svg e2e
// (their handlers live in tools/create-tree.ts and tools/create-svg.ts).
import { handleCreateNode } from '@figma-agent-bridge/server/tools/create-node'
import { handleCreateTree } from '@figma-agent-bridge/server/tools/create-tree'
import { handleCreateFromSvg } from '@figma-agent-bridge/server/tools/create-svg'
import {
  handleDeleteNode,
  handleSetFocus,
} from '@figma-agent-bridge/server/tools/structure'
import {
  handleCreatePage,
  handleSetCurrentPage,
  handleDuplicatePage,
} from '@figma-agent-bridge/server/tools/pages'
import { handleCreateImage } from '@figma-agent-bridge/server/tools/create-image'
import {
  handleSetPluginData,
  handleSetReactions,
  handleSetAnnotations,
} from '@figma-agent-bridge/server/tools/metadata'
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

  it('create_tree creates a frame with nested children (NodeSpec contract)', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        tree: {
          type: 'FRAME',
          name: 'Card',
          size: [320, 200],
          layout: {
            mode: 'V',
            gap: 12,
            pad: [16, 16, 16, 16],
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
                font: 'font(Inter,SemiBold,18)',
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

    // The converted nested structure reached the (mock) plugin: a FRAME with
    // two converted children, fills parsed to a SOLID paint, layout mapped to
    // the plugin's spacing/padding shape.
    const children = data.children as Record<
      string,
      unknown
    >[]
    expect(children).toHaveLength(2)
    expect(children[0].type).toBe('TEXT')
    expect(children[1].type).toBe('RECTANGLE')
    const fills = data.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID')
    const layout = data.layout as { spacing: number }
    expect(layout.spacing).toBe(12)
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

  it('create_tree echoes serialized gradient fill (angle + stops) back from plugin', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        tree: {
          type: 'RECTANGLE',
          name: 'Gradient BG',
          size: [400, 300],
          // New atom grammar: linear(angle, color@pos, …).
          fills: ['linear(135, #FF6B6B@0, #4ECDC4@100)'],
        },
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('RECTANGLE')

    // The mock echoes the converted params, so a serialization regression
    // (dropped stops, wrong angle) is visible here. The grammar emits a
    // GRADIENT_LINEAR with normalized stops (positions 0..1) and a
    // gradientTransform encoding the angle (feedback_gradient_tests).
    const fills = data.fills as {
      type: string
      gradientTransform: [
        [number, number, number],
        [number, number, number],
      ]
      gradientStops: {
        position: number
        color: {
          r: number
          g: number
          b: number
          a: number
        }
      }[]
    }[]
    expect(fills).toHaveLength(1)
    expect(fills[0].type).toBe('GRADIENT_LINEAR')
    expect(
      transformToAngle(fills[0].gradientTransform),
    ).toBe(135)
    expect(fills[0].gradientStops).toHaveLength(2)
    expect(fills[0].gradientStops[0].position).toBe(0)
    expect(fills[0].gradientStops[0].color.r).toBeCloseTo(
      1,
      2,
    ) // #FF -> 1.0
    expect(fills[0].gradientStops[1].position).toBe(1)
    expect(fills[0].gradientStops[1].color.b).toBeCloseTo(
      0.769,
      2,
    ) // #C4 -> 0.769
  })

  it('create_node creates a SECTION node ignoring unsupported fills gracefully', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: {
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
})

// M2 chunk D — simple single-target writes over the REAL relay + mock plugin.
const D_TEST_PORT = 3102
const D_RELAY_URL = `ws://localhost:${D_TEST_PORT}`
const D_TEST_CHANNEL = 'e2e-chunk-d-test'

describe('M2 chunk D writes e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(D_TEST_PORT)
    client = createFigmaClient(D_RELAY_URL)

    plugin = createMockPlugin({
      relayUrl: D_RELAY_URL,
      channel: D_TEST_CHANNEL,
      documentName: 'Chunk D Doc',
      pageName: 'Main Page',
    })

    await plugin.start()
    await handleConnect({ channel: D_TEST_CHANNEL }, client)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('delete_node echoes the deleted {id,name,type}', async () => {
    const result = await handleDeleteNode(
      { nodeId: '1:42' },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('1:42')
    expect(data.type).toBe('FRAME')
  })

  it('set_focus echoes a viewport snapshot', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:42'] },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      viewport: { zoom: number }
    }
    expect(data.viewport.zoom).toBe(1)
  })

  // T7: an unresolved id is surfaced as a warning, not silently dropped. The
  // mock mirrors the real plugin's resolution (an id prefixed `missing:` does
  // not resolve to a scene node) and reports requested/focused/warnings.
  it('set_focus warns about (and reports) ids that do not resolve', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:42', 'missing:1'] },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(result.content[0].text) as {
      requested: number
      focused: number
      warnings: string[]
    }
    expect(data.requested).toBe(2)
    expect(data.focused).toBe(1)
    expect(
      data.warnings.some(w => w.includes('missing:1')),
    ).toBe(true)
  })

  // T7: when NOTHING resolves, set_focus must still warn (not a hallucinated
  // success with an unchanged viewport and zero signal).
  it('set_focus warns when no id resolves (focused:0)', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['missing:1', 'missing:2'] },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      requested: number
      focused: number
      warnings: string[]
    }
    expect(data.focused).toBe(0)
    expect(data.warnings.length).toBeGreaterThan(0)
    expect(
      data.warnings.some(w => w.includes('missing:1')),
    ).toBe(true)
  })

  it('create_page echoes the new page id + name', async () => {
    const result = await handleCreatePage(
      { name: 'Specs' },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('page:new')
    expect(data.name).toBe('Specs')
  })

  it('set_current_page echoes the switched page', async () => {
    const result = await handleSetCurrentPage(
      { pageId: 'page:2' },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      currentPage: { id: string }
    }
    expect(data.currentPage.id).toBe('page:2')
  })

  it('duplicate_page echoes the clone with rename', async () => {
    const result = await handleDuplicatePage(
      { pageId: 'page:1', name: 'Copy A' },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('page:dup')
    expect(data.name).toBe('Copy A')
  })

  it('create_image (url) returns a hash', async () => {
    const result = await handleCreateImage(
      { url: 'https://x/y.png' },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.hash).toBe('img:abc123')
  })

  it('create_image T7 degrade (degrade: url) → warnings, success NOT error', async () => {
    const result = await handleCreateImage(
      { url: 'degrade:nope' },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      hash?: string
      warnings?: string[]
    }
    expect(data.hash).toBeUndefined()
    expect(data.warnings).toBeDefined()
    expect(result.content[0].text).not.toContain('Error:')
  })

  it('create_image T7 degrade (bytes path) → warnings, success NOT error', async () => {
    const result = await handleCreateImage(
      { bytes: [] },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      hash?: string
      warnings?: string[]
    }
    expect(data.hash).toBeUndefined()
    expect(data.warnings).toBeDefined()
    expect(result.content[0].text).not.toContain('Error:')
  })

  it('set_plugin_data echoes {id}', async () => {
    const result = await handleSetPluginData(
      { nodeId: '1:42', key: 'k', value: 'v' },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      id: string
    }
    expect(data.id).toBe('1:42')
  })

  it('set_reactions echoes {id,warnings:[]} on the happy path', async () => {
    const result = await handleSetReactions(
      { nodeId: '1:42', reactions: [] },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(data.id).toBe('1:42')
    expect(data.warnings).toEqual([])
  })

  it('set_reactions T7 degrade (degrade: nodeId) → warnings, success NOT error', async () => {
    const result = await handleSetReactions(
      { nodeId: 'degrade:1', reactions: [] },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(data.warnings).toHaveLength(1)
    expect(result.content[0].text).not.toContain('Error:')
  })

  it('set_annotations T7 degrade (degrade: nodeId) → warnings, success NOT error', async () => {
    const result = await handleSetAnnotations(
      { nodeId: 'degrade:1', annotations: [] },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(data.warnings).toHaveLength(1)
    expect(result.content[0].text).not.toContain('Error:')
  })
})
