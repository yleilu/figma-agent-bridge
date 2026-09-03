// style-refs.test.ts — rules 3 and 4, and the ride-along differ (B47).
//
// A reference has no literal half, so a name that resolves to nothing (rule 4)
// or to a style of the wrong type for the slot (rule 3) is an ERROR, not the
// degrade a wrapper-on-a-literal gets. The resolved list a reference carries is
// never applied as literals — when it is not what the style supplies, the write
// says so and lands the style anyway (a warning, never a rejection).

import { describe, expect, it } from 'bun:test'
import {
  createStyleCatalogue,
  resolveStyleReferences,
  type StyleCatalogue,
  type StyleTable,
} from '@figma-agent-bridge/server/serialize/style-refs'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'

const BLUR = 'bg-blur(24)'
const SHADOW = 'shadow(0,8,24,#00000066)'

/** A file whose styles are exactly these — the resolution rules 3/4 read. */
const catalogue = (
  entries: {
    name: string
    category: string
    atoms?: string[]
  }[],
): StyleCatalogue => {
  const table: StyleTable = new Map()
  for (const e of entries) {
    const record = {
      name: e.name,
      category: e.category,
      ...(e.atoms !== undefined ? { atoms: e.atoms } : {}),
    }
    table.set(e.name, [
      ...(table.get(e.name) ?? []),
      record,
    ])
  }
  return { table: () => Promise.resolve(table) }
}

const FILE = catalogue([
  { name: 'AB/Blur', category: 'effect', atoms: [BLUR] },
  {
    name: 'AB/Stack',
    category: 'effect',
    atoms: [BLUR, SHADOW],
  },
  {
    name: 'Glass/Fill',
    category: 'paint',
    atoms: ['#141B2E99'],
  },
  {
    name: 'Layout/12col',
    category: 'grid',
    atoms: ['columns(12,0,24)'],
  },
  { name: 'Heading/H1', category: 'text' },
])

const resolve = async (
  spec: Parameters<typeof specToFigma>[0],
  file: StyleCatalogue = FILE,
): Promise<{
  payload: Record<string, unknown>
  warnings: string[]
}> => {
  const warnings: string[] = []
  const payload = specToFigma(spec, warnings)
  await resolveStyleReferences(payload, file, warnings)
  return { payload, warnings }
}

describe('rule 3 — a style of the wrong type for the slot', () => {
  it('rejects a paint style named on effects, naming both types', async () => {
    await expect(
      resolve({ effects: 'style(Glass/Fill)' }),
    ).rejects.toThrow(
      'style(Glass/Fill) is a paint style, but effects needs an effect ' +
        'style — name an effect style that holds what you want, or write the ' +
        'effects as literals',
    )
  })

  it('rejects an effect style named on fills', async () => {
    await expect(
      resolve({ fills: 'style(AB/Blur)' }),
    ).rejects.toThrow(
      'style(AB/Blur) is an effect style, but fills needs a paint style',
    )
  })

  it('rejects a text style named on an array field — the scalar slot is not this one', async () => {
    await expect(
      resolve({ fills: 'style(Heading/H1)' }),
    ).rejects.toThrow(
      'style(Heading/H1) is a text style, but fills needs a paint style',
    )
  })

  it('reads the ONE-ENTRY ARRAY spelling as the same input', async () => {
    await expect(
      resolve({ effects: ['style(Glass/Fill)'] }),
    ).rejects.toThrow('is a paint style')
  })

  it('carries INVALID_PARAM, not a plugin failure', async () => {
    try {
      await resolve({ effects: 'style(Glass/Fill)' })
      throw new Error('expected a rejection')
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        'INVALID_PARAM',
      )
    }
  })

  it('a paint style is legal on strokes — both paint slots resolve one category', async () => {
    const { payload } = await resolve({
      strokes: 'style(Glass/Fill)[#141B2E99]',
    })
    expect(payload.bindings).toEqual([
      {
        kind: 'style',
        name: 'Glass/Fill',
        field: 'stroke',
      },
    ])
  })
})

describe('rule 4 — a name that resolves to nothing', () => {
  it('rejects the scalar reference with a teach-the-fix message', async () => {
    await expect(
      resolve({ effects: 'style(Ghost)' }),
    ).rejects.toThrow(
      'style(Ghost) matches no effect style in this file, and a reference has ' +
        'no literal half to fall back on — check the name, create the style, ' +
        'or write the effects as literals',
    )
  })

  it('reads the ONE-ENTRY ARRAY spelling as the same input', async () => {
    await expect(
      resolve({ effects: [`style(Ghost)${BLUR}`] }),
    ).rejects.toThrow(
      'matches no effect style in this file',
    )
  })

  it('names the grids slot on a grid miss', async () => {
    await expect(
      resolve({ grids: 'style(Ghost)' }),
    ).rejects.toThrow('matches no grid style in this file')
  })

  it('carries INVALID_PARAM', async () => {
    try {
      await resolve({ fills: 'style(Ghost)' })
      throw new Error('expected a rejection')
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        'INVALID_PARAM',
      )
    }
  })
})

describe('warn-on-differ — the ride-along is named, not obeyed', () => {
  it('a verbatim write-back is silent: the list IS the style content', async () => {
    const { warnings } = await resolve({
      effects: `style(AB/Stack)[${BLUR}, ${SHADOW}]`,
    })
    expect(warnings).toEqual([])
  })

  it('an extra effect written beside the style is named', async () => {
    const { warnings } = await resolve({
      effects: `style(AB/Blur)[${BLUR}, ${SHADOW}]`,
    })
    expect(warnings).toEqual([
      `style(AB/Blur) owns effects — it supplies [${BLUR}], so the 1 extra ` +
        'effect written beside it was not applied; add it to the style, or ' +
        'write every effect as a literal.',
    ])
  })

  it('counts the extras and pluralises', async () => {
    const { warnings } = await resolve({
      effects: `style(AB/Blur)[${BLUR}, ${SHADOW}, blur(4)]`,
    })
    expect(warnings[0]).toContain('the 2 extra effects')
    expect(warnings[0]).toContain('were not applied')
    expect(warnings[0]).toContain('add them to the style')
  })

  it('a STALE list with no extras is still reported — order and count included', async () => {
    const { warnings } = await resolve({
      effects: `style(AB/Stack)[${SHADOW}, ${BLUR}]`,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      `it supplies [${BLUR}, ${SHADOW}]`,
    )
    expect(warnings[0]).toContain('is not what landed')
  })

  it('a short list is reported too — the style gained an entry since the read', async () => {
    const { warnings } = await resolve({
      effects: `style(AB/Stack)[${BLUR}]`,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('is not what landed')
  })

  // Every accepted spelling of the same claim must warn identically — no
  // spelling is the quiet one.
  it('fires identically for the bracketed list, the legacy lone atom and the array-wrapped read form', async () => {
    const bracketed = await resolve({
      effects: `style(AB/Blur)[${SHADOW}]`,
    })
    const legacy = await resolve({
      effects: [`style(AB/Blur)${SHADOW}`],
    })
    const wrapped = await resolve({
      effects: [`style(AB/Blur)[${SHADOW}]`],
    })
    expect(legacy.warnings).toEqual(bracketed.warnings)
    expect(wrapped.warnings).toEqual(bracketed.warnings)
    expect(bracketed.warnings).toHaveLength(1)
  })

  it('fires identically for the MULTI-ENTRY legacy spelling', async () => {
    const bracketed = await resolve({
      effects: `style(AB/Blur)[${BLUR}, ${SHADOW}]`,
    })
    const multi = await resolve({
      effects: [
        `style(AB/Blur)${BLUR}`,
        `style(AB/Blur)${SHADOW}`,
      ],
    })
    expect(multi.warnings).toEqual(bracketed.warnings)
    expect(multi.warnings).toHaveLength(1)
    expect(multi.warnings[0]).toContain(
      'the 1 extra effect written beside it',
    )
  })

  // The whole point of the sugar: a 0.4.0 read-back of a MULTI-VALUE style is
  // writable again, and silently.
  it('a legacy multi-entry read-back of a two-effect style is a silent no-op', async () => {
    const { payload, warnings } = await resolve({
      effects: [
        `style(AB/Stack)${BLUR}`,
        `style(AB/Stack)${SHADOW}`,
      ],
    })
    expect(warnings).toEqual([])
    expect('effects' in payload).toBe(false)
    expect(payload.bindings).toEqual([
      { kind: 'style', name: 'AB/Stack', field: 'effect' },
    ])
  })

  it('a legacy multi-entry read-back that has gone stale still warns', async () => {
    const { warnings } = await resolve({
      effects: [
        `style(AB/Stack)${SHADOW}`,
        `style(AB/Stack)${BLUR}`,
      ],
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('is not what landed')
  })

  it('a bare reference claims nothing, so there is nothing to differ from', async () => {
    const { warnings } = await resolve({
      effects: 'style(AB/Blur)',
    })
    expect(warnings).toEqual([])
  })

  it('compares CANONICAL atoms — a different spelling of the same paint is not a difference', async () => {
    const { warnings } = await resolve({
      fills: 'style(Glass/Fill)[rgba(20,27,46,0.6)]',
    })
    expect(warnings).toEqual([])
  })

  it('says nothing when the style content cannot be rendered — no invented difference', async () => {
    const { warnings } = await resolve(
      { effects: `style(Opaque)[${BLUR}]` },
      catalogue([{ name: 'Opaque', category: 'effect' }]),
    )
    expect(warnings).toEqual([])
  })

  it('is a WARNING, never a rejection — the style still lands', async () => {
    const { payload, warnings } = await resolve({
      effects: `style(AB/Blur)[${SHADOW}]`,
    })
    expect(warnings).toHaveLength(1)
    expect('effects' in payload).toBe(false)
    expect(payload.bindings).toEqual([
      { kind: 'style', name: 'AB/Blur', field: 'effect' },
    ])
  })
})

describe('the wire', () => {
  it('strips the server-side halves — the plugin is sent only what it reads', async () => {
    const { payload } = await resolve({
      effects: `style(AB/Blur)[${BLUR}]`,
    })
    expect(payload.bindings).toEqual([
      { kind: 'style', name: 'AB/Blur', field: 'effect' },
    ])
    expect(JSON.stringify(payload)).not.toContain(
      'rideAlong',
    )
    expect(JSON.stringify(payload)).not.toContain('owns')
  })

  it('strips them on an unstyled write too, with no style read at all', async () => {
    let asked = 0
    const counting: StyleCatalogue = {
      table: () => {
        asked += 1
        return Promise.resolve(new Map())
      },
    }
    const payload = specToFigma({ fills: ['#FF0000'] })
    await resolveStyleReferences(payload, counting)
    expect(asked).toBe(0)
  })

  it('reaches a reference nested inside a converted tree', async () => {
    const tree = {
      tree: {
        type: 'FRAME',
        children: [
          specToFigma({ effects: 'style(Ghost)' }),
        ],
      },
    }
    await expect(
      resolveStyleReferences(tree, FILE),
    ).rejects.toThrow('matches no effect style')
  })

  it('reads the file’s styles ONCE however many references a write carries', async () => {
    let asked = 0
    const counting: StyleCatalogue = {
      table: () => {
        asked += 1
        return Promise.resolve(
          new Map([
            [
              'Glass/Fill',
              [
                {
                  name: 'Glass/Fill',
                  category: 'paint',
                  atoms: ['#141B2E99'],
                },
              ],
            ],
          ]),
        )
      },
    }
    const payload = {
      a: specToFigma({ fills: 'style(Glass/Fill)' }),
      b: specToFigma({ strokes: 'style(Glass/Fill)' }),
    }
    await resolveStyleReferences(payload, counting)
    expect(asked).toBe(1)
  })
})

describe('createStyleCatalogue', () => {
  it('indexes every category by name and renders each style’s WHOLE content', async () => {
    const cat = createStyleCatalogue({
      sendCommand: () =>
        Promise.resolve({
          paint: [
            {
              id: 'S:1',
              name: 'Glass/Fill',
              values: [
                {
                  type: 'SOLID',
                  color: { r: 0.078, g: 0.106, b: 0.18 },
                  opacity: 0.6,
                },
              ],
            },
          ],
          effect: [
            {
              id: 'S:2',
              name: 'AB/Stack',
              values: [
                { type: 'BACKGROUND_BLUR', radius: 24 },
                {
                  type: 'DROP_SHADOW',
                  color: { r: 0, g: 0, b: 0, a: 0.4 },
                  offset: { x: 0, y: 8 },
                  radius: 24,
                },
              ],
            },
          ],
          text: [{ id: 'S:3', name: 'Heading/H1' }],
        }),
    } as never)
    const table = await cat.table()
    expect(table.get('Glass/Fill')).toEqual([
      {
        name: 'Glass/Fill',
        category: 'paint',
        atoms: ['#141B2E99'],
      },
    ])
    // Both effects, in order — a style is a whole list, not its first entry.
    expect(table.get('AB/Stack')?.[0].atoms).toEqual([
      BLUR,
      SHADOW,
    ])
    // A text style is a scalar slot: it is INDEXED (so rule 3 can name it) but
    // has no list to compare against.
    expect(table.get('Heading/H1')).toEqual([
      { name: 'Heading/H1', category: 'text' },
    ])
  })

  it('surfaces a plugin-side {error} rather than resolving every name to nothing', async () => {
    const cat = createStyleCatalogue({
      sendCommand: () =>
        Promise.resolve({
          error: 'getLocalGridStylesAsync is unavailable',
        }),
    } as never)
    await expect(cat.table()).rejects.toThrow(
      'getLocalGridStylesAsync is unavailable',
    )
  })
})
