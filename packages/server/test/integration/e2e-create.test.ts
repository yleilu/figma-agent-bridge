import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import YAML from 'yaml'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { transformToAngle } from '@figma-agent-bridge/server/grammar'
import { handleGetNode } from '@figma-agent-bridge/server/tools/read'
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
const FK = 'fk-create'

describe('M3 create tools e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let scoped: ScopedFigmaClient
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
      fileKey: FK,
    })

    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
    scoped = client.forFile(FK)
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
      scoped,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    // tool-surface: create_tree answers {root, ids[]} — the root's identity
    // under `root`, and one id per node it created (Card + Title + Divider).
    expect(data.root).toEqual({
      id: (data.ids as string[])[0],
      name: 'Card',
      type: 'FRAME',
    })
    expect(data.ids).toHaveLength(3)
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
      scoped,
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
      scoped,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect((data.root as { type: string }).type).toBe(
      'RECTANGLE',
    )

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
      scoped,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.type).toBe('SECTION')
    expect(parsed.name).toBe('Test Section')
  })

  // issue #4: create_node(INSTANCE) by LOCAL component id. The writer passes
  // `component` through; the plugin resolves the local main via
  // getNodeByIdAsync → createInstance() and applies `properties` verbatim
  // (exact keys; the friendly-name→name#id resolver is issue #11).
  it('create_node(INSTANCE) by local component.id round-trips the ref to the plugin', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: {
          type: 'INSTANCE',
          name: 'Button/Primary',
          component: {
            id: '2:10',
            properties: { Label: 'Save' },
          },
        },
      },
      scoped,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.type).toBe('INSTANCE')
    expect(parsed.component).toEqual({
      id: '2:10',
      properties: { Label: 'Save' },
    })
  })

  // issue #4: create_node(INSTANCE) by published KEY → importComponentByKeyAsync.
  it('create_node(INSTANCE) by component.key round-trips the ref to the plugin', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: {
          type: 'INSTANCE',
          name: 'Card',
          component: { key: 'btn-key-123' },
        },
      },
      scoped,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.type).toBe('INSTANCE')
    expect(parsed.component).toEqual({ key: 'btn-key-123' })
  })

  // issue #4: INSTANCE with no component ref → clear {error} (not a silent
  // mis-create). The plugin throws 'INSTANCE requires component.id or
  // component.key'; the mock mirrors it byte-faithfully.
  it('create_node(INSTANCE) with no component ref surfaces a clear error', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: { type: 'INSTANCE', name: 'Orphan' },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).toStartWith('Error')
    expect(text).toContain('component.id')
    expect(text).toContain('component.key')
  })

  // issue #4: an invalid by-id ref (node is not a COMPONENT/COMPONENT_SET) is a
  // clean target error, not a degrade.
  it('create_node(INSTANCE) with a non-component id surfaces a clear error', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: {
          type: 'INSTANCE',
          component: { id: 'notcomp:9' },
        },
      },
      scoped,
    )
    const { text } = result.content[0]
    expect(text).toStartWith('Error')
    expect(text).toContain('COMPONENT')
  })
})

// M2 chunk D — simple single-target writes over the REAL relay + mock plugin.
const D_TEST_PORT = 3102
const D_RELAY_URL = `ws://localhost:${D_TEST_PORT}`
const D_TEST_CHANNEL = 'e2e-chunk-d-test'
const D_FK = 'fk-create-d'

describe('M2 chunk D writes e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let scoped: ScopedFigmaClient
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
      fileKey: D_FK,
    })

    await plugin.start()
    await client.joinChannel(D_TEST_CHANNEL, D_FK)
    scoped = client.forFile(D_FK)
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
      scoped,
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
      scoped,
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
      scoped,
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
      scoped,
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
      scoped,
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
      scoped,
    )
    const data = JSON.parse(result.content[0].text) as {
      currentPage: { id: string }
    }
    expect(data.currentPage.id).toBe('page:2')
  })

  it('duplicate_page echoes the clone with rename', async () => {
    const result = await handleDuplicatePage(
      { pageId: 'page:1', name: 'Copy A' },
      scoped,
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
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.hash).toBe('img:abc123')
  })

  it('create_image T7 degrade (degrade: url) → warnings, success NOT error', async () => {
    const result = await handleCreateImage(
      { url: 'degrade:nope' },
      scoped,
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
      scoped,
    )
    const data = JSON.parse(result.content[0].text) as {
      hash?: string
      warnings?: string[]
    }
    expect(data.hash).toBeUndefined()
    expect(data.warnings).toBeDefined()
    expect(result.content[0].text).not.toContain('Error:')
    // The bytes-degrade message keeps the real plugin's `: <reason>` suffix
    // (mirrors `... unavailable): ` + String(e)) — not a bare generic message.
    expect(data.warnings?.[0]).toContain(
      'createImage failed (invalid bytes/feature unavailable): ',
    )
  })

  it('set_plugin_data echoes {id}', async () => {
    const result = await handleSetPluginData(
      { nodeId: '1:42', key: 'k', value: 'v' },
      scoped,
    )
    const data = JSON.parse(result.content[0].text) as {
      id: string
    }
    expect(data.id).toBe('1:42')
  })

  it('set_reactions echoes {id,warnings:[]} on the happy path', async () => {
    const result = await handleSetReactions(
      { nodeId: '1:42', reactions: [] },
      scoped,
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
      scoped,
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
      scoped,
    )
    const data = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(data.warnings).toHaveLength(1)
    expect(result.content[0].text).not.toContain('Error:')
  })
})

// M14 — library-instance round-trip:
// get_node on a remote instance emits component.{id,key,remote:true};
// create_node with remote:true prefers importComponentByKeyAsync (key-first).
const M14_PORT = 3108
const M14_RELAY_URL = `ws://localhost:${M14_PORT}`
const M14_CHANNEL = 'e2e-m14-test'
const M14_FK = 'fk-m14'

// Sentinel nodeId the mock uses to serve a remote-INSTANCE fixture.
// The mock's get_node handler checks cmd.params?.nodeId and returns the
// remote-instance raw export when it matches this sentinel.
const REMOTE_INSTANCE_NODE_ID = 'remote-inst:1'

describe('M14 — library-instance round-trip e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let scoped: ScopedFigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(M14_PORT)
    client = createFigmaClient(M14_RELAY_URL)

    plugin = createMockPlugin({
      relayUrl: M14_RELAY_URL,
      channel: M14_CHANNEL,
      documentName: 'M14 Test Doc',
      pageName: 'Page 1',
      fileKey: M14_FK,
    })

    await plugin.start()
    await client.joinChannel(M14_CHANNEL, M14_FK)
    scoped = client.forFile(M14_FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  // M14 READ: get_node on a remote instance emits component.{id,key,remote:true}
  // The mock serves componentId+componentKey+componentRemote:true for the sentinel nodeId.
  it('get_node on a remote instance emits component.key and component.remote:true (M14 root enrichment)', async () => {
    const result = await handleGetNode(
      { nodeId: REMOTE_INSTANCE_NODE_ID, depth: 0 },
      scoped,
    )
    expect(result.content[0].type).toBe('text')
    const parsed = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.type).toBe('INSTANCE')
    const component = parsed.component as
      | Record<string, unknown>
      | undefined
    expect(component).toBeDefined()
    expect(component?.id).toBeDefined()
    expect(component?.key).toBe('lib-btn-key-456')
    expect(component?.remote).toBe(true)
  })

  // M14 WRITE: create_node with component.remote:true and a key resolves by KEY
  // (importComponentByKeyAsync), not by id. The mock must prefer key when remote===true.
  it('create_node(INSTANCE) with component.remote:true prefers key over id', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: {
          type: 'INSTANCE',
          name: 'RemoteButton',
          component: {
            id: '2:99',
            key: 'lib-btn-key-456',
            remote: true,
          },
        },
      },
      scoped,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    // Should succeed (not an error)
    expect(result.content[0].text).not.toStartWith('Error')
    expect(parsed.type).toBe('INSTANCE')
    // The component ref should be echoed with the key (mock mirrors key-first path)
    const component = parsed.component as Record<
      string,
      unknown
    >
    expect(component?.key).toBe('lib-btn-key-456')
    // And the mock must record that it resolved by KEY (not id) when remote:true
    expect(parsed.resolvedBy).toBe('key')
  })

  // M14 WRITE: local instance (no remote) still resolves by id-first (UNCHANGED)
  it('create_node(INSTANCE) without remote flag still resolves by id (local unchanged)', async () => {
    const result = await handleCreateNode(
      {
        parentId: '0:1',
        spec: {
          type: 'INSTANCE',
          name: 'LocalButton',
          component: {
            id: '2:10',
            key: 'local-btn-key',
          },
        },
      },
      scoped,
    )
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(result.content[0].text).not.toStartWith('Error')
    // The mock must record that it resolved by id (not key) when no remote flag
    expect(parsed.resolvedBy).toBe('id')
  })
})
