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

describe('handleCreateComponent (rebuild on NodeSpec)', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:5' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('errors when neither nodeId nor spec is provided', async () => {
    const sent: Sent[] = []
    const result = await handleCreateComponent(
      {},
      stubClient({ sent }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'exactly one of nodeId or spec',
    )
    expect(sent).toHaveLength(0)
  })

  it('errors when BOTH nodeId and spec are provided', async () => {
    const sent: Sent[] = []
    const result = await handleCreateComponent(
      { nodeId: '1:5', spec: { type: 'FRAME' } },
      stubClient({ sent }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'exactly one of nodeId or spec',
    )
    expect(sent).toHaveLength(0)
  })

  it('forwards COMMANDS.CREATE_COMPONENT with {nodeId,name,description} for the node path', async () => {
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
    expect(sent[0].params?.spec).toBeUndefined()
  })

  it('converts atom leaves on the spec write face and strips children', async () => {
    const sent: Sent[] = []
    await handleCreateComponent(
      {
        spec: {
          type: 'FRAME',
          size: [10, 10],
          fills: ['#FF0000'],
          children: [{ type: 'RECTANGLE' }],
        },
      },
      stubClient({
        sent,
        reply: {
          id: 'comp:1',
          key: 'key:1',
          name: 'FRAME',
          type: 'COMPONENT',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.CREATE_COMPONENT)
    const spec = sent[0].params?.spec as {
      fills: unknown[]
    } & Record<string, unknown>
    expect(spec.fills[0]).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
    })
    expect(spec).not.toHaveProperty('children')
    expect(sent[0].params?.nodeId).toBeUndefined()
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
          propertyDefinitions: {},
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

  it('emits {id,propertyDefinitions,warnings} from the reply', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'c:1' },
      stubClient({
        reply: {
          id: 'c:1',
          propertyDefinitions: {
            Label: { type: 'TEXT', defaultValue: 'Hi' },
          },
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      propertyDefinitions: Record<string, unknown>
      warnings: string[]
    }
    expect(out.id).toBe('c:1')
    expect(out.propertyDefinitions.Label).toBeDefined()
    expect(out.warnings).toEqual([])
  })

  it('surfaces the added property ids ({name,id}) from the reply', async () => {
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
          propertyDefinitions: {
            'Label#1:0': {
              type: 'TEXT',
              defaultValue: 'Hi',
            },
          },
          added: [{ name: 'Label', id: 'Label#1:0' }],
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      added: { name: string; id: string }[]
    }
    expect(out.added).toEqual([
      { name: 'Label', id: 'Label#1:0' },
    ])
  })

  it('T7: a reply with warnings surfaces on SUCCESS (not Error)', async () => {
    const result = await handleUpdateComponent(
      { componentId: 'c:1', expose: ['i:1'] },
      stubClient({
        reply: {
          id: 'c:1',
          propertyDefinitions: {},
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

  it('emits {id,name,type,variantAxes} from the reply', async () => {
    const result = await handleCombineVariants(
      { componentIds: ['c:1', 'c:2'] },
      stubClient({
        reply: {
          id: 'cs:1',
          name: 'Set',
          type: 'COMPONENT_SET',
          variantAxes: { Variant: { values: ['Default'] } },
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      name: string
      type: string
      variantAxes: Record<string, unknown>
    }
    expect(out.id).toBe('cs:1')
    expect(out.type).toBe('COMPONENT_SET')
    expect(out.variantAxes).toBeDefined()
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

  it('forwards COMMANDS.SWAP_COMPONENT with {instanceId,mainComponentId}', async () => {
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
    expect(sent[0].params).toEqual({
      instanceId: 'i:1',
      mainComponentId: 'c:1',
    })
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

  it('emits {id,componentProperties,warnings} from the reply (real NESTED shape)', async () => {
    // The real plugin returns inst2.componentProperties — a NESTED map
    // { [name]: { value, type } }, not the flat input. The reply models that
    // true shape so the assertion is against the contract the plugin emits.
    const result = await handleSetInstance(
      { instanceId: 'i:1', properties: { Size: 'Large' } },
      stubClient({
        reply: {
          id: 'i:1',
          componentProperties: {
            Size: { value: 'Large', type: 'VARIANT' },
          },
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      componentProperties: Record<
        string,
        { value: string; type: string }
      >
      warnings: string[]
    }
    expect(out.id).toBe('i:1')
    expect(out.componentProperties.Size).toEqual({
      value: 'Large',
      type: 'VARIANT',
    })
    expect(out.warnings).toEqual([])
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
