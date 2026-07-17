// design-system-authoring.test.ts — handleCreateVariables / handleUpdateVariables
// / handleDeleteVariables / handleCreateStyles / handleUpdateStyles / handleApplyStyle
// / handleDeleteStyles.
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
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCreateVariables,
  handleUpdateVariables,
  handleDeleteVariables,
  handleCreateStyles,
  handleUpdateStyles,
  handleApplyStyle,
  handleDeleteStyles,
} from '@figma-agent-bridge/server/tools/design-system-authoring'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  reply?: unknown
  sent?: Sent[]
}): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
})

// ─── create_variables ─────────────────────────────────────────────────────────

describe('handleCreateVariables', () => {
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

  // E1: aliases / scopes / codeSyntax / hiddenFromPublishing may be set on
  // create (parity with update_variables). The server forwards them as-is to the
  // plugin's shared per-variable apply path.
  it('forwards aliases / scopes / codeSyntax / hiddenFromPublishing on create (E1)', async () => {
    const sent: Sent[] = []
    await handleCreateVariables(
      {
        collection: 'Brand',
        modes: ['Light'],
        variables: [
          {
            name: 'Brand/Primary',
            type: 'COLOR',
            valuesByMode: { Light: '#FF0000' },
            aliases: { Light: 'var:alias-target' },
            scopes: ['ALL_SCOPES'],
            codeSyntax: { WEB: '--brand-primary' },
            hiddenFromPublishing: true,
          },
        ],
      },
      stubClient({
        sent,
        reply: { collectionId: 'col:1' },
      }),
    )
    const params = sent[0].params as {
      variables: {
        aliases?: Record<string, string>
        scopes?: string[]
        codeSyntax?: Record<string, string>
        hiddenFromPublishing?: boolean
      }[]
    }
    const v = params.variables[0]
    expect(v.aliases).toEqual({ Light: 'var:alias-target' })
    expect(v.scopes).toEqual(['ALL_SCOPES'])
    expect(v.codeSyntax).toEqual({ WEB: '--brand-primary' })
    expect(v.hiddenFromPublishing).toBe(true)
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

// ─── delete_variables ─────────────────────────────────────────────────────────

describe('handleDeleteVariables', () => {
  it('forwards COMMANDS.DELETE_VARIABLES with variables and collections', async () => {
    const sent: Sent[] = []
    await handleDeleteVariables(
      {
        variables: ['var:1', 'var:2'],
        collections: ['col:1'],
      },
      stubClient({
        sent,
        reply: {
          results: [
            { id: 'col:1', kind: 'collection' },
            { id: 'var:1', kind: 'variable' },
            { id: 'var:2', kind: 'variable' },
          ],
          errors: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.DELETE_VARIABLES)
    const params = sent[0].params as {
      variables?: string[]
      collections?: string[]
    }
    expect(params.variables).toEqual(['var:1', 'var:2'])
    expect(params.collections).toEqual(['col:1'])
  })

  it('returns partial success — one valid id + one bogus id → one result + one error', async () => {
    const result = await handleDeleteVariables(
      { variables: ['var:1', 'err:missing'] },
      stubClient({
        reply: {
          results: [{ id: 'var:1', kind: 'variable' }],
          errors: [
            {
              id: 'err:missing',
              error: 'Variable not found: err:missing',
            },
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: { id: string; kind: string }[]
      errors: { id: string; error: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].id).toBe('var:1')
    expect(out.results[0].kind).toBe('variable')
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].id).toBe('err:missing')
  })

  it('returns partial success — collection id with cascade shape', async () => {
    const result = await handleDeleteVariables(
      { collections: ['col:1', 'err:bad'] },
      stubClient({
        reply: {
          results: [{ id: 'col:1', kind: 'collection' }],
          errors: [
            {
              id: 'err:bad',
              error: 'Collection not found: err:bad',
            },
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: { id: string; kind: string }[]
      errors: { id: string; error: string }[]
    }
    expect(out.results[0].kind).toBe('collection')
    expect(out.errors[0].id).toBe('err:bad')
  })

  it('surfaces a plugin-side {error} as an error (entire call failed)', async () => {
    const result = await handleDeleteVariables(
      { variables: ['var:1'] },
      stubClient({
        reply: { error: 'Variables API unavailable' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('unavailable')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleDeleteVariables(
      { collections: ['col:1'] },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to delete variables.',
    )
  })

  it('returns INVALID_PARAM error when both variables and collections are empty/absent', async () => {
    const result = await handleDeleteVariables(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('At least one')
  })
})

// ─── delete_styles ────────────────────────────────────────────────────────────

describe('handleDeleteStyles', () => {
  it('forwards COMMANDS.DELETE_STYLES with index-tagged entries', async () => {
    const sent: Sent[] = []
    await handleDeleteStyles(
      {
        styles: [
          { id: 'S:1' },
          { name: 'Brand/Primary', type: 'paint' },
        ],
      },
      stubClient({
        sent,
        reply: {
          results: [
            { id: 'S:1', index: 0 },
            { id: 'S:99', index: 1 },
          ],
          errors: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.DELETE_STYLES)
    const entries = (
      sent[0].params as { styles: unknown[] }
    ).styles
    expect(entries).toHaveLength(2)
    expect((entries[0] as { index: number }).index).toBe(0)
    expect((entries[1] as { index: number }).index).toBe(1)
  })

  it('returns partial success — one valid id + one not-found → one result + one error', async () => {
    const result = await handleDeleteStyles(
      { styles: [{ id: 'S:1' }, { id: 'err:missing' }] },
      stubClient({
        reply: {
          results: [{ id: 'S:1', index: 0 }],
          errors: [
            {
              index: 1,
              error: 'Style not found: err:missing',
            },
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: { id: string; index: number }[]
      errors: { index: number; error: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].id).toBe('S:1')
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].index).toBe(1)
  })

  it('returns partial success — name+type resolve + not-found', async () => {
    const result = await handleDeleteStyles(
      {
        styles: [
          { name: 'Brand/Primary', type: 'paint' },
          { name: 'err:missing', type: 'text' },
        ],
      },
      stubClient({
        reply: {
          results: [{ id: 'S:paint-0', index: 0 }],
          errors: [
            {
              index: 1,
              error: 'Style not found: err:missing (text)',
            },
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: { id: string; index: number }[]
      errors: { index: number; error: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].index).toBe(0)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].index).toBe(1)
  })

  it('surfaces a plugin-side {error} as error text (entire call failed)', async () => {
    const result = await handleDeleteStyles(
      { styles: [{ id: 'S:1' }] },
      stubClient({
        reply: { error: 'Styles API unavailable' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('unavailable')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleDeleteStyles(
      { styles: [{ id: 'S:1' }] },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to delete styles.',
    )
  })
})

// ─── create_styles ────────────────────────────────────────────────────────────

describe('handleCreateStyles', () => {
  it('forwards each style atom converted to its Figma object (paint/text/effect/grid)', async () => {
    const sent: Sent[] = []
    await handleCreateStyles(
      {
        styles: [
          {
            type: 'paint',
            name: 'Brand/Primary',
            value: '#3B82F6',
            description: 'brand blue',
          },
          {
            type: 'text',
            name: 'Heading/H1',
            value: 'font(Inter,Bold,32,{lh=40})',
          },
          {
            type: 'effect',
            name: 'Card Shadow',
            value: 'shadow(0,4,12,#0000001A)',
          },
          {
            type: 'grid',
            name: '12 Col',
            value: 'columns(12,80,20)',
          },
        ],
      },
      stubClient({
        sent,
        reply: {
          results: [
            {
              id: 'S:1',
              key: 'k',
              name: 'Brand/Primary',
              type: 'paint',
              index: 0,
            },
            {
              id: 'S:2',
              key: 'k',
              name: 'Heading/H1',
              type: 'text',
              index: 1,
            },
            {
              id: 'S:3',
              key: 'k',
              name: 'Card Shadow',
              type: 'effect',
              index: 2,
            },
            {
              id: 'S:4',
              key: 'k',
              name: '12 Col',
              type: 'grid',
              index: 3,
            },
          ],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.CREATE_STYLES)
    const styles = sent[0].params?.styles as {
      type: string
      name: string
      description?: string
      value: Record<string, unknown>
    }[]
    // paint atom → SOLID Paint
    expect(styles[0].type).toBe('paint')
    expect(styles[0].description).toBe('brand blue')
    expect(styles[0].value.type).toBe('SOLID')
    expect(styles[0].value.color).toEqual({
      r: 0.231,
      g: 0.51,
      b: 0.965,
    })
    // font atom → FontName
    expect(styles[1].value.family).toBe('Inter')
    expect(styles[1].value.size).toBe(32)
    expect(styles[1].value.lineHeight).toEqual({
      value: 40,
      unit: 'PIXELS',
    })
    // effect atom → DROP_SHADOW
    expect(styles[2].value.type).toBe('DROP_SHADOW')
    expect(styles[2].value.radius).toBe(12)
    // grid atom → LayoutGrid
    expect(styles[3].value.pattern).toBe('COLUMNS')
    expect(styles[3].value.count).toBe(12)
  })

  it('emits the { results, errors } partial-success envelope', async () => {
    const result = await handleCreateStyles(
      {
        styles: [
          { type: 'paint', name: 'P', value: '#FFFFFF' },
        ],
      },
      stubClient({
        reply: {
          results: [
            {
              id: 'S:1',
              key: 'kk',
              name: 'P',
              type: 'paint',
              index: 0,
            },
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: {
        id: string
        key: string
        name: string
        type: string
        index: number
      }[]
      errors: { index: number; error: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].id).toBe('S:1')
    expect(out.results[0].key).toBe('kk')
    expect(out.results[0].index).toBe(0)
    expect(out.errors).toEqual([])
  })

  it('isolates a malformed atom to its entry (never throws; valid entries still sent + created)', async () => {
    const sent: Sent[] = []
    const result = await handleCreateStyles(
      {
        styles: [
          { type: 'paint', name: 'Good', value: '#FFFFFF' },
          {
            type: 'paint',
            name: 'Bad',
            value: 'not-a-paint(',
          },
          {
            type: 'paint',
            name: 'Good2',
            value: '#000000',
          },
        ],
      },
      stubClient({
        sent,
        reply: {
          results: [
            {
              id: 'S:1',
              key: 'k',
              name: 'Good',
              type: 'paint',
              index: 0,
            },
            {
              id: 'S:3',
              key: 'k',
              name: 'Good2',
              type: 'paint',
              index: 2,
            },
          ],
        },
      }),
    )
    // Only the two valid entries reached the plugin; the bad one was isolated.
    const styles = sent[0].params?.styles as {
      name: string
    }[]
    expect(styles).toHaveLength(2)
    expect(styles.map(s => s.name)).toEqual([
      'Good',
      'Good2',
    ])
    const out = JSON.parse(result.content[0].text) as {
      results: { index: number; name: string }[]
      errors: { index: number; error: string }[]
    }
    // Results keep their ORIGINAL indices (0 and 2); the error is index 1.
    expect(out.results.map(r => r.index)).toEqual([0, 2])
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].index).toBe(1)
  })

  it('surfaces a plugin-side per-entry error in the errors[] array', async () => {
    const result = await handleCreateStyles(
      {
        styles: [
          { type: 'paint', name: 'P', value: '#FFFFFF' },
        ],
      },
      stubClient({
        reply: {
          results: [],
          errors: [
            {
              index: 0,
              error: 'createPaintStyle unavailable',
            },
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: unknown[]
      errors: { index: number; error: string }[]
    }
    expect(out.results).toEqual([])
    expect(out.errors[0].error).toContain('unavailable')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleCreateStyles(
      {
        styles: [
          { type: 'paint', name: 'P', value: '#FFFFFF' },
        ],
      },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to create styles.',
    )
  })
})

// ─── update_styles ────────────────────────────────────────────────────────────

describe('handleUpdateStyles', () => {
  it('forwards newName/description without a value untouched (lookup by id)', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      {
        styles: [
          {
            id: 'S:1',
            newName: 'New',
            description: 'desc',
          },
        ],
      },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:1', index: 0 }] },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.UPDATE_STYLES)
    const styles = sent[0].params?.styles as {
      index: number
      id?: string
      newName?: string
      description?: string
      value?: unknown
    }[]
    expect(styles[0].index).toBe(0)
    expect(styles[0].id).toBe('S:1')
    expect(styles[0].newName).toBe('New')
    expect(styles[0].description).toBe('desc')
    expect(styles[0].value).toBeUndefined()
  })

  it('supports lookup by name+type when no id is given', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      {
        styles: [
          {
            name: 'Brand/Primary',
            type: 'paint',
            value: '#FF0000',
          },
        ],
      },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:1', index: 0 }] },
      }),
    )
    const styles = sent[0].params?.styles as {
      name?: string
      type?: string
      valueType?: string
    }[]
    expect(styles[0].name).toBe('Brand/Primary')
    expect(styles[0].type).toBe('paint')
  })

  it('forwards a value atom: server infers paint category and converts to a Paint', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      { styles: [{ id: 'S:1', value: '#FF0000' }] },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:1', index: 0 }] },
      }),
    )
    const styles = sent[0].params?.styles as {
      value?: { type?: string; color?: unknown }
      valueType?: string
    }[]
    // The server infers the category from the atom syntax (a bare hex → paint)
    // and parses it to a Figma object; the inferred category rides alongside so
    // the plugin can validate it against the resolved style's actual type.
    expect(styles[0].valueType).toBe('paint')
    expect(styles[0].value?.type).toBe('SOLID')
    expect(styles[0].value?.color).toEqual({
      r: 1,
      g: 0,
      b: 0,
    })
  })

  it('infers the font category for a font(...) value', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      {
        styles: [
          { id: 'S:2', value: 'font(Inter,Bold,20)' },
        ],
      },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:2', index: 0 }] },
      }),
    )
    const styles = sent[0].params?.styles as {
      value?: { family?: string }
      valueType?: string
    }[]
    expect(styles[0].valueType).toBe('text')
    expect(styles[0].value?.family).toBe('Inter')
  })

  it('infers the effect category for a shadow(...) value', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      {
        styles: [
          { id: 'S:3', value: 'shadow(0,4,12,#00000040)' },
        ],
      },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:3', index: 0 }] },
      }),
    )
    const styles = sent[0].params?.styles as {
      value?: { type?: string }
      valueType?: string
    }[]
    expect(styles[0].valueType).toBe('effect')
    expect(styles[0].value?.type).toBe('DROP_SHADOW')
  })

  it('infers the grid category for a columns(...) value', async () => {
    const sent: Sent[] = []
    await handleUpdateStyles(
      {
        styles: [{ id: 'S:4', value: 'columns(12,80,20)' }],
      },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:4', index: 0 }] },
      }),
    )
    const styles = sent[0].params?.styles as {
      value?: { pattern?: string }
      valueType?: string
    }[]
    expect(styles[0].valueType).toBe('grid')
    expect(styles[0].value?.pattern).toBe('COLUMNS')
  })

  it('emits the { results, errors } partial-success envelope', async () => {
    const result = await handleUpdateStyles(
      { styles: [{ id: 'S:1', value: '#FF0000' }] },
      stubClient({
        reply: { results: [{ id: 'S:1', index: 0 }] },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      results: { id: string; index: number }[]
      errors: { index: number; error: string }[]
    }
    expect(out.results[0].id).toBe('S:1')
    expect(out.results[0].index).toBe(0)
    expect(out.errors).toEqual([])
  })

  it('surfaces a per-entry plugin error in errors[] (e.g. style not found)', async () => {
    const result = await handleUpdateStyles(
      { styles: [{ id: 'nope' }] },
      stubClient({
        reply: {
          results: [],
          errors: [
            { index: 0, error: 'Style not found: nope' },
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      results: unknown[]
      errors: { index: number; error: string }[]
    }
    expect(out.results).toEqual([])
    expect(out.errors[0].error).toContain('Style not found')
  })

  it('isolates a malformed value atom to its entry (never throws; valid entries still sent)', async () => {
    const sent: Sent[] = []
    const result = await handleUpdateStyles(
      {
        styles: [
          { id: 'S:1', value: '#FF0000' },
          { id: 'S:2', value: 'not-a-paint(' },
        ],
      },
      stubClient({
        sent,
        reply: { results: [{ id: 'S:1', index: 0 }] },
      }),
    )
    const styles = sent[0].params?.styles as {
      id?: string
    }[]
    expect(styles).toHaveLength(1)
    expect(styles[0].id).toBe('S:1')
    const out = JSON.parse(result.content[0].text) as {
      results: { index: number }[]
      errors: { index: number; error: string }[]
    }
    expect(out.results.map(r => r.index)).toEqual([0])
    expect(out.errors[0].index).toBe(1)
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleUpdateStyles(
      { styles: [{ id: 'S:1' }] },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to update styles.',
    )
  })
})

// ─── apply_style ──────────────────────────────────────────────────────────────

describe('handleApplyStyle', () => {
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
