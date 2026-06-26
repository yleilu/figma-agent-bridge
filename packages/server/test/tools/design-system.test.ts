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

  it('forwards COMMANDS.GET_STYLES with {type,id}', async () => {
    const sent: Sent[] = []
    await handleGetStyles(
      { type: 'paint', id: 'S:1' },
      stubClient({ sent, reply: stylesReply }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_STYLES)
    expect(sent[0].params).toEqual({
      type: 'paint',
      id: 'S:1',
    })
  })

  it('surfaces a plugin-side {error} instead of swallowing it into empty results', async () => {
    const result = await handleGetStyles(
      {},
      stubClient({
        reply: {
          error:
            'getLocalGridStylesAsync is not a function',
        },
      }),
    )
    const { text } = result.content[0]
    expect(text).toContain('Error')
    expect(text).toContain('getLocalGridStylesAsync')
    // Must NOT degrade a hard failure into a clean empty list.
    expect(text).not.toContain('results: []')
  })

  it('round-trips letterSpacing PERCENT for a text style (T1/T2)', async () => {
    const result = await handleGetStyles(
      { type: 'text' },
      stubClient({
        reply: {
          text: [
            {
              id: 'S:9',
              name: 'Tracked',
              value: {
                family: 'Inter',
                style: 'Regular',
                size: 16,
                letterSpacing: {
                  value: 5,
                  unit: 'PERCENT',
                },
              },
            },
          ],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { value: string }[]
    }
    // PERCENT must be preserved in the atom, not silently rendered as PIXELS.
    expect(out.results[0].value).toContain('ls=5%')
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

  // T10 — server-side pagination (limit + cursor + truncated). The plugin
  // returns the full doc-bounded list; the SERVER bounds the AGENT-CONTEXT by
  // slicing through paginateList. A paint list of >limit entries pages.
  const manyPaintStyles = (n: number) => ({
    paint: Array.from({ length: n }, (_, i) => ({
      id: `S:${i}`,
      name: `Paint ${i}`,
      value: {
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
      },
    })),
  })

  it('paginates with limit: page 1 is truncated and emits a cursor', async () => {
    const result = await handleGetStyles(
      { limit: 2 },
      stubClient({ reply: manyPaintStyles(5) }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out.results).toHaveLength(2)
    expect(out.results[0].id).toBe('S:0')
    expect(out.results[1].id).toBe('S:1')
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('resumes from a cursor on the next page (no cursor at the end)', async () => {
    const page1 = await handleGetStyles(
      { limit: 2 },
      stubClient({ reply: manyPaintStyles(4) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const page2 = await handleGetStyles(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyPaintStyles(4) }),
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out2.results).toHaveLength(2)
    expect(out2.results[0].id).toBe('S:2')
    expect(out2.results[1].id).toBe('S:3')
    expect(out2.truncated).toBe(false)
    expect(out2).not.toHaveProperty('cursor')
  })

  it('reports a STALE cursor without throwing when the set changed', async () => {
    const page1 = await handleGetStyles(
      { limit: 2 },
      stubClient({ reply: manyPaintStyles(5) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const stale = await handleGetStyles(
      { limit: 2, cursor: out1.cursor },
      // A different set → different version stamp → STALE.
      stubClient({ reply: manyPaintStyles(2) }),
    )
    const { text } = stale.content[0]
    expect(text).toContain('Cursor rejected (STALE)')
    expect(text.toLowerCase()).toContain('re-run')
  })

  it('single-page behavior unchanged: no cursor when it fits the limit', async () => {
    const result = await handleGetStyles(
      {},
      stubClient({ reply: stylesReply }),
    )
    const out = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(out.truncated).toBe(false)
    expect(out).not.toHaveProperty('cursor')
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
        // `properties` is the SAME {id,name,type,defaultValue,variantOptions?}
        // array shape + key update_component emits (read == write, T2).
        properties: [
          {
            id: 'Variant',
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
        properties: [],
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

  // T10 — includeRemote is the timeout fix. The O(document) all-instances
  // remote-discovery scan must be OFF by default: the server threads
  // includeRemote:false to the plugin so the plugin skips the expensive scan
  // and returns only LOCAL components.
  it('threads includeRemote:false to the plugin by default (the timeout fix)', async () => {
    const sent: Sent[] = []
    await handleGetComponents(
      {},
      stubClient({ sent, reply: componentsReply }),
    )
    expect(sent[0].params?.includeRemote).toBe(false)
  })

  it('threads includeRemote:true to the plugin when requested', async () => {
    const sent: Sent[] = []
    await handleGetComponents(
      { includeRemote: true },
      stubClient({ sent, reply: componentsReply }),
    )
    expect(sent[0].params?.includeRemote).toBe(true)
  })

  // T10 — server-side pagination (limit + cursor + truncated), mirroring the
  // other bounded list reads: the plugin returns its (local-only by default)
  // list; the SERVER bounds the AGENT-CONTEXT by slicing through paginateList.
  const manyComponents = (n: number) => ({
    local: Array.from({ length: n }, (_, i) => ({
      id: `C:${i}`,
      name: `Comp ${i}`,
      key: `k${i}`,
      type: 'COMPONENT',
    })),
    remote: [],
  })

  it('paginates with limit: page 1 is truncated and emits a cursor', async () => {
    const result = await handleGetComponents(
      { limit: 2 },
      stubClient({ reply: manyComponents(5) }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out.results).toHaveLength(2)
    expect(out.results[0].id).toBe('C:0')
    expect(out.results[1].id).toBe('C:1')
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('resumes from a cursor on the next page (no cursor at the end)', async () => {
    const page1 = await handleGetComponents(
      { limit: 2 },
      stubClient({ reply: manyComponents(4) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const page2 = await handleGetComponents(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyComponents(4) }),
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out2.results).toHaveLength(2)
    expect(out2.results[0].id).toBe('C:2')
    expect(out2.results[1].id).toBe('C:3')
    expect(out2.truncated).toBe(false)
    expect(out2).not.toHaveProperty('cursor')
  })

  it('reports a STALE cursor without throwing when the set changed', async () => {
    const page1 = await handleGetComponents(
      { limit: 2 },
      stubClient({ reply: manyComponents(5) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const stale = await handleGetComponents(
      { limit: 2, cursor: out1.cursor },
      // A different set → different version stamp → STALE.
      stubClient({ reply: manyComponents(2) }),
    )
    const { text } = stale.content[0]
    expect(text).toContain('Cursor rejected (STALE)')
    expect(text.toLowerCase()).toContain('re-run')
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
        properties?: unknown[]
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
    expect(button.properties).toHaveLength(1)
  })

  // T2 read == write: get_components' `properties` projection is the SAME shape
  // + key update_component emits — {id,name,type,defaultValue,variantOptions?}.
  it('projects `properties` in the update_component shape (read == write, T2)', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({ reply: componentsReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: {
        name: string
        properties?: {
          id: string
          name: string
          type: string
          defaultValue: string | boolean
          variantOptions?: string[]
        }[]
      }[]
    }
    const button = out.results.find(
      r => r.name === 'Button',
    )!
    // The legacy `propertyDefinitions` key is GONE (renamed to `properties`).
    expect(
      'propertyDefinitions' in
        (button as Record<string, unknown>),
    ).toBe(false)
    const variant = button.properties![0]
    // Same per-entry shape as update_component: id + name + type +
    // defaultValue + variantOptions.
    expect(variant.id).toBe('Variant')
    expect(variant.name).toBe('Variant')
    expect(variant.type).toBe('VARIANT')
    expect(variant.defaultValue).toBe('Primary')
    expect(variant.variantOptions).toEqual([
      'Primary',
      'Secondary',
    ])
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

  // Bug B: a genuine plugin-side {error} (e.g. a ComponentSet with conflicting
  // variants throwing "Component set for node has existing errors") must be
  // surfaced honestly — NOT masked behind the generic "Unexpected response from
  // plugin" (the sibling reads get_styles/list_fonts already do this; T7).
  it('surfaces a plugin-side {error} instead of masking it as "Unexpected response"', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({
        reply: {
          error:
            'Error: in get_variantProperties: Component set for node has existing errors',
        },
      }),
    )
    const { text } = result.content[0]
    expect(text).toContain('Error')
    expect(text).toContain(
      'Component set for node has existing errors',
    )
    // The honest {error} surfacing must NOT be swallowed into the generic mask.
    expect(text).not.toBe('Unexpected response from plugin')
  })

  // Bug A degrade (server side): a resilient plugin reply carries the good
  // components AND a warnings[] naming the malformed set. The handler surfaces
  // the warnings on the SUCCESS path (T7 — warnings ride on success, never
  // thrown), good components still returned, NOT an {error}, NOT a crash.
  it('surfaces warnings[] on the success path when a set degraded', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({
        reply: {
          local: [
            {
              id: '1:10',
              name: 'Button',
              key: 'btn-key',
              type: 'COMPONENT_SET',
            },
          ],
          remote: [],
          warnings: [
            'component set "Broken" (3:7) skipped variant projection: Error: in get_variantProperties: Component set for node has existing errors',
          ],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { name: string }[]
      truncated: boolean
      warnings?: string[]
    }
    // Good components still returned.
    expect(out.results).toHaveLength(1)
    expect(out.results[0].name).toBe('Button')
    expect(out.truncated).toBe(false)
    // The warning rides on success, naming the set + the reason.
    expect(out.warnings).toBeDefined()
    expect(out.warnings![0]).toContain('Broken')
    expect(out.warnings![0]).toContain(
      'Component set for node has existing errors',
    )
  })

  // No warnings → no `warnings` key on the envelope (clean reads stay clean).
  it('omits the warnings key when there are no warnings', async () => {
    const result = await handleGetComponents(
      {},
      stubClient({ reply: componentsReply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      warnings?: string[]
    }
    expect(out.warnings).toBeUndefined()
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

  it('surfaces a plugin-throw {error} reply instead of an empty success (T7)', async () => {
    const result = await handleListFonts(
      {},
      stubClient({
        reply: { error: 'Figma API unavailable' },
      }),
    )
    const { text } = result.content[0]
    expect(text).toContain('Error')
    expect(text).toContain('Figma API unavailable')
    // A hard failure must NOT degrade to a clean empty list.
    expect(text).not.toContain('results: []')
  })

  it('treats a non-array results payload as an error, not empty success', async () => {
    const result = await handleListFonts(
      {},
      stubClient({ reply: { results: 'oops' } }),
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })

  // T10 — server-side pagination. The host font list is large, so list_fonts is
  // genuinely paged. Pagination runs AFTER the `query` filter.
  const manyFonts = (n: number) => ({
    results: Array.from({ length: n }, (_, i) => ({
      id: `F${i}`,
      family: `Family ${i}`,
      styles: ['Regular'],
    })),
  })

  it('paginates with limit: page 1 truncated + cursor', async () => {
    const result = await handleListFonts(
      { limit: 2 },
      stubClient({ reply: manyFonts(5) }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { family: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out.results).toHaveLength(2)
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('resumes from a cursor on the next page', async () => {
    const page1 = await handleListFonts(
      { limit: 2 },
      stubClient({ reply: manyFonts(4) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const page2 = await handleListFonts(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyFonts(4) }),
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      results: { family: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out2.results).toHaveLength(2)
    expect(out2.results[0].family).toBe('Family 2')
    expect(out2.truncated).toBe(false)
    expect(out2).not.toHaveProperty('cursor')
  })

  // Pagination is applied AFTER the query filter — the page is over the FILTERED
  // list, not the raw list.
  it('paginates the post-filter list (limit applies after query)', async () => {
    const reply = {
      results: [
        { id: 'F1', family: 'Roboto', styles: ['Regular'] },
        { id: 'F2', family: 'Inter', styles: ['Regular'] },
        {
          id: 'F3',
          family: 'Roboto Mono',
          styles: ['Regular'],
        },
        {
          id: 'F4',
          family: 'Roboto Slab',
          styles: ['Regular'],
        },
      ],
    }
    const result = await handleListFonts(
      { query: 'roboto', limit: 2 },
      stubClient({ reply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { family: string }[]
      truncated: boolean
      cursor?: string
    }
    // 3 Roboto matches, page size 2 → 2 returned, truncated, cursor present.
    expect(out.results).toHaveLength(2)
    expect(
      out.results.every(r => /roboto/i.test(r.family)),
    ).toBe(true)
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('reports a STALE cursor without throwing when the set changed', async () => {
    const page1 = await handleListFonts(
      { limit: 2 },
      stubClient({ reply: manyFonts(5) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const stale = await handleListFonts(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyFonts(2) }),
    )
    const { text } = stale.content[0]
    expect(text).toContain('Cursor rejected (STALE)')
    expect(text.toLowerCase()).toContain('re-run')
  })

  it('single-page behavior unchanged: no cursor when it fits', async () => {
    const result = await handleListFonts(
      {},
      stubClient({ reply: fontsReply }),
    )
    const out = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(out.truncated).toBe(false)
    expect(out).not.toHaveProperty('cursor')
  })
})
