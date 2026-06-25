// design-system.test.ts — handleGetStyles / handleGetComponents / handleListFonts.
//
// The plugin sends raw figma shapes pre-grouped per category/entry; the SERVER
// renders them to atoms (paint→hex, text→font, effect/grid→atom) and emits the
// Rule-A list shape { results, truncated:false }. Asserts on REAL handler output.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleGetStyles,
  handleGetComponents,
  handleListFonts,
} from '@figma-agent-bridge/server/tools/design-system'

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

const stylesReply = {
  paint: [
    {
      id: 'S:1',
      name: 'Brand/Primary',
      value: {
        type: 'SOLID',
        color: { r: 0.231, g: 0.51, b: 0.965 },
      },
    },
  ],
  text: [
    {
      id: 'S:2',
      name: 'Heading',
      value: {
        family: 'Inter',
        style: 'Bold',
        size: 32,
        lineHeight: { value: 40, unit: 'PIXELS' },
      },
    },
  ],
  effect: [
    {
      id: 'S:3',
      name: 'Card Shadow',
      value: {
        type: 'DROP_SHADOW',
        color: { r: 0, g: 0, b: 0, a: 0.1 },
        offset: { x: 0, y: 4 },
        radius: 12,
        spread: 0,
      },
    },
  ],
  grid: [
    {
      id: 'S:4',
      name: '12 Col',
      value: {
        pattern: 'COLUMNS',
        count: 12,
        sectionSize: 80,
        gutterSize: 20,
      },
    },
  ],
}

describe('handleGetStyles', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleGetStyles(
      {},
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.GET_STYLES with {type,id,cursor}', async () => {
    const sent: Sent[] = []
    await handleGetStyles(
      { type: 'paint', id: 'S:1' },
      stubClient({ sent, reply: stylesReply }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_STYLES)
    expect(sent[0].params).toEqual({
      type: 'paint',
      id: 'S:1',
      cursor: undefined,
    })
  })

  it('renders paint/text/effect/grid values to atoms in Rule-A shape', async () => {
    const result = await handleGetStyles(
      {},
      stubClient({ reply: stylesReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string; type: string; value: string }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    const byId = Object.fromEntries(
      out.results.map(r => [r.id, r]),
    )
    expect(byId['S:1'].type).toBe('paint')
    expect(byId['S:1'].value).toBe('#3B82F6')
    expect(byId['S:2'].type).toBe('text')
    expect(byId['S:2'].value).toContain('Inter')
    expect(byId['S:3'].type).toBe('effect')
    expect(byId['S:3'].value).toContain('shadow')
    expect(byId['S:4'].type).toBe('grid')
    expect(byId['S:4'].value).toContain('columns')
  })

  it('honors the type filter server-side', async () => {
    const result = await handleGetStyles(
      { type: 'text' },
      stubClient({ reply: stylesReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string; type: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].type).toBe('text')
  })

  it('honors the id filter server-side', async () => {
    const result = await handleGetStyles(
      { id: 'S:3' },
      stubClient({ reply: stylesReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].id).toBe('S:3')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleGetStyles(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to get styles from plugin.',
    )
  })

  it('is defensive when a category is missing or not an array', async () => {
    const result = await handleGetStyles(
      {},
      stubClient({
        reply: { paint: stylesReply.paint, text: null },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].id).toBe('S:1')
  })
})

describe('handleGetComponents', () => {
  const componentsReply = {
    local: [
      {
        id: '1:10',
        name: 'Button',
        key: 'btn-key',
        type: 'COMPONENT_SET',
        page: 'Main',
        propertyDefinitions: [
          {
            name: 'Variant',
            type: 'VARIANT',
            defaultValue: 'Primary',
            variantOptions: ['Primary', 'Secondary'],
          },
        ],
        variantAxes: { Variant: ['Primary', 'Secondary'] },
        defaults: { Variant: 'Primary' },
      },
      {
        id: '1:20',
        name: 'Avatar',
        key: 'av-key',
        type: 'COMPONENT',
        page: 'Main',
        propertyDefinitions: [],
      },
    ],
    remote: [
      { key: 'remote-key', name: 'Icon', library: 'Lib' },
    ],
  }

  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.GET_COMPONENTS', async () => {
    const sent: Sent[] = []
    await handleGetComponents(
      { query: 'Button' },
      stubClient({ sent, reply: componentsReply }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_COMPONENTS)
  })

  it('flattens local+remote into Rule-A results carrying key + variantAxes', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({ reply: componentsReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: {
        name: string
        key: string
        variantAxes?: Record<string, string[]>
        propertyDefinitions?: unknown[]
      }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results).toHaveLength(3)
    const button = out.results.find(
      r => r.name === 'Button',
    )!
    expect(button.key).toBe('btn-key')
    expect(button.variantAxes).toEqual({
      Variant: ['Primary', 'Secondary'],
    })
    expect(button.propertyDefinitions).toHaveLength(1)
  })

  it('filters by query as a case-insensitive substring (literal, not glob)', async () => {
    const result = await handleGetComponents(
      { query: 'tton' },
      stubClient({
        reply: {
          local: [
            {
              id: '1:1',
              name: 'Primary Button',
              key: 'k1',
            },
            { id: '1:2', name: 'Avatar', key: 'k2' },
            { id: '1:3', name: 123, key: 'k3' },
          ],
          remote: [],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { name: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].name).toBe('Primary Button')
  })

  it('treats * in query as a literal character, not a glob', async () => {
    const result = await handleGetComponents(
      { query: 'Btn*' },
      stubClient({
        reply: {
          local: [
            { id: '2:1', name: 'Btn*Primary', key: 'k1' },
            { id: '2:2', name: 'BtnPrimary', key: 'k2' },
          ],
          remote: [],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { name: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].name).toBe('Btn*Primary')
  })

  it('returns Unexpected response when local is not an array', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({ reply: { local: null, remote: [] } }),
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to get components from plugin.',
    )
  })
})

describe('handleListFonts', () => {
  const fontsReply = {
    results: [
      { family: 'Inter', styles: ['Regular', 'Bold'] },
      { family: 'Roboto', styles: ['Regular'] },
    ],
  }

  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleListFonts(
      {},
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.LIST_FONTS and emits Rule-A results', async () => {
    const sent: Sent[] = []
    const result = await handleListFonts(
      {},
      stubClient({ sent, reply: fontsReply }),
    )
    expect(sent[0].command).toBe(COMMANDS.LIST_FONTS)
    const out = YAML.parse(result.content[0].text) as {
      results: { family: string; styles: string[] }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results).toHaveLength(2)
    expect(out.results[0].family).toBe('Inter')
    expect(out.results[0].styles).toContain('Bold')
  })

  it('filters by query (case-insensitive) server-side', async () => {
    const result = await handleListFonts(
      { query: 'rob' },
      stubClient({ reply: fontsReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { family: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].family).toBe('Roboto')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleListFonts(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to list fonts from plugin.',
    )
  })
})
