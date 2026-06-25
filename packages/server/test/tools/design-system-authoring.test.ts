// design-system-authoring.test.ts — handleCreateVariables / handleUpdateVariables
// / handleCreateStyles / handleUpdateStyles / handleApplyStyle.
//
// These are the M3-C design-system WRITE tools. The SERVER converts each style /
// variable VALUE atom to a Figma object via the grammar WRITE face (COLOR hex →
// {r,g,b[,a]}, paint atom → Paint, font atom → FontName, grid atom → LayoutGrid)
// and forwards the converted payload to the plugin; the plugin (or here, the
// stub) just assigns it. Each handler routes through formatMutationResult so a
// plugin-side {error} surfaces as an error and a {…,warnings} degrade (T7) is
// reported as success-with-warning — never a throw, never a silent no-op.
//
// Asserts on REAL handler output (JSON.parse of the emitted text) and on the
// CONVERTED params the handler forwarded.

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCreateVariables,
  handleUpdateVariables,
  handleCreateStyles,
  handleUpdateStyles,
  handleApplyStyle,
} from '@figma-agent-bridge/server/tools/design-system-authoring'

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

// ─── create_variables ─────────────────────────────────────────────────────────

describe('handleCreateVariables', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateVariables(
      { collection: 'Brand', variables: [] },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.CREATE_VARIABLES with COLOR values parsed to {r,g,b}', async () => {
    const sent: Sent[] = []
    await handleCreateVariables(
      {
        collection: 'Brand',
        modes: ['Light', 'Dark'],
        variables: [
          {
            name: 'Brand/Primary',
            type: 'COLOR',
            valuesByMode: {
              Light: '#FF0000',
              Dark: '#000000',
            },
          },
        ],
      },
      stubClient({
        sent,
        reply: {
          collectionId: 'col:1',
          modes: [{ modeId: 'm1', name: 'Light' }],
          variables: [
            { id: 'var:1', name: 'Brand/Primary' },
          ],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.CREATE_VARIABLES)
    const params = sent[0].params as {
      collection: string
      modes?: string[]
      variables: {
        name: string
        type: string
        valuesByMode: Record<string, unknown>
      }[]
    }
    expect(params.collection).toBe('Brand')
    expect(params.modes).toEqual(['Light', 'Dark'])
    // COLOR hex atoms parsed server-side to {r,g,b,a} (grammar write face).
    expect(params.variables[0].type).toBe('COLOR')
    expect(params.variables[0].valuesByMode.Light).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    })
    expect(params.variables[0].valuesByMode.Dark).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    })
  })

  it('passes FLOAT/STRING/BOOLEAN values through unparsed', async () => {
    const sent: Sent[] = []
    await handleCreateVariables(
      {
        collection: 'Tokens',
        variables: [
          {
            name: 'radius/md',
            type: 'FLOAT',
            valuesByMode: { Mode1: 8 },
          },
          {
            name: 'label',
            type: 'STRING',
            valuesByMode: { Mode1: 'hello' },
          },
          {
            name: 'flag',
            type: 'BOOLEAN',
            valuesByMode: { Mode1: true },
          },
        ],
      },
      stubClient({ sent, reply: { collectionId: 'c' } }),
    )
    const params = sent[0].params as {
      variables: {
        valuesByMode: Record<string, unknown>
      }[]
    }
    expect(params.variables[0].valuesByMode.Mode1).toBe(8)
    expect(params.variables[1].valuesByMode.Mode1).toBe(
      'hello',
    )
    expect(params.variables[2].valuesByMode.Mode1).toBe(
      true,
    )
  })

  it('emits the {collectionId,modes,variables} reply', async () => {
    const result = await handleCreateVariables(
      {
        collection: 'Brand',
        variables: [
          {
            name: 'P',
            type: 'COLOR',
            valuesByMode: { Mode1: '#FFFFFF' },
          },
        ],
      },
      stubClient({
        reply: {
          collectionId: 'col:1',
          modes: [{ modeId: 'm1', name: 'Mode 1' }],
          variables: [{ id: 'var:1', name: 'P' }],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      collectionId: string
      variables: { id: string }[]
    }
    expect(out.collectionId).toBe('col:1')
    expect(out.variables[0].id).toBe('var:1')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleCreateVariables(
      { collection: 'Brand', variables: [] },
      stubClient({
        reply: { error: 'Variables API unavailable' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('unavailable')
  })

  it('catches a malformed COLOR atom locally and reports an error (never throws)', async () => {
    const result = await handleCreateVariables(
      {
        collection: 'Brand',
        variables: [
          {
            name: 'P',
            type: 'COLOR',
            valuesByMode: { Mode1: 'not-a-hex' },
          },
        ],
      },
      stubClient({ reply: { collectionId: 'c' } }),
    )
    expect(result.content[0].text).toContain('Error')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleCreateVariables(
      {
        collection: 'Brand',
        variables: [
          {
            name: 'P',
            type: 'COLOR',
            valuesByMode: { Mode1: '#FFFFFF' },
          },
        ],
      },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to create variables.',
    )
  })
})

// ─── update_variables ─────────────────────────────────────────────────────────

describe('handleUpdateVariables', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleUpdateVariables(
      { collectionId: 'col:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.UPDATE_VARIABLES with mode lifecycle + parsed COLOR edits', async () => {
    const sent: Sent[] = []
    await handleUpdateVariables(
      {
        collectionId: 'col:1',
        addModes: ['Dark'],
        removeModes: ['Legacy'],
        renameModes: [{ from: 'Light', to: 'Default' }],
        variables: [
          {
            id: 'var:1',
            valuesByMode: { Default: '#00FF00' },
            scopes: ['ALL_SCOPES'],
            codeSyntax: { WEB: '--p' },
            hiddenFromPublishing: true,
          },
        ],
      },
      stubClient({
        sent,
        reply: {
          collectionId: 'col:1',
          modes: [{ modeId: 'm1', name: 'Default' }],
          warnings: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.UPDATE_VARIABLES)
    const params = sent[0].params as {
      collectionId: string
      addModes?: string[]
      removeModes?: string[]
      renameModes?: { from: string; to: string }[]
      variables?: {
        id: string
        valuesByMode?: Record<string, unknown>
        scopes?: string[]
      }[]
    }
    expect(params.collectionId).toBe('col:1')
    expect(params.addModes).toEqual(['Dark'])
    expect(params.removeModes).toEqual(['Legacy'])
    expect(params.renameModes).toEqual([
      { from: 'Light', to: 'Default' },
    ])
    // COLOR edit parsed server-side.
    expect(
      params.variables?.[0].valuesByMode?.Default,
    ).toEqual({ r: 0, g: 1, b: 0, a: 1 })
    expect(params.variables?.[0].scopes).toEqual([
      'ALL_SCOPES',
    ])
  })

  it('passes non-hex string values through unchanged (vs create_variables which errors)', async () => {
    // Nit 3: update_variables parses only hex-shaped strings (shared HEX_RE) and
    // passes everything else through — a STRING variable value like 'hello' must
    // reach the plugin verbatim, never throw, never be coerced.
    const sent: Sent[] = []
    const result = await handleUpdateVariables(
      {
        collectionId: 'col:1',
        variables: [
          {
            id: 'var:1',
            valuesByMode: { Default: 'hello' },
          },
        ],
      },
      stubClient({
        sent,
        reply: {
          collectionId: 'col:1',
          modes: [],
          warnings: [],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const params = sent[0].params as {
      variables?: {
        valuesByMode?: Record<string, unknown>
      }[]
    }
    expect(
      params.variables?.[0].valuesByMode?.Default,
    ).toBe('hello')
  })

  it('reports a {…,warnings} degrade as success-with-warning (T7)', async () => {
    const result = await handleUpdateVariables(
      { collectionId: 'col:1', addModes: ['Dark'] },
      stubClient({
        reply: {
          collectionId: 'col:1',
          modes: [],
          warnings: [
            'addMode unavailable in this Figma version; mode "Dark" not added',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'addMode unavailable',
    )
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleUpdateVariables(
      { collectionId: 'nope' },
      stubClient({
        reply: { error: 'Collection not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Collection not found',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleUpdateVariables(
      { collectionId: 'col:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to update variables.',
    )
  })
})

// ─── create_styles ────────────────────────────────────────────────────────────

describe('handleCreateStyles', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateStyles(
      { type: 'paint', name: 'P', value: '#FF0000' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards a paint atom converted to a SOLID Paint', async () => {
    const sent: Sent[] = []
    await handleCreateStyles(
      {
        type: 'paint',
        name: 'Brand/Primary',
        value: '#3B82F6',
        description: 'brand blue',
      },
      stubClient({
        sent,
        reply: {
          id: 'S:1',
          key: 'k',
          name: 'Brand/Primary',
          type: 'paint',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.CREATE_STYLES)
    const params = sent[0].params as {
      type: string
      name: string
      description?: string
      value: { type: string; color: unknown }
    }
    expect(params.type).toBe('paint')
    expect(params.description).toBe('brand blue')
    expect(params.value.type).toBe('SOLID')
    expect(params.value.color).toEqual({
      r: 0.231,
      g: 0.51,
      b: 0.965,
    })
  })

  it('forwards a font atom converted to a FontName', async () => {
    const sent: Sent[] = []
    await handleCreateStyles(
      {
        type: 'text',
        name: 'Heading/H1',
        value: 'font(Inter,Bold,32,{lh=40})',
      },
      stubClient({ sent, reply: { id: 'S:2' } }),
    )
    const params = sent[0].params as {
      value: {
        family: string
        style: string
        size: number
        lineHeight?: { value: number; unit: string }
      }
    }
    expect(params.value.family).toBe('Inter')
    expect(params.value.style).toBe('Bold')
    expect(params.value.size).toBe(32)
    expect(params.value.lineHeight).toEqual({
      value: 40,
      unit: 'PIXELS',
    })
  })

  it('forwards an effect atom converted to a DROP_SHADOW', async () => {
    const sent: Sent[] = []
    await handleCreateStyles(
      {
        type: 'effect',
        name: 'Card Shadow',
        value: 'shadow(0,4,12,#0000001A)',
      },
      stubClient({ sent, reply: { id: 'S:3' } }),
    )
    const params = sent[0].params as {
      value: { type: string; radius: number }
    }
    expect(params.value.type).toBe('DROP_SHADOW')
    expect(params.value.radius).toBe(12)
  })

  it('forwards a grid atom converted to a LayoutGrid', async () => {
    const sent: Sent[] = []
    await handleCreateStyles(
      {
        type: 'grid',
        name: '12 Col',
        value: 'columns(12,80,20)',
      },
      stubClient({ sent, reply: { id: 'S:4' } }),
    )
    const params = sent[0].params as {
      value: { pattern: string; count: number }
    }
    expect(params.value.pattern).toBe('COLUMNS')
    expect(params.value.count).toBe(12)
  })

  it('emits the {id,key,name,type} reply', async () => {
    const result = await handleCreateStyles(
      { type: 'paint', name: 'P', value: '#FFFFFF' },
      stubClient({
        reply: {
          id: 'S:1',
          key: 'kk',
          name: 'P',
          type: 'paint',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      key: string
    }
    expect(out.id).toBe('S:1')
    expect(out.key).toBe('kk')
  })

  it('catches a malformed atom locally and reports an error (never throws)', async () => {
    const result = await handleCreateStyles(
      { type: 'paint', name: 'P', value: 'not-a-paint(' },
      stubClient({ reply: { id: 'S:1' } }),
    )
    expect(result.content[0].text).toContain('Error')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleCreateStyles(
      { type: 'paint', name: 'P', value: '#FFFFFF' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to create style.',
    )
  })
})

// ─── update_styles ────────────────────────────────────────────────────────────

describe('handleUpdateStyles', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleUpdateStyles(
      { styleId: 'S:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards name/description without a value untouched', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      { styleId: 'S:1', name: 'New', description: 'desc' },
      stubClient({
        sent,
        reply: { id: 'S:1', warnings: [] },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.UPDATE_STYLES)
    const params = sent[0].params as {
      styleId: string
      name?: string
      description?: string
      value?: unknown
    }
    expect(params.styleId).toBe('S:1')
    expect(params.name).toBe('New')
    expect(params.description).toBe('desc')
    expect(params.value).toBeUndefined()
  })

  it('forwards a value atom: server infers paint category and converts to a Paint', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      { styleId: 'S:1', value: '#FF0000' },
      stubClient({
        sent,
        reply: { id: 'S:1', warnings: [] },
      }),
    )
    const params = sent[0].params as {
      value?: { type?: string; color?: unknown }
      valueType?: string
    }
    // The server infers the category from the atom syntax (a bare hex → paint)
    // and parses it to a Figma object; the inferred category rides alongside so
    // the plugin can validate it against the resolved style's actual type.
    expect(params.valueType).toBe('paint')
    expect(params.value?.type).toBe('SOLID')
    expect(params.value?.color).toEqual({
      r: 1,
      g: 0,
      b: 0,
    })
  })

  it('infers the font category for a font(...) value', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      { styleId: 'S:2', value: 'font(Inter,Bold,20)' },
      stubClient({
        sent,
        reply: { id: 'S:2', warnings: [] },
      }),
    )
    const params = sent[0].params as {
      value?: { family?: string }
      valueType?: string
    }
    expect(params.valueType).toBe('text')
    expect(params.value?.family).toBe('Inter')
  })

  it('infers the effect category for a shadow(...) value', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      { styleId: 'S:3', value: 'shadow(0,4,12,#00000040)' },
      stubClient({
        sent,
        reply: { id: 'S:3', warnings: [] },
      }),
    )
    const params = sent[0].params as {
      value?: { type?: string }
      valueType?: string
    }
    expect(params.valueType).toBe('effect')
    expect(params.value?.type).toBe('DROP_SHADOW')
  })

  it('infers the grid category for a columns(...) value', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      { styleId: 'S:4', value: 'columns(12,80,20)' },
      stubClient({
        sent,
        reply: { id: 'S:4', warnings: [] },
      }),
    )
    const params = sent[0].params as {
      value?: { pattern?: string }
      valueType?: string
    }
    expect(params.valueType).toBe('grid')
    expect(params.value?.pattern).toBe('COLUMNS')
  })

  it('reports a {…,warnings} degrade as success-with-warning (T7)', async () => {
    const result = await handleUpdateStyles(
      { styleId: 'S:1', value: '#FF0000' },
      stubClient({
        reply: {
          id: 'S:1',
          warnings: [
            'style category unknown; value skipped',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'value skipped',
    )
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleUpdateStyles(
      { styleId: 'nope' },
      stubClient({
        reply: { error: 'Style not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Style not found',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleUpdateStyles(
      { styleId: 'S:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to update style.',
    )
  })
})

// ─── apply_style ──────────────────────────────────────────────────────────────

describe('handleApplyStyle', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleApplyStyle(
      { nodeId: '1:1', styleId: 'S:1', field: 'fill' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.APPLY_STYLE with {nodeId,styleId,field}', async () => {
    const sent: Sent[] = []
    await handleApplyStyle(
      { nodeId: '1:1', styleId: 'S:1', field: 'fill' },
      stubClient({
        sent,
        reply: { id: '1:1', warnings: [] },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.APPLY_STYLE)
    expect(sent[0].params).toEqual({
      nodeId: '1:1',
      styleId: 'S:1',
      field: 'fill',
    })
  })

  it('reports a {…,warnings} degrade as success-with-warning (T7)', async () => {
    const result = await handleApplyStyle(
      { nodeId: '1:1', styleId: 'S:1', field: 'text' },
      stubClient({
        reply: {
          id: '1:1',
          warnings: [
            'setTextStyleIdAsync unavailable on FRAME; style not applied',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain('not applied')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleApplyStyle(
      { nodeId: 'nope', styleId: 'S:1', field: 'fill' },
      stubClient({
        reply: { error: 'Node not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Node not found',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleApplyStyle(
      { nodeId: '1:1', styleId: 'S:1', field: 'fill' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to apply style.',
    )
  })
})
