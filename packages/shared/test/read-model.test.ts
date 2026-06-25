// packages/shared/test/read-model.test.ts
import { describe, expect, it } from 'bun:test'
import type { z } from 'zod'
import {
  cursorSchema,
  fieldsSchema,
  profileSchema,
  matchSchema,
  treeReadParamsSchema,
  listReadParamsSchema,
} from '@figma-agent-bridge/shared/read-model'
import type {
  Match,
  Profile,
  TreeReadParams,
  ListReadParams,
} from '@figma-agent-bridge/shared/read-model'

// --- compile-time: schema infer === hand-written type ---
// If a field drifts between read-model.ts's schemas and its exported
// types this fails `bun run typecheck` (the suite is the gate, like
// node-spec-schema).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <
    T,
  >() => T extends B ? 1 : 2
    ? true
    : false
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion only
const assertEqual = <Constraint extends true>(): void =>
  undefined

assertEqual<Equal<z.infer<typeof matchSchema>, Match>>()
assertEqual<Equal<z.infer<typeof profileSchema>, Profile>>()
assertEqual<
  Equal<
    z.infer<typeof treeReadParamsSchema>,
    TreeReadParams
  >
>()
assertEqual<
  Equal<
    z.infer<typeof listReadParamsSchema>,
    ListReadParams
  >
>()

describe('matchSchema', () => {
  it('accepts a single-string type', () => {
    expect(
      matchSchema.safeParse({ type: 'FRAME' }).success,
    ).toBe(true)
  })

  it('accepts an array type (any-of)', () => {
    expect(
      matchSchema.safeParse({ type: ['FRAME', 'TEXT'] })
        .success,
    ).toBe(true)
  })

  it('accepts a full match object', () => {
    const full: Match = {
      name: 'Card',
      regex: '^Card',
      type: ['FRAME', 'COMPONENT'],
      componentKey: 'abc123',
      styleId: 'S:1',
      variableId: 'V:1',
      instancesOf: 'Button',
    }
    expect(matchSchema.safeParse(full).success).toBe(true)
  })

  it('accepts an empty match (all optional)', () => {
    expect(matchSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a non-string/array type', () => {
    expect(
      matchSchema.safeParse({ type: 42 }).success,
    ).toBe(false)
  })
})

describe('fieldsSchema', () => {
  it('rejects an empty list', () => {
    expect(fieldsSchema.safeParse([]).success).toBe(false)
  })

  it('accepts a non-empty list', () => {
    expect(
      fieldsSchema.safeParse(['id', 'name']).success,
    ).toBe(true)
  })
})

describe('profileSchema', () => {
  it('accepts each of the 5 enum values', () => {
    for (const p of [
      'minimal',
      'layout',
      'style',
      'text',
      'full',
    ] as const) {
      expect(profileSchema.safeParse(p).success).toBe(true)
    }
  })

  it('rejects a bogus value', () => {
    expect(profileSchema.safeParse('bogus').success).toBe(
      false,
    )
  })
})

describe('cursorSchema', () => {
  it('rejects an empty string', () => {
    expect(cursorSchema.safeParse('').success).toBe(false)
  })

  it('accepts a non-empty token', () => {
    expect(
      cursorSchema.safeParse('eyJwb3MiOjQyfQ==').success,
    ).toBe(true)
  })
})

describe('treeReadParamsSchema', () => {
  it('accepts an empty object (server defaults)', () => {
    expect(treeReadParamsSchema.safeParse({}).success).toBe(
      true,
    )
  })

  it('accepts a maximal object', () => {
    const max: TreeReadParams = {
      depth: 3,
      budget: 5000,
      fields: ['id', 'name', 'type'],
      profile: 'layout',
      match: { type: ['FRAME', 'TEXT'], name: 'Row' },
    }
    expect(
      treeReadParamsSchema.safeParse(max).success,
    ).toBe(true)
  })

  it('rejects a non-integer depth', () => {
    expect(
      treeReadParamsSchema.safeParse({ depth: 1.5 })
        .success,
    ).toBe(false)
  })

  it('rejects a non-positive budget', () => {
    expect(
      treeReadParamsSchema.safeParse({ budget: -1 })
        .success,
    ).toBe(false)
  })
})

describe('listReadParamsSchema', () => {
  it('accepts an empty object (server defaults)', () => {
    expect(listReadParamsSchema.safeParse({}).success).toBe(
      true,
    )
  })

  it('accepts a maximal object', () => {
    const max: ListReadParams = {
      cursor: 'eyJwb3MiOjQyfQ==',
      limit: 100,
      fields: ['id', 'name'],
      match: { type: 'INSTANCE' },
    }
    expect(
      listReadParamsSchema.safeParse(max).success,
    ).toBe(true)
  })

  it('rejects a non-positive limit', () => {
    expect(
      listReadParamsSchema.safeParse({ limit: 0 }).success,
    ).toBe(false)
  })
})
