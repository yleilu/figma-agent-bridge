// collapse-validation.test.ts — I87, the 6KB dump that buried its own cause.
//
// Live, operator-filed 2026-09-02: `create_tree` with a nested FRAME carrying
// `"radius": 18` answered `MCP error -32602: Input validation error` followed
// by ~6KB of `invalid_union` / `unionErrors`, with the one line that mattered
// — `Expected string, received number at tree.children.3.children.0.radius` —
// three union levels down and repeated four times.
//
// The rejection is CORRECT and stays: B18 ruled that a value atom IS a string.
// This is purely about the error being readable.

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import {
  collapsedValidationMessage,
  withCollapsedErrors,
} from '@figma-agent-bridge/server/tools/collapse-validation'

/** The shape that produced the dump: a recursive union of node specs. */
const atom = z.string()
const stub = z.object({ id: z.string() }).strict()
const spec: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      radius: atom.optional(),
      children: z.array(z.union([spec, stub])).optional(),
    })
    .strict(),
)
const treeSchema = z
  .object({
    fileKey: z.string(),
    tree: z.union([spec, z.array(spec)]),
  })
  .strict()

const failOn = (value: unknown): z.ZodError => {
  const result = treeSchema.safeParse(value)
  if (result.success) {
    throw new Error('expected a refusal')
  }
  return result.error
}

const badRadius = {
  fileKey: 'fk',
  tree: {
    type: 'FRAME',
    children: [{ type: 'FRAME', radius: 18 }],
  },
}

describe('collapsedValidationMessage', () => {
  it('names the deepest concrete mismatch, with its path', () => {
    const message = collapsedValidationMessage(
      failOn(badRadius),
    )
    expect(message).toContain('tree.children.0.radius')
    expect(message).toContain('expected string')
    expect(message).toContain('received number')
  })

  it('teaches the atom rule, with the value the caller meant', () => {
    // The asymmetry that motivates the mistake is real — `layout.gap`, `size`
    // and `opacity` all take a number — so the fix is spelled out.
    expect(
      collapsedValidationMessage(failOn(badRadius)),
    ).toContain('"18"')
  })

  it('is ONE line, not the union dump', () => {
    const message = collapsedValidationMessage(
      failOn(badRadius),
    )
    expect(message.length).toBeLessThan(400)
    expect(message).not.toContain('unionErrors')
    expect(message).not.toContain('invalid_union')
  })

  it('passes a plain, non-union failure through as its own line', () => {
    const message = collapsedValidationMessage(
      failOn({ tree: { type: 'FRAME' } }),
    )
    expect(message).toContain('fileKey')
  })

  it('names an unknown key rather than hiding it in a union', () => {
    // A strict schema is what makes a mis-nested key an error at all (B52),
    // and that error must stay legible.
    const message = collapsedValidationMessage(
      failOn({
        fileKey: 'fk',
        tree: { type: 'FRAME', raduis: '18' },
      }),
    )
    expect(message).toContain('raduis')
  })
})

describe('withCollapsedErrors — the schema still IS the schema', () => {
  const wrapped = withCollapsedErrors(treeSchema)

  it('keeps the shape the SDK reads to advertise the tool', () => {
    expect(Object.keys(wrapped.shape).sort()).toEqual([
      'fileKey',
      'tree',
    ])
  })

  it('accepts what the original accepts, and hands back the same data', () => {
    const ok = wrapped.safeParse({
      fileKey: 'fk',
      tree: { type: 'FRAME' },
    })
    expect(ok.success).toBe(true)
    expect(ok.success && ok.data.fileKey).toBe('fk')
  })

  it('refuses what the original refuses — the rejection is untouched', async () => {
    const result = await wrapped.safeParseAsync(badRadius)
    expect(result.success).toBe(false)
  })

  it('and the message the MCP boundary reads is the one line', async () => {
    // The SDK takes `error.message` verbatim into
    // `Input validation error: Invalid arguments for tool <name>: …`.
    const result = await wrapped.safeParseAsync(badRadius)
    const message = result.success
      ? ''
      : result.error.message
    expect(message).toContain('tree.children.0.radius')
    expect(message.length).toBeLessThan(400)
  })

  it('collapses the SYNC path too', () => {
    const result = wrapped.safeParse(badRadius)
    const message = result.success
      ? ''
      : result.error.message
    expect(message).toContain('tree.children.0.radius')
  })

  it('leaves the issue list intact for anything that reads it', () => {
    // Only the MESSAGE is collapsed. A caller walking `issues` still gets
    // everything zod found — nothing is thrown away, only summarised.
    const result = wrapped.safeParse(badRadius)
    expect(
      result.success ? 0 : result.error.issues.length,
    ).toBeGreaterThan(0)
  })
})
