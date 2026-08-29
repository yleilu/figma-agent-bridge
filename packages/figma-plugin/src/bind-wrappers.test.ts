import { expect, test } from 'bun:test'

import {
  applyWrapperBindings,
  createBindingLookups,
  type WrapperBinding,
  clearNodeField,
} from './bind-wrappers'

// A stand-in for figma.variables.setBoundVariableForPaint: returns a NEW paint
// carrying the binding, exactly as the real API does (it never mutates).
//
// AND IT DOES NOT KEEP THE PAINT'S OPACITY — which is B68. The bind re-resolves
// the paint's colour through the variable, and a SolidPaint keeps its alpha in
// `opacity`, so the channel the write stated is gone. Reproduced live three
// times: `fills:['var(x)#22D3EE{op=0.2}']` applied clean, warned about
// nothing, read back `var(x)#22D3EE`, and rendered opaque — while the plain
// `#FF0000{op=0.2}` beside it kept its alpha.
//
// The fake models the OUTCOME, which is what the reproductions pin, not the
// mechanism inside Figma, which they do not. A paint that never stated an
// opacity is unaffected either way.
const bindPaint = (
  paint: unknown,
  field: 'color',
  variable: unknown,
): unknown => {
  const { opacity: _dropped, ...rest } = paint as {
    opacity?: number
  }
  return {
    ...rest,
    boundVariables: {
      [field]: { id: (variable as { id: string }).id },
    },
  }
}

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

// ─── B68: the bind keeps the paint's stated opacity ──────────────────────────

test('a var() paint binding keeps the opacity the write stated', async () => {
  const node = {
    type: 'FRAME',
    fills: [{ ...solid(0), opacity: 0.2 }],
  }
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
  expect(warnings).toEqual([])
  expect(node.fills[0]).toEqual({
    ...solid(0),
    opacity: 0.2,
    boundVariables: { color: { id: 'VariableID:1:2' } },
  })
})

test('the bind_variable core (no index) keeps every paint its own opacity', async () => {
  const node = {
    type: 'FRAME',
    fills: [
      { ...solid(0), opacity: 0.2 },
      { ...solid(1), opacity: 0.9 },
    ],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [{ kind: 'var', name: 'surface/2', field: 'fills' }],
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(
    node.fills.map(
      f => (f as { opacity?: number }).opacity,
    ),
  ).toEqual([0.2, 0.9])
})

test('a paint that stated no opacity gains none — the bind is left alone', async () => {
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
    deps(),
    warnings,
  )
  expect(warnings).toEqual([])
  expect('opacity' in (node.fills[0] as object)).toBe(false)
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

// ─── B58: taking a token OFF a field ─────────────────────────────────────────
//
// Proven live: writing a literal over a bound field does NOT unbind it. A bar
// whose gap was bound to space/16, given `{gap: 16}`, still read back
// `var(space/16)16`. So "no token here" needs its own door — Figma spells it
// `setBoundVariable(field, null)`, and this is the only caller of that spelling.

test('clearNodeField clears the binding with a null variable', () => {
  const calls: [string, unknown][] = []
  const warnings: string[] = []
  clearNodeField(
    {
      type: 'FRAME',
      setBoundVariable: (f: string, v: unknown) => {
        calls.push([f, v])
      },
    },
    'itemSpacing',
    warnings,
  )
  expect(calls).toEqual([['itemSpacing', null]])
  expect(warnings).toEqual([])
})

test('clearNodeField degrades on a runtime without setBoundVariable', () => {
  const warnings: string[] = []
  expect(() =>
    clearNodeField(
      { type: 'FRAME' },
      'itemSpacing',
      warnings,
    ),
  ).not.toThrow()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('not cleared')
})

test('clearNodeField names a field Figma refuses to clear', () => {
  const warnings: string[] = []
  clearNodeField(
    {
      type: 'FRAME',
      setBoundVariable: () => {
        throw new Error('not a bindable field')
      },
    },
    'itemSpacing',
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('itemSpacing')
})

// ─── gradient stops (I59) ────────────────────────────────────────────────────
//
// A gradient's colours are per stop, and Figma binds them there: the ColorStop
// carries `boundVariables.color`, and the only sanctioned way to write one is a
// VariableAlias from `createVariableAlias`. `setBoundVariableForPaint` cannot
// reach a stop at all — it binds the PAINT — so this is a second route, not a
// parameter of the first, and it degrades on its own terms.
//
// The fake models the real constraint on both sides: `createVariableAlias`
// mints the alias object, and a runtime that does not carry stop bindings
// ACCEPTS the assignment and drops the field, which is why the write is read
// back rather than trusted.

const alias = (variable: unknown): unknown => ({
  type: 'VARIABLE_ALIAS',
  id: (variable as { id: string }).id,
})

const gradient = (stops: Record<string, unknown>[]) => ({
  type: 'GRADIENT_LINEAR',
  gradientStops: stops,
})

const stop = (position: number) => ({
  position,
  color: { r: 1, g: 1, b: 1, a: 1 },
})

const stopOf = (
  node: { fills: unknown[] },
  paint: number,
  index: number,
): Record<string, unknown> =>
  (
    node.fills[paint] as {
      gradientStops: Record<string, unknown>[]
    }
  ).gradientStops[index]

test('a var() stop binding binds THAT stop and leaves its neighbour alone', async () => {
  const node = {
    type: 'FRAME',
    fills: [gradient([stop(0), stop(1)])],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 1,
      },
    ],
    deps({ createVariableAlias: alias }),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(stopOf(node, 0, 1).boundVariables).toEqual({
    color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' },
  })
  expect(stopOf(node, 0, 0).boundVariables).toBeUndefined()
  // The colour itself is untouched — binding is additive.
  expect(stopOf(node, 0, 1).color).toEqual({
    r: 1,
    g: 1,
    b: 1,
    a: 1,
  })
})

test('two stops of one paint bind independently', async () => {
  const node = {
    type: 'FRAME',
    fills: [gradient([stop(0), stop(1)])],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 0,
      },
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 1,
      },
    ],
    deps({ createVariableAlias: alias }),
    warnings,
  )
  expect(warnings).toEqual([])
  // The second binding must not undo the first: each write rebuilds the array
  // from the CURRENT stops, not from the ones the call started with.
  expect(stopOf(node, 0, 0).boundVariables).toBeDefined()
  expect(stopOf(node, 0, 1).boundVariables).toBeDefined()
})

test('a stop binding does NOT need setBoundVariableForPaint', async () => {
  // It binds through the ColorStop. Refusing it for the absence of a member it
  // never uses would make a whole gradient unbindable on a runtime that only
  // lacks the paint setter.
  const node = {
    type: 'FRAME',
    fills: [gradient([stop(0)])],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 0,
      },
    ],
    deps({
      createVariableAlias: alias,
      setBoundVariableForPaint: undefined,
    }),
    warnings,
  )
  expect(warnings).toEqual([])
  expect(stopOf(node, 0, 0).boundVariables).toBeDefined()
})

test('T7 — a runtime without createVariableAlias degrades to the literal and says so', async () => {
  const node = {
    type: 'FRAME',
    fills: [gradient([stop(0)])],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 0,
      },
    ],
    deps({ createVariableAlias: undefined }),
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('createVariableAlias')
  expect(warnings[0]).toContain('var(surface/2)')
  // The colour is still there — a missing binding never costs the write.
  expect(stopOf(node, 0, 0).color).toBeDefined()
})

test('T7 — a runtime that silently DROPS the stop binding is caught by the read-back', async () => {
  // The dangerous shape: the assignment is accepted, the field is not kept,
  // and nothing throws. Without the verify the reply would report a token the
  // file does not hold.
  const stops = [stop(0)]
  const node = {
    type: 'FRAME',
    get fills(): unknown[] {
      return [gradient(stops)]
    },
    set fills(_v: unknown[]) {
      // Accepts and discards, exactly as an older runtime does.
    },
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 0,
      },
    ],
    deps({ createVariableAlias: alias }),
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(
    'does not bind gradient stops',
  )
})

test('a stop index the paint does not have is named, not silently skipped', async () => {
  const node = {
    type: 'FRAME',
    fills: [gradient([stop(0)])],
  }
  const warnings: string[] = []
  await applyWrapperBindings(
    node,
    [
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
        stop: 4,
      },
    ],
    deps({ createVariableAlias: alias }),
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('no gradient stop')
})

test('a stop on a SOLID paint is named, not silently skipped', async () => {
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
        stop: 0,
      },
    ],
    deps({ createVariableAlias: alias }),
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('no gradient stop')
})
