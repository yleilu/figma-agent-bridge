// e2e-components.test.ts — M3 chunk B components & instances tools over the REAL
// relay with the mock plugin (headless, CI). Same startRelay + createMockPlugin +
// createFigmaClient pattern as the other integration suites, so no Figma is
// needed. Asserts on the mock echo of the CONVERTED params (Figma objects, not
// atom strings) and on the T7 degrade paths (warnings on success, never error).
//
// Covers:
//   - create_component PROMOTE-ONLY from a node id (sourceNodeId echoed; the
//     build-from-spec overload was removed per spec).
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
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
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
const FK = 'fk-components'

describe('M3 components tools e2e (mock plugin over real relay)', () => {
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
      documentName: 'Components Doc',
      pageName: 'Main',
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

  it('create_component PROMOTE-ONLY from a node id (sourceNodeId echoed; key set)', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:5', name: 'Promoted' },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT')
    expect(data.key).toBeDefined()
    expect(data.id).toBeDefined()
    expect(data.sourceNodeId).toBe('1:5')
  })

  it('combine_variants produces a COMPONENT_SET and returns its key (C1)', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'c:2'] },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
    expect(data.variantAxes).toBeDefined()
    expect(data.id).toBeDefined()
    // C1: the set's key is returned (read/write symmetry).
    expect(data.key).toBeDefined()
  })

  // C1: the multi-axis variant-name warning surfaces on SUCCESS — source names
  // lacking the "Property=Value" axis convention (modeled by `noaxis:` ids).
  it('combine_variants warns when names do not form a clean axis set (C1)', async () => {
    const result = await handleCombineVariants(
      {
        componentIds: ['noaxis:c1', 'noaxis:c2'],
      },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
    const warnings = data.warnings as string[]
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('clean axis set')
  })

  it('combine_variants reports dropped invalid ids as a warning (honest partial success)', async () => {
    // 3 ids, 1 invalid (`bad:`): the 2 valid ones still combine AND the drop is
    // named in warnings — never silently swallowed.
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'bad:9', 'c:2'] },
      scoped,
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
      scoped,
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
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('at least 2')
  })

  // The genuine plugin-side {error} boundary: the handler's raw-length <2 guard
  // PASSES 2 ids, but the plugin drops the invalid `bad:` id leaving 1 survivor
  // → {error:'Need at least 2 components'}. Distinct from the handler guard
  // above (which never sends the command).
  it('combine_variants surfaces a plugin {error} when dropping invalids leaves <2 survivors', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'bad:9'] },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('at least 2')
  })

  it('set_instance echo is SPLIT into the read-twin shape (C3 / T2)', async () => {
    const result = await handleSetInstance(
      {
        instanceId: 'i:1',
        properties: { Size: 'Large', Disabled: true },
      },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('i:1')
    // The plugin (mock) echoes the RAW Figma NESTED componentProperties; the
    // SERVER splits it into the SAME { variantProperties, componentProperties }
    // shape get_node emits — VARIANT → variantProperties (flat string),
    // BOOLEAN/TEXT → componentProperties (raw value). Exact READ-twin round-trip.
    expect(data.variantProperties).toEqual({
      Size: 'Large',
    })
    expect(data.componentProperties).toEqual({
      Disabled: true,
    })
    expect(Array.isArray(data.warnings)).toBe(true)
    expect((data.warnings as unknown[]).length).toBe(0)
  })

  // #11: a friendly property NAME ("Label") resolves to the EXACT key
  // setProperties needs ("Label#1:0"); the resolved key is what gets written
  // and echoed back (no warnings). The server's read-twin split keys by the raw
  // Figma key, so the resolved "Label#1:0" key surfaces verbatim — proving the
  // friendly name was upgraded to the exact key before setProperties.
  it('set_instance resolves a friendly property name to its exact key', async () => {
    const result = await handleSetInstance(
      { instanceId: 'i:1', properties: { Label: 'Hi' } },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    // String value → VARIANT bucket in the mock's type inference; the KEY is the
    // resolved exact key "Label#1:0", NOT the friendly "Label" that was passed.
    expect(data.variantProperties).toEqual({
      'Label#1:0': 'Hi',
    })
    expect((data.warnings as unknown[]).length).toBe(0)
  })

  // #11: an unknown property name warns and is skipped (no setProperties write).
  it('set_instance warns and skips an unknown property name', async () => {
    const result = await handleSetInstance(
      { instanceId: 'i:1', properties: { Ghost: 'x' } },
      scoped,
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    const warnings = data.warnings as string[]
    expect(
      warnings.some(w =>
        w.includes("no component property named 'Ghost'"),
      ),
    ).toBe(true)
  })

  // T7: a pure-read set_instance call (no properties, no overrides) mutates
  // nothing — it must WARN rather than return a silent no-op success that an
  // agent reads as a successful write.
  it('set_instance warns on a no-op call (no properties, no overrides)', async () => {
    const result = await handleSetInstance(
      { instanceId: 'i:1' },
      scoped,
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
      scoped,
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
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.mainComponent).toBe('c:7')
    expect((data.warnings as unknown[]).length).toBe(0)
  })

  // C2: remote-by-key. The plugin imports the component via
  // importComponentByKeyAsync, then swaps to the imported main.
  it('swap_component REMOTE-by-key imports then swaps', async () => {
    const result = await handleSwapComponent(
      { instanceId: 'i:1', key: 'remote-btn-key' },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.mainComponent).toBe(
      'imported:remote-btn-key',
    )
    expect((data.warnings as unknown[]).length).toBe(0)
  })

  // C2 + T7: a FAILED importComponentByKeyAsync degrades — warning on success,
  // NEVER {error}.
  it('swap_component REMOTE-by-key degrades (T7) when the import fails', async () => {
    const result = await handleSwapComponent(
      { instanceId: 'i:1', key: 'importfail:nope' },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.mainComponent).toBeNull()
    const warnings = data.warnings as string[]
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(
      'importComponentByKeyAsync failed',
    )
  })

  // C2: LOCAL wins when BOTH a local id and a key are given.
  it('swap_component prefers LOCAL mainComponentId when both are given', async () => {
    const result = await handleSwapComponent(
      {
        instanceId: 'i:1',
        mainComponentId: 'c:local',
        key: 'remote-key',
      },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.mainComponent).toBe('c:local')
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
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.id).toBe('c:1')
    // The catalogue return key is `properties` — an ARRAY of
    // {id,name,type,defaultValue,variantOptions?}. Each entry's `id` is the
    // CANONICAL property id (e.g. "Label#1:0") agents need for later
    // setProperties, so it carries the added id WITHIN the shape (no separate
    // `added` array).
    const properties = data.properties as {
      id: string
      name: string
      type: string
      defaultValue: string | boolean
    }[]
    expect(Array.isArray(properties)).toBe(true)
    const label = properties.find(p => p.name === 'Label')!
    expect(label).toBeDefined()
    expect(label.id).toContain('Label#')
    expect(label.type).toBe('TEXT')
    // B3: 2 warnings now: the expose degrade + the unbound-property warning
    // (no targetNodeId given for Label). The unbound warning is the T7 fix
    // that turns the silent trap into an honest signal.
    const warnings = data.warnings as string[]
    expect(warnings.length).toBe(2)
    expect(
      warnings.some(w =>
        w.includes('exposeNestedInstances'),
      ),
    ).toBe(true)
    expect(warnings.some(w => w.includes('unbound'))).toBe(
      true,
    )
  })

  // B3: the unbound-targetNodeId warning surfaces on SUCCESS when targetNodeId
  // is absent, turning the old silent trap into an honest T7 warning.
  it('B3: add without targetNodeId emits honest unbound warning (T7)', async () => {
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
      },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    const warnings = data.warnings as string[]
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(
      warnings.some(
        w =>
          w.includes('unbound') &&
          w.includes('set_instance will be inert'),
      ),
    ).toBe(true)
  })

  // B3: add WITH targetNodeId+field does NOT emit the unbound warning.
  it('B3: add with targetNodeId+field does not emit the unbound warning', async () => {
    const result = await handleUpdateComponent(
      {
        componentId: 'c:1',
        add: [
          {
            name: 'Label',
            type: 'TEXT',
            defaultValue: 'Hi',
            targetNodeId: '2:5',
            field: 'characters',
          },
        ],
      },
      scoped,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    const warnings = data.warnings as string[]
    expect(warnings.some(w => w.includes('unbound'))).toBe(
      false,
    )
  })

  // Genuine T7 {error} boundary #1: an unresolvable componentId is a not-found
  // error (distinct from a degrade) — surfaced as 'Error:', not a warning.
  it('update_component surfaces a {error} when the component is not found', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'err:gone' },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Component not found',
    )
  })

  // Genuine T7 {error} boundary #2: a node that resolves but is NOT a component
  // / component set is an invalid-target error, not a degrade.
  it('update_component surfaces a {error} when the node is not a component', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'notcomp:1' },
      scoped,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'not a component',
    )
  })
})
