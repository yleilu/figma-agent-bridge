// components.test.ts — M3-B write tools (create_component / update_component /
// combine_variants / swap_component / set_instance).
//
// All route through formatMutationResult: a null reply → failure text, a {error}
// reply → an error, otherwise JSON.stringify. T7-gated features DEGRADE — a reply
// carrying warnings[] surfaces on SUCCESS (NOT routed to Error). Asserts on REAL
// handler output (and, for conversion proofs, on the captured `sent` params).

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import { setInstanceParamsSchema } from '@figma-agent-bridge/shared/tool-params'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCreateComponent,
  handleUpdateComponent,
  handleCombineVariants,
  handleSwapComponent,
  handleSetInstance,
} from '@figma-agent-bridge/server/tools/components'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  connected?: boolean
  reply?: unknown
  sent?: Sent[]
}): FigmaClient => ({
  joinChannel: async () => 'ch',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleCreateComponent (promote-only, un-overloaded)', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:5' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.CREATE_COMPONENT with {nodeId,name,description} (no spec/parentId)', async () => {
    const sent: Sent[] = []
    await handleCreateComponent(
      {
        nodeId: '1:5',
        name: 'Promoted',
        description: 'A card',
      },
      stubClient({
        sent,
        reply: {
          id: 'comp:1',
          key: 'key:1',
          name: 'Promoted',
          type: 'COMPONENT',
        },
      }),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe(COMMANDS.CREATE_COMPONENT)
    expect(sent[0].params?.nodeId).toBe('1:5')
    expect(sent[0].params?.name).toBe('Promoted')
    expect(sent[0].params?.description).toBe('A card')
    // The build-from-spec overload was removed (un-overloaded per spec).
    expect(sent[0].params?.spec).toBeUndefined()
    expect(sent[0].params?.parentId).toBeUndefined()
  })

  it('emits {id,key,name,type} from the plugin reply', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:5' },
      stubClient({
        reply: {
          id: 'comp:1',
          key: 'key:1',
          name: 'Card',
          type: 'COMPONENT',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      key: string
      name: string
      type: string
    }
    expect(out).toEqual({
      id: 'comp:1',
      key: 'key:1',
      name: 'Card',
      type: 'COMPONENT',
    })
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleCreateComponent(
      { nodeId: 'nope' },
      stubClient({
        reply: { error: 'Node not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Node not found',
    )
  })
})

describe('handleUpdateComponent', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'c:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.UPDATE_COMPONENT with {componentId,add,edit,delete,description,expose}', async () => {
    const sent: Sent[] = []
    await handleUpdateComponent(
      {
        componentId: 'c:1',
        add: [
          {
            name: 'Label',
            type: 'TEXT',
            defaultValue: 'Hi',
          },
        ],
        edit: [{ name: 'Old', newName: 'New' }],
        delete: ['Gone'],
        description: 'desc',
        expose: ['i:1'],
      },
      stubClient({
        sent,
        reply: {
          id: 'c:1',
          properties: [],
          warnings: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.UPDATE_COMPONENT)
    expect(sent[0].params).toEqual({
      componentId: 'c:1',
      add: [
        { name: 'Label', type: 'TEXT', defaultValue: 'Hi' },
      ],
      edit: [{ name: 'Old', newName: 'New' }],
      delete: ['Gone'],
      description: 'desc',
      expose: ['i:1'],
    })
  })

  // The catalogue return key is `properties` (an ARRAY of
  // {id,name,type,defaultValue,variantOptions?}), NOT the raw
  // `propertyDefinitions` object map — round-trips get_components, which projects
  // the same array shape.
  it('emits {id,properties,warnings} from the reply', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'c:1' },
      stubClient({
        reply: {
          id: 'c:1',
          properties: [
            {
              id: 'Label#1:0',
              name: 'Label',
              type: 'TEXT',
              defaultValue: 'Hi',
            },
          ],
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      properties: {
        id: string
        name: string
        type: string
        defaultValue: string | boolean
      }[]
      warnings: string[]
    }
    expect(out.id).toBe('c:1')
    expect(Array.isArray(out.properties)).toBe(true)
    expect(out.properties[0].name).toBe('Label')
    expect(out.warnings).toEqual([])
    // The legacy keys are GONE (renamed to `properties`).
    expect(
      'propertyDefinitions' in
        (out as Record<string, unknown>),
    ).toBe(false)
    expect(
      'added' in (out as Record<string, unknown>),
    ).toBe(false)
  })

  // The canonical property id agents need for later setProperties lives INSIDE
  // each `properties` entry (the `id` field) — no separate `added` array.
  it('carries the added property canonical ids within `properties`', async () => {
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
      stubClient({
        reply: {
          id: 'c:1',
          properties: [
            {
              id: 'Label#1:0',
              name: 'Label',
              type: 'TEXT',
              defaultValue: 'Hi',
            },
          ],
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      properties: { id: string; name: string }[]
    }
    const label = out.properties.find(
      p => p.name === 'Label',
    )!
    expect(label.id).toBe('Label#1:0')
  })

  it('T7: a reply with warnings surfaces on SUCCESS (not Error)', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'c:1', expose: ['i:1'] },
      stubClient({
        reply: {
          id: 'c:1',
          properties: [],
          warnings: [
            'exposeNestedInstances unavailable in this Figma version; expose skipped',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain(
      'exposeNestedInstances',
    )
  })
})

describe('handleCombineVariants', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'c:2'] },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('guards <2 components in the handler WITHOUT sending a command', async () => {
    const sent: Sent[] = []
    const result = await handleCombineVariants(
      { componentIds: ['c:1'] },
      stubClient({ sent }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('at least 2')
    expect(sent).toHaveLength(0)
  })

  it('forwards COMMANDS.COMBINE_VARIANTS with {componentIds,parentId,name}', async () => {
    const sent: Sent[] = []
    await handleCombineVariants(
      {
        componentIds: ['c:1', 'c:2'],
        parentId: 'p:1',
        name: 'Set',
      },
      stubClient({
        sent,
        reply: {
          id: 'cs:1',
          name: 'Set',
          type: 'COMPONENT_SET',
          variantAxes: {},
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.COMBINE_VARIANTS)
    expect(sent[0].params).toEqual({
      componentIds: ['c:1', 'c:2'],
      parentId: 'p:1',
      name: 'Set',
    })
  })

  // C1: the set's `key` is returned (read/write symmetry — feeds get_components
  // / swap_component by key).
  it('emits {id,key,name,type,variantAxes} from the reply', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'c:2'] },
      stubClient({
        reply: {
          id: 'cs:1',
          key: 'cskey:1',
          name: 'Set',
          type: 'COMPONENT_SET',
          variantAxes: { Variant: { values: ['Default'] } },
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      key: string
      name: string
      type: string
      variantAxes: Record<string, unknown>
    }
    expect(out.id).toBe('cs:1')
    expect(out.key).toBe('cskey:1')
    expect(out.type).toBe('COMPONENT_SET')
    expect(out.variantAxes).toBeDefined()
  })

  // C1: multi-axis variant-name warning surfaces on SUCCESS (not Error) — the
  // plugin warns when source names don't use the "Property=Value" convention.
  it('multi-axis warning surfaces on SUCCESS (not Error)', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'c:2'] },
      stubClient({
        reply: {
          id: 'cs:1',
          key: 'cskey:1',
          name: 'Set',
          type: 'COMPONENT_SET',
          variantAxes: {},
          warnings: [
            'combine_variants: 2 component name(s) do not use the "Property=Value" axis convention (PrimaryLarge, SecondarySmall); the variant set will not form a clean axis set. Name each variant one property per axis (e.g. "Style=Primary, Size=Large").',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      type: string
      warnings: string[]
    }
    expect(out.type).toBe('COMPONENT_SET')
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('clean axis set')
    expect(out.warnings[0]).toContain('Property=Value')
  })

  it('partial drop: a dropped-id warning surfaces on SUCCESS (not Error)', async () => {
    // The plugin combines the valid ids and reports the dropped one in
    // warnings[]; the handler must pass that through as success-with-warning.
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'bad:9', 'c:2'] },
      stubClient({
        reply: {
          id: 'cs:1',
          name: 'Set',
          type: 'COMPONENT_SET',
          variantAxes: {},
          warnings: [
            'combine_variants ignored 1 id that is not a COMPONENT: bad:9',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      type: string
      warnings: string[]
    }
    expect(out.type).toBe('COMPONENT_SET')
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('bad:9')
  })
})

describe('handleSwapComponent', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSwapComponent(
      { instanceId: 'i:1', mainComponentId: 'c:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SWAP_COMPONENT with {instanceId,mainComponentId} (local path)', async () => {
    const sent: Sent[] = []
    await handleSwapComponent(
      { instanceId: 'i:1', mainComponentId: 'c:1' },
      stubClient({
        sent,
        reply: {
          id: 'i:1',
          mainComponent: 'c:1',
          warnings: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SWAP_COMPONENT)
    expect(sent[0].params?.instanceId).toBe('i:1')
    expect(sent[0].params?.mainComponentId).toBe('c:1')
  })

  // C2: remote-by-key. The handler forwards `key`; the plugin resolves it via
  // importComponentByKeyAsync (T7-gated).
  it('forwards the remote `key` when no local mainComponentId is given', async () => {
    const sent: Sent[] = []
    await handleSwapComponent(
      { instanceId: 'i:1', key: 'remote-key-123' },
      stubClient({
        sent,
        reply: {
          id: 'i:1',
          mainComponent: 'imported:remote-key-123',
          warnings: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SWAP_COMPONENT)
    expect(sent[0].params?.key).toBe('remote-key-123')
    expect(sent[0].params?.mainComponentId).toBeUndefined()
  })

  it('forwards BOTH when given — the plugin documents LOCAL wins', async () => {
    const sent: Sent[] = []
    await handleSwapComponent(
      {
        instanceId: 'i:1',
        mainComponentId: 'c:1',
        key: 'remote-key-123',
      },
      stubClient({
        sent,
        reply: {
          id: 'i:1',
          mainComponent: 'c:1',
          warnings: [],
        },
      }),
    )
    expect(sent[0].params?.mainComponentId).toBe('c:1')
    expect(sent[0].params?.key).toBe('remote-key-123')
  })

  it('errors WITHOUT sending when neither mainComponentId nor key is given', async () => {
    const sent: Sent[] = []
    const result = await handleSwapComponent(
      { instanceId: 'i:1' },
      stubClient({ sent }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'mainComponentId (local) or key (remote)',
    )
    expect(sent).toHaveLength(0)
  })

  it('emits {id,mainComponent,warnings} from the reply', async () => {
    const result = await handleSwapComponent(
      { instanceId: 'i:1', mainComponentId: 'c:1' },
      stubClient({
        reply: {
          id: 'i:1',
          mainComponent: 'c:1',
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      mainComponent: string
      warnings: string[]
    }
    expect(out.id).toBe('i:1')
    expect(out.mainComponent).toBe('c:1')
    expect(out.warnings).toEqual([])
  })

  it('T7 degrade: a reply with swap warnings surfaces on SUCCESS (not Error)', async () => {
    const result = await handleSwapComponent(
      { instanceId: 'i:1', mainComponentId: 'c:1' },
      stubClient({
        reply: {
          id: 'i:1',
          mainComponent: 'c:1',
          warnings: [
            'swapComponent failed: feature unavailable',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain(
      'swapComponent failed',
    )
  })
})

describe('handleSetInstance', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSetInstance(
      { instanceId: 'i:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SET_INSTANCE with {instanceId,properties,overrides}', async () => {
    const sent: Sent[] = []
    await handleSetInstance(
      {
        instanceId: 'i:1',
        properties: { Size: 'Large', Disabled: true },
        overrides: [
          { path: 'n:1', field: 'fills', value: '#FFF' },
        ],
      },
      stubClient({
        sent,
        reply: {
          id: 'i:1',
          componentProperties: {},
          warnings: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_INSTANCE)
    expect(sent[0].params).toEqual({
      instanceId: 'i:1',
      properties: { Size: 'Large', Disabled: true },
      overrides: [
        { path: 'n:1', field: 'fills', value: '#FFF' },
      ],
    })
  })

  // C3 / T2: the plugin echoes the RAW Figma componentProperties
  // ({ [name]:{type,value} }); the SERVER splits it into the SAME read-twin
  // shape get_node / get_components emit — VARIANT → variantProperties (value as
  // string), non-VARIANT → componentProperties (raw value). So the write echo
  // round-trips its READ twin EXACTLY.
  it('splits the raw plugin echo into the read-twin { variantProperties, componentProperties } shape', async () => {
    const result = await handleSetInstance(
      {
        instanceId: 'i:1',
        properties: { Size: 'Large', Disabled: true },
      },
      stubClient({
        reply: {
          id: 'i:1',
          componentProperties: {
            Size: { value: 'Large', type: 'VARIANT' },
            Disabled: { value: true, type: 'BOOLEAN' },
          },
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      variantProperties?: Record<string, string>
      componentProperties?: Record<string, string | boolean>
      warnings: string[]
    }
    expect(out.id).toBe('i:1')
    // VARIANT prop → variantProperties (value as a flat string).
    expect(out.variantProperties).toEqual({ Size: 'Large' })
    // non-VARIANT prop → componentProperties (raw value).
    expect(out.componentProperties).toEqual({
      Disabled: true,
    })
    // The raw nested { [name]:{type,value} } map is GONE — it was split.
    const raw = (
      out.componentProperties as Record<string, unknown>
    ).Disabled
    expect(typeof raw).not.toBe('object')
    expect(out.warnings).toEqual([])
  })

  it('matches the get_node read twin exactly for the same raw props', async () => {
    // The READ twin (componentMeta via get_node) splits the SAME raw map; the
    // write echo must produce the identical projection.
    const rawProps = {
      Variant: { value: 'Primary', type: 'VARIANT' },
      Label: { value: 'Hi', type: 'TEXT' },
    }
    const result = await handleSetInstance(
      {
        instanceId: 'i:1',
        properties: { Variant: 'Primary' },
      },
      stubClient({
        reply: {
          id: 'i:1',
          componentProperties: rawProps,
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      variantProperties?: Record<string, string>
      componentProperties?: Record<string, string | boolean>
    }
    expect(out.variantProperties).toEqual({
      Variant: 'Primary',
    })
    expect(out.componentProperties).toEqual({ Label: 'Hi' })
  })

  it('T7 degrade: an overrides warning surfaces on SUCCESS (not Error)', async () => {
    const result = await handleSetInstance(
      {
        instanceId: 'i:1',
        overrides: [
          { path: 'n:1', field: 'fills', value: '#FFF' },
        ],
      },
      stubClient({
        reply: {
          id: 'i:1',
          componentProperties: {},
          warnings: [
            'Per-node overrides are not yet applied; 1 override(s) skipped',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain(
      'overrides are not yet applied',
    )
  })

  it('N1: the overrides schema description is honest about the degrade', async () => {
    const desc =
      setInstanceParamsSchema.shape.overrides.description
    expect(desc).toBeDefined()
    // Must NOT read as fully implemented; must flag the degrade.
    expect(desc).not.toBe('Per-node overrides to apply.')
    expect(desc).toContain('NOT YET APPLIED')
    expect(desc).toContain('warning')
  })
})
