import { expect, test } from 'bun:test'

import {
  applyWrapperBindings,
  createBindingLookups,
  type WrapperBinding,
} from './bind-wrappers'

// A stand-in for figma.variables.setBoundVariableForPaint: returns a NEW paint
// carrying the binding, exactly as the real API does (it never mutates).
const bindPaint = (
  paint: unknown,
  field: 'color',
  variable: unknown,
): unknown => ({
  ...(paint as object),
  boundVariables: {
    [field]: { id: (variable as { id: string }).id },
  },
})

const VAR_SURFACE = { id: 'VariableID:1:2' }

const deps = (over: Record<string, unknown> = {}) => ({
  mixed: Symbol('figma.mixed'),
  setBoundVariableForPaint: bindPaint,
  variableByName: async (name: string) =>
    name === 'surface/2' ? VAR_SURFACE : null,
  styleByName: async (name: string) =>
    name === 'Brand/Primary' ? { id: 'S:abc' } : null,
  ...over,
})

const solid = (r: number) => ({
  type: 'SOLID',
  color: { r, g: 0, b: 0 },
})

// ─── var() ────────────────────────────────────────────────────────────────────

test('a var() paint binding binds the paint at its index and leaves the rest alone', async () => {
  const node = {
    type: 'FRAME',
    fills: [solid(0), solid(1)],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 1,
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(node.fills[0]).toEqual(solid(0))
  expect(node.fills[1]).toEqual({
    ...solid(1),
    boundVariables: { color: { id: 'VariableID:1:2' } },
  })
})

test('a var() paint binding with no index binds every SOLID paint (the bind_variable core)', async () => {
  const node = {
    type: 'FRAME',
    fills: [solid(0), { type: 'IMAGE', imageHash: 'h' }],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(
    (node.fills[0] as { boundVariables?: unknown })
      .boundVariables,
  ).toBeDefined()
  // a non-SOLID paint is passed through untouched
  expect(node.fills[1]).toEqual({
    type: 'IMAGE',
    imageHash: 'h',
  })
})

test('a var() scalar binding goes through setBoundVariable with the handler field', async () => {
  const calls: [string, unknown][] = []
  const node = {
    type: 'FRAME',
    setBoundVariable: (f: string, v: unknown) =>
      calls.push([f, v]),
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'cornerRadius',
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(calls).toEqual([['cornerRadius', VAR_SURFACE]])
})

test('an unresolvable var() name degrades: literal untouched, one warning, no throw', async () => {
  const node = { type: 'FRAME', fills: [solid(0)] }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'ghost/1',
        field: 'fills',
        index: 0,
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([
    'var(ghost/1): no variable with that name — literal applied unbound',
  ])
  expect(node.fills[0]).toEqual(solid(0))
})

test('a lookup that throws degrades too (never aborts the write)', async () => {
  const node = { type: 'FRAME', fills: [solid(0)] }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
      },
    ],
    deps({
      variableByName: async () => {
        throw new Error('unavailable')
      },
    }),
    warnings,
  )
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('var(surface/2)')
  expect(warnings[0]).toContain('literal applied unbound')
  expect(node.fills[0]).toEqual(solid(0))
})

test('a field the node cannot bind warns with the bind_variable wording, attributed to the wrapper', async () => {
  const node = { type: 'SLICE' }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
      },
    ],
    deps(),
    warnings,
  )
  // the core's own wording, prefixed with the token that asked for it — a node
  // can carry several wrappers, so an unattributed degrade names no loser
  expect(warnings).toEqual([
    'var(surface/2): field "fills" is not bindable on SLICE',
  ])
})

test('an index past the end of the paint array warns rather than binding nothing silently', async () => {
  const node = { type: 'FRAME', fills: [solid(0)] }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 3,
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([
    'var(surface/2): fills[3] has no bindable paint on FRAME; paint binding skipped',
  ])
})

// ─── style() ──────────────────────────────────────────────────────────────────

test('a style() binding resolves by name+category and applies via the apply_style setter', async () => {
  const applied: string[] = []
  const node = {
    type: 'FRAME',
    setFillStyleIdAsync: async (id: string) => {
      applied.push(id)
    },
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(applied).toEqual(['S:abc'])
})

test('a style() binding asks for the CATEGORY its field implies', async () => {
  const asked: [string, string][] = []
  const node = {
    type: 'TEXT',
    setTextStyleIdAsync: async () => {},
  }
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'style',
        name: 'Heading/H3',
        field: 'text',
      },
    ],
    deps({
      styleByName: async (
        name: string,
        category: string,
      ) => {
        asked.push([name, category])
        return { id: 'S:text' }
      },
    }),
    [],
  )
  expect(asked).toEqual([['Heading/H3', 'text']])
})

test('an unresolvable style() name degrades with one warning', async () => {
  const node = {
    type: 'FRAME',
    setFillStyleIdAsync: async () => {},
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'style',
        name: 'Ghost/Style',
        field: 'fill',
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([
    'style(Ghost/Style): no paint style with that name — literal applied unbound',
  ])
})

test('a setter the node type lacks warns with the apply_style wording', async () => {
  const node = { type: 'SLICE' }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([
    'style(Brand/Primary): setFillStyleIdAsync unavailable on SLICE; style not applied',
  ])
})

// ─── shape guards ─────────────────────────────────────────────────────────────

test('a payload with no bindings is a no-op', async () => {
  const node = { type: 'FRAME', fills: [solid(0)] }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    undefined,
    deps(),
    warnings,
  )
  await applyWrapperBindings(
    node,
    'not-an-array' as unknown as WrapperBinding[],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(node.fills[0]).toEqual(solid(0))
})

test('every binding is independent — one degrade never stops the next', async () => {
  const calls: string[] = []
  const node = {
    type: 'FRAME',
    setBoundVariable: (f: string) => calls.push(f),
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'ghost/1',
        field: 'cornerRadius',
      },
      {
        kind: 'var',
        name: 'surface/2',
        field: 'strokeWeight',
      },
    ],
    deps(),
    warnings,
  )
  expect(warnings.length).toBe(1)
  expect(calls).toEqual(['strokeWeight'])
})

// ─── name lookups ─────────────────────────────────────────────────────────────

test('lookups enumerate once and answer every later hit from the cache', async () => {
  let loads = 0
  const lookups = createBindingLookups({
    listVariables: async () => {
      loads += 1
      return [{ id: 'v1', name: 'surface/2' }]
    },
  })
  expect(await lookups.variableByName('surface/2')).toEqual(
    { id: 'v1', name: 'surface/2' },
  )
  expect(await lookups.variableByName('surface/2')).toEqual(
    { id: 'v1', name: 'surface/2' },
  )
  expect(loads).toBe(1)
})

test('a miss is a miss — N bogus names cost ONE scan, not one document scan each', async () => {
  let loads = 0
  const lookups = createBindingLookups({
    listVariables: async () => {
      loads += 1
      return []
    },
  })
  expect(await lookups.variableByName('ghost')).toBeNull()
  expect(await lookups.variableByName('ghost')).toBeNull()
  expect(
    await lookups.variableByName('other-ghost'),
  ).toBeNull()
  expect(loads).toBe(1)
})

test('a name that collides across collections resolves FIRST-wins, deterministically', async () => {
  const lookups = createBindingLookups({
    listVariables: async () => [
      { id: 'v1', name: 'surface/2' },
      { id: 'v2', name: 'surface/2' },
    ],
  })
  // Two collections can publish one name; inline the grammar has only the name
  // to go on, so the first match wins and the spec says the cost out loud.
  expect(await lookups.variableByName('surface/2')).toEqual(
    { id: 'v1', name: 'surface/2' },
  )
})

test('reset() drops the cache so the next command sees the document as it is now', async () => {
  let loads = 0
  const lookups = createBindingLookups({
    listVariables: async () => {
      loads += 1
      return [{ id: 'v1', name: 'surface/2' }]
    },
  })
  await lookups.variableByName('surface/2')
  lookups.reset()
  await lookups.variableByName('surface/2')
  expect(loads).toBe(2)
})

test('an unavailable lookup API throws — the caller degrades it to a warning (T7)', async () => {
  const lookups = createBindingLookups({})
  await expect(
    lookups.variableByName('surface/2'),
  ).rejects.toThrow(/unavailable/)
})

test('styles resolve by name within their own category', async () => {
  const lookups = createBindingLookups({
    listStyles: {
      paint: async () => [
        { id: 'S:1', name: 'Brand/Primary' },
      ],
      text: async () => [
        { id: 'S:2', name: 'Brand/Primary' },
      ],
    },
  })
  expect(
    await lookups.styleByName('Brand/Primary', 'paint'),
  ).toEqual({ id: 'S:1', name: 'Brand/Primary' })
  expect(
    await lookups.styleByName('Brand/Primary', 'text'),
  ).toEqual({ id: 'S:2', name: 'Brand/Primary' })
  expect(
    await lookups.styleByName('Ghost/Style', 'paint'),
  ).toBeNull()
})
