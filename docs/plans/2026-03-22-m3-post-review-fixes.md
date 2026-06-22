# M3 Post-Review Fixes — Implementation Plan

## Goal

Fix 5 type-safety, consistency, and error-reporting issues discovered during M3 code review, using strict TDD with code review at RED stage.

## Architecture

No new architecture. All changes are internal refactors to existing M3 code:
- **Expression parser** — replace flat interfaces with discriminated unions, fix hex regex consistency
- **Schema layer** — eliminate `.innerType()` workaround for MCP tool registration
- **Plugin layer** — add error reporting for unavailable `createSlot` API

**Execution model:** Each task runs as an independent subagent in a git worktree, merged back via fast-forward (no merge commits). Tasks are parallelizable — no shared state between them.

## Tech Stack

- Runtime: Bun
- Test: `bun:test`
- Schema: Zod
- Language: TypeScript (strict)

---

## File Map

### Modified Files

| File | Tasks | Changes |
|------|-------|---------|
| `packages/server/src/expression-parser.ts` | T1, T3 | Discriminated union types, hex regex alignment |
| `packages/server/test/expression-parser.test.ts` | T1, T3 | Add type narrowing to tests, add 3-char hex tests |
| `packages/shared/src/create-schemas.ts` | T2 | Remove `.refine()`, keep validation logic |
| `packages/server/src/index.ts` | T2 | Remove `.innerType()`, add manual validation |
| `packages/server/src/tools/create-component.ts` | T2 | Add nodeId/nodeIds guard |
| `packages/server/test/tools/create-component.test.ts` | T2 | Test missing nodeId/nodeIds error |
| `packages/figma-plugin/src/code.ts` | T4, T5 | createSlot error reporting, fills/strokes guards |
| `docs/expression-formats.md` | T3 | Fix #000/#FFF example, clarify shorthand policy |

---

## Task 1: ParsedPaint/ParsedEffect Discriminated Union

**Goal:** Replace flat interfaces with discriminated unions. Eliminate all 7 `as unknown as` casts.

**Files:**
- Modify: `packages/server/src/expression-parser.ts`
- Modify: `packages/server/test/expression-parser.test.ts`

### TDD Flow

#### RED — Write failing tests

Update `expression-parser.test.ts`:

```typescript
// Test type narrowing works correctly
it('solid paint has color but not gradientStops', () => {
  const result = parseColorExpression('#3B82F6')
  expect(result.type).toBe('SOLID')
  if (result.type === 'SOLID') {
    expect(result.color.r).toBeCloseTo(0.231, 2)
    // TypeScript should know gradientStops doesn't exist here
  }
})

it('gradient paint has gradientStops but not imageUrl', () => {
  const result = parseColorExpression('linear-gradient(90deg, #FF0000 0%, #0000FF 100%)')
  expect(result.type).toBe('GRADIENT_LINEAR')
  if (result.type === 'GRADIENT_LINEAR') {
    expect(result.gradientStops.length).toBe(2)
    expect(result.angle).toBe(90)
  }
})

it('image paint has imageUrl but not color', () => {
  const result = parseColorExpression('image(https://example.com/photo.jpg)')
  expect(result.type).toBe('IMAGE')
  if (result.type === 'IMAGE') {
    expect(result.imageUrl).toBe('https://example.com/photo.jpg')
  }
})
```

Update existing tests to use narrowing guards instead of raw casts.

**Run test — expect RED** (compile errors from accessing wrong variant fields)

#### REVIEW — Code review the RED tests

Dispatch code-reviewer subagent to check:
- Are expectations aligned with the discriminated union design?
- Are edge cases covered (each variant type)?
- Are assertions specific enough?

#### GREEN — Implement discriminated union

In `expression-parser.ts`, replace:

```typescript
// Before: flat interface
export interface ParsedPaint {
  type: 'SOLID' | 'GRADIENT_LINEAR' | ...
  color: { r: number; g: number; b: number }
  opacity: number
  gradientStops: ParsedGradientStop[]
  angle: number
  imageUrl: string
  imageHash: string
  scaleMode: string
  styleName: string
}

// After: discriminated union
export type ParsedSolidPaint = {
  type: 'SOLID'
  color: { r: number; g: number; b: number }
  opacity: number
  styleName?: string
}

export type ParsedGradientPaint = {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND'
  gradientStops: ParsedGradientStop[]
  angle: number
  styleName?: string
}

export type ParsedImagePaint = {
  type: 'IMAGE'
  imageUrl?: string
  imageHash?: string
  scaleMode?: string
  styleName?: string
}

export type ParsedPaint = ParsedSolidPaint | ParsedGradientPaint | ParsedImagePaint
```

Apply same pattern to `ParsedEffect`:

```typescript
export type ParsedShadowEffect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW'
  offset: { x: number; y: number }
  radius: number
  spread: number
  color: { r: number; g: number; b: number; a: number }
  styleName?: string
}

export type ParsedBlurEffect = {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'
  radius: number
  styleName?: string
}

export type ParsedEffect = ParsedShadowEffect | ParsedBlurEffect
```

Remove all `as unknown as ParsedPaint` and `as unknown as ParsedEffect` casts — return object literals directly.

**Run test — expect GREEN**

#### REFACTOR

- Verify no remaining `as unknown as` casts in expression-parser.ts
- Check consumers in `create.ts` and `code.ts` still compile (they pass `ParsedPaint[]` opaquely)

### Verification

```bash
bun test packages/server/test/expression-parser.test.ts
bun test packages/server/test/tools/create.test.ts
```

---

## Task 2: Schema Refine Workaround

**Goal:** Remove `.refine()` from `createComponentParamsSchema`, move validation to handler. Restore clean `.shape` access for MCP registration.

**Files:**
- Modify: `packages/shared/src/create-schemas.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/tools/create-component.ts`
- Modify: `packages/server/test/tools/create-component.test.ts`
- Modify: `packages/server/test/create-schemas.test.ts`

### TDD Flow

#### RED — Write failing tests

In `create-component.test.ts`, add:

```typescript
it('returns error when neither nodeId nor nodeIds provided', async () => {
  const result = await handleCreateComponent(
    { combineAsVariants: false },
    mockClient,
  )
  expect(result.content[0].text).toContain('nodeId or nodeIds')
})
```

In `create-schemas.test.ts`, update the existing rejection test:

```typescript
it('accepts empty object at schema level (validation moved to handler)', () => {
  // Schema no longer has .refine() — empty object passes schema
  const result = createComponentParamsSchema.safeParse({})
  expect(result.success).toBe(true)
})
```

**Run test — expect RED**

#### REVIEW — Code review the RED tests

Dispatch code-reviewer subagent.

#### GREEN — Implement

1. `create-schemas.ts`: Remove `.refine()` from `createComponentParamsSchema`
2. `index.ts`: Change `createComponentParamsSchema.innerType().shape` to `createComponentParamsSchema.shape`
3. `create-component.ts`: Add guard at top of `handleCreateComponent`:

```typescript
if (!params.nodeId && !params.nodeIds) {
  return {
    content: [{ type: 'text' as const, text: 'Error: Either nodeId or nodeIds must be provided.' }],
  }
}
```

**Run test — expect GREEN**

### Verification

```bash
bun test packages/server/test/tools/create-component.test.ts
bun test packages/server/test/create-schemas.test.ts
bun test packages/server/test/
```

---

## Task 3: Hex Shorthand Consistency

**Goal:** Align 3-char hex handling: narrow to 6/8 chars only (matching docs), fix gradient doc example, tighten shadow regex.

**Files:**
- Modify: `packages/server/src/expression-parser.ts`
- Modify: `packages/server/test/expression-parser.test.ts`
- Modify: `docs/expression-formats.md`

### TDD Flow

#### RED — Write failing tests

```typescript
it('rejects 3-char hex in solid color', () => {
  // After fix: 3-char hex should not be accepted
  expect(() => parseColorExpression('#F00')).toThrow()
})

it('shadow with full hex works', () => {
  const result = parseEffectExpression('shadow(0,4,8,#000000)')
  expect(result.type).toBe('DROP_SHADOW')
  if (result.type === 'DROP_SHADOW') {
    expect(result.color.r).toBe(0)
    expect(result.color.g).toBe(0)
    expect(result.color.b).toBe(0)
  }
})

it('shadow rejects 3-char hex', () => {
  const result = parseEffectExpression('shadow(0,4,8,#000)')
  // After fix: returns null (no match) because regex requires 6-8 chars
  expect(result).toBeNull()
})
```

Update existing `shadow(0,4,8,#000)` test to use `#000000`.

**Run test — expect RED**

#### REVIEW — Code review the RED tests

Dispatch code-reviewer subagent.

#### GREEN — Implement

1. `expression-parser.ts`: Remove 3-char expansion from `hexToRgb` (lines 79-88)
2. `expression-parser.ts`: Change shadow regex from `{3,8}` to `{6,8}` (line 218)
3. `expression-parser.ts`: Add validation in `parseColorExpression` — reject hex strings that aren't 6 or 8 chars after stripping `#`
4. `docs/expression-formats.md`: Fix line 29 example — change `#000` to `#000000` and `#FFF` to `#FFFFFF`

**Run test — expect GREEN**

### Verification

```bash
bun test packages/server/test/expression-parser.test.ts
bun test packages/server/test/
```

---

## Task 4: createSlot Error Reporting

**Goal:** Add explicit error when `createSlot` is unavailable instead of silently succeeding.

**Files:**
- Modify: `packages/figma-plugin/src/code.ts`
- Modify: `packages/server/test/integration/e2e-create.test.ts`
- Modify: `packages/server/test/mocks/mock-plugin.ts`

### TDD Flow

#### RED — Write failing tests

In `e2e-create.test.ts`, add:

```typescript
it('create_component reports error when createSlot unavailable', async () => {
  // Mock plugin should simulate createSlot being absent
  const result = await callTool('create_component', {
    nodeId: '1:2',
    slots: ['Content'],
  })
  const parsed = JSON.parse(result.content[0].text)
  expect(parsed.warning).toContain('createSlot')
})
```

Update `mock-plugin.ts` to simulate `createSlot` being absent for this test case.

**Run test — expect RED**

#### REVIEW — Code review the RED tests

Dispatch code-reviewer subagent.

#### GREEN — Implement

In `code.ts`, add else branch after the `createSlot` guard:

```typescript
if (compWithSlot.createSlot) {
  for (const slotName of slots) {
    compWithSlot.createSlot(slotName)
  }
} else {
  // Report that slots were requested but couldn't be created
  return {
    id: comp.id,
    name: comp.name,
    type: comp.type,
    key: comp.key,
    warning: 'createSlot is not available in this Figma version; requested slots were not created.',
  }
}
```

**Run test — expect GREEN**

### Verification

```bash
bun test packages/server/test/integration/e2e-create.test.ts
bun test packages/server/test/
```

---

## Task 5: SECTION Node fills/strokes Guards

**Goal:** Add `'in node'` guards for `fills`, `strokes`, and related geometry properties to prevent crashes on SECTION nodes.

**Files:**
- Modify: `packages/figma-plugin/src/code.ts`
- Modify: `packages/server/test/integration/e2e-create.test.ts`
- Modify: `packages/server/test/mocks/mock-plugin.ts`

### TDD Flow

#### RED — Write failing tests

In `e2e-create.test.ts`, add:

```typescript
it('creates SECTION node without crash on fills/strokes', async () => {
  const result = await callTool('create_node', {
    parentId: '0:1',
    node: {
      type: 'SECTION',
      name: 'Test Section',
      size: [400, 300],
      fills: ['#FF0000'],
    },
  })
  const parsed = JSON.parse(result.content[0].text)
  expect(parsed.type).toBe('SECTION')
  // Should succeed without throwing SECTION doesn't support fills
})
```

Update `mock-plugin.ts` to simulate SECTION node behavior (no `fills` property on the mock node).

**Run test — expect RED**

#### REVIEW — Code review the RED tests

Dispatch code-reviewer subagent.

#### GREEN — Implement

In `code.ts` `applyCommonProperties`, wrap fills/strokes assignments:

```typescript
// Before:
(node as GeometryMixin & SceneNode).fills = parsedFills

// After:
if ('fills' in node) {
  (node as GeometryMixin & SceneNode).fills = parsedFills
}
```

Apply same pattern to: `strokes`, `strokeWeight`, `strokeAlign`, `dashPattern`, `fillStyleId`, `strokeStyleId`.

**Run test — expect GREEN**

### Verification

```bash
bun test packages/server/test/integration/e2e-create.test.ts
bun test packages/server/test/
```

---

## Execution Strategy

### Parallel Worktree Subagents

Each task runs in an isolated git worktree:

```
Task 1 (ParsedPaint union)     → worktree branch: fix/parsed-paint-union
Task 2 (Schema refine)         → worktree branch: fix/schema-refine
Task 3 (Hex shorthand)         → worktree branch: fix/hex-shorthand
Task 4 (createSlot error)      → worktree branch: fix/createslot-error
Task 5 (SECTION guards)        → worktree branch: fix/section-guards
```

### Merge Strategy

After each task completes and passes tests:
1. Checkout `dev`
2. `git merge --ff-only fix/<branch>` (no merge commit)
3. Delete worktree branch

**Merge order matters** for T1 and T3 (both touch `expression-parser.ts`):
- Merge T1 (ParsedPaint union) first
- Then T3 (hex shorthand) — may need rebase onto updated `dev`

T2, T4, T5 are fully independent — merge in any order.

### Post-Merge

1. Run full test suite: `bun test packages/server/test/`
2. Dispatch final code-reviewer on all changed files
3. Commit with user approval

---

## Verification

```bash
# After all merges
bun test packages/server/test/
# Expected: 228+ pass, 0 fail

# Type check
bunx tsc --noEmit
```
