// e2e-components.test.ts — M3 chunk B components & instances tools over the REAL
// relay with the mock plugin (headless, CI). Same startRelay + createMockPlugin +
// createFigmaClient pattern as the other integration suites, so no Figma is
// needed. Asserts on the mock echo of the CONVERTED params (Figma objects, not
// atom strings) and on the T7 degrade paths (warnings on success, never error).
//
// Covers:
//   - create_component from a NodeSpec (server parsed the atom → SOLID; key set).
//   - create_component from a node id (promotion path; sourceNodeId echoed).
//   - combine_variants → COMPONENT_SET (+ handler <2 guard).
//   - set_instance setProperties round-trip.
//   - swap_component T7 degrade (warning on success).
//   - update_component add property + expose degrade (warning on success).

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
  handleCreateComponent,
  handleUpdateComponent,
  handleCombineVariants,
  handleSwapComponent,
  handleSetInstance,
} from '@figma-agent-bridge/server/tools/components'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3104
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-components-test'

describe('M3 components tools e2e (mock plugin over real relay)', () => {
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
      documentName: 'Components Doc',
      pageName: 'Main',
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

  it('create_component from a NodeSpec returns a key (atom parsed server-side)', async () => {
    const result = await handleCreateComponent(
      {
        spec: {
          type: 'FRAME',
          name: 'Card',
          size: [200, 100],
          fills: ['#3B82F6'],
        },
      },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT')
    expect(data.key).toBeDefined()
    expect(data.id).toBeDefined()
    // The mock echoes the converted spec — proof the server parsed the atom.
    const spec = data.spec as {
      fills: { type: string }[]
    }
    expect(spec.fills[0].type).toBe('SOLID')
  })

  it('create_component from a node id promotes (sourceNodeId echoed)', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:5', name: 'Promoted' },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT')
    expect(data.key).toBeDefined()
    expect(data.sourceNodeId).toBe('1:5')
  })

  it('combine_variants produces a COMPONENT_SET', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'c:2'] },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
    expect(data.variantAxes).toBeDefined()
    expect(data.id).toBeDefined()
  })

  it('combine_variants reports dropped invalid ids as a warning (honest partial success)', async () => {
    // 3 ids, 1 invalid (`bad:`): the 2 valid ones still combine AND the drop is
    // named in warnings — never silently swallowed.
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'bad:9', 'c:2'] },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
    const warnings = data.warnings as string[]
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('bad:9')
  })

  it('combine_variants warns when the requested parent cannot bear children (silent fallback fixed)', async () => {
    // A `nogood:` parent can't contain the variant set; the plugin falls back
    // to the first component's parent but must REPORT that, not swallow it.
    const result = await handleCombineVariants(
      {
        componentIds: ['c:1', 'c:2'],
        parentId: 'nogood:p',
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
    const warnings = data.warnings as string[]
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('nogood:p')
  })

  it('combine_variants guards <2 in the handler (no command sent)', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1'] },
      client,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('at least 2')
  })

  it('set_instance sets properties', async () => {
    const result = await handleSetInstance(
      {
        instanceId: 'i:1',
        properties: { Size: 'Large', Disabled: true },
      },
      client,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('i:1')
    const props = data.componentProperties as Record<
      string,
      unknown
    >
    expect(props.Size).toBe('Large')
    expect(Array.isArray(data.warnings)).toBe(true)
    expect((data.warnings as unknown[]).length).toBe(0)
  })

  // T7: a pure-read set_instance call (no properties, no overrides) mutates
  // nothing — it must WARN rather than return a silent no-op success that an
  // agent reads as a successful write.
  it('set_instance warns on a no-op call (no properties, no overrides)', async () => {
    const result = await handleSetInstance(
      { instanceId: 'i:1' },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    const warnings = data.warnings as string[]
    expect(
      warnings.some(
        w =>
          w.toLowerCase().includes('nothing') ||
          w.toLowerCase().includes('no properties'),
      ),
    ).toBe(true)
  })

  it('swap_component degrades (T7) — warning on success, reports the ORIGINAL main', async () => {
    // A genuinely-failed swap leaves the instance on its ORIGINAL main: the
    // real plugin re-reads getMainComponentAsync() (the original), so the mock
    // must echo the original main, NOT the requested target ('c:9').
    const result = await handleSwapComponent(
      { instanceId: 'degrade:i9', mainComponentId: 'c:9' },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    const warnings = data.warnings as string[]
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('swapComponent failed')
    expect(data.mainComponent).not.toBe('c:9')
    expect(data.mainComponent).toBe('orig:i9')
  })

  it('swap_component happy path reports the requested TARGET main', async () => {
    const result = await handleSwapComponent(
      { instanceId: 'i:1', mainComponentId: 'c:7' },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.mainComponent).toBe('c:7')
    expect((data.warnings as unknown[]).length).toBe(0)
  })

  it('update_component adds a property and degrades on expose (T7)', async () => {
    const result = await handleUpdateComponent(
      {
        componentId: 'c:1',
        add: [
          {
            name: 'Label',
            type: 'TEXT',
            defaultValue: 'Hi',
          },
        ],
        expose: ['i:nested'],
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('c:1')
    const defs = data.propertyDefinitions as Record<
      string,
      unknown
    >
    // componentPropertyDefinitions is keyed by the CANONICAL id (e.g.
    // "Label#1:0"), not the bare name — that is the ground-truth return.
    expect(defs['Label#1:0']).toBeDefined()
    expect((data.warnings as unknown[]).length).toBe(1)
    // The canonical property id (e.g. "Label#1:0") that agents need for later
    // setProperties is surfaced, not discarded.
    const added = data.added as {
      name: string
      id: string
    }[]
    expect(Array.isArray(added)).toBe(true)
    expect(added).toHaveLength(1)
    expect(added[0].name).toBe('Label')
    expect(added[0].id).toContain('Label#')
  })
})
