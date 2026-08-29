// children-schema-honesty.test.ts — the schema stops inviting a mistake the
// tool never honoured (I67).
//
// `create_node`'s `spec` advertised a fully recursive `children` array and
// then stripped it with a post-hoc warning; `update_node`'s `patch` advertised
// it and dropped it in silence. Twelve recordings. A schema is the first thing
// an agent reads, so an advertised-and-ignored field is the most expensive
// kind of documentation there is.
//
// The fix is subtraction on the ADVERTISED shape only. Both schemas stay
// passthrough, so a straggler still ARRIVES and is still reported — removing
// the field from the schema without keeping the warning would trade a
// misleading invitation for a silent drop.

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import {
  createNodeParamsSchema,
  updateNodeParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'
import { handleCreateNode } from '@figma-agent-bridge/server/tools/create-node'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

const shapeOf = (
  schema: unknown,
): Record<string, unknown> =>
  (schema as z.ZodObject<z.ZodRawShape>).shape

const stubClient = (): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async () => ({
    id: '1:1',
    name: 'N',
    type: 'FRAME',
  }),
})

describe('the create/update schemas no longer advertise children (I67)', () => {
  it('create_node.spec has no `children` key', () => {
    const spec = shapeOf(createNodeParamsSchema.shape.spec)
    expect(Object.keys(spec)).not.toContain('children')
    // …and it still advertises the fields the tool DOES honour.
    expect(Object.keys(spec)).toContain('fills')
    expect(Object.keys(spec)).toContain('layout')
  })

  it('update_node.patch has no `children` key', () => {
    const patch = shapeOf(
      updateNodeParamsSchema.shape.patch,
    )
    expect(Object.keys(patch)).not.toContain('children')
    expect(Object.keys(patch)).toContain('fills')
  })

  it('both still PARSE a straggler carrying children — it must reach the handler', () => {
    const created = createNodeParamsSchema.parse({
      fileKey: 'fk',
      spec: {
        type: 'FRAME',
        children: [{ type: 'TEXT' }],
      },
    }) as { spec: Record<string, unknown> }
    expect(created.spec.children).toBeDefined()

    const updated = updateNodeParamsSchema.parse({
      fileKey: 'fk',
      nodeId: '1:1',
      patch: { children: [{ type: 'TEXT' }] },
    }) as { patch: Record<string, unknown> }
    expect(updated.patch.children).toBeDefined()
  })
})

describe('a straggler that sends children anyway is still told (I67)', () => {
  it('create_node warns and points at create_tree', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          children: [{ type: 'TEXT' }],
        },
      },
      stubClient(),
    )
    const out = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(
      out.warnings.some(
        w =>
          w.includes('children') &&
          w.includes('create_tree'),
      ),
    ).toBe(true)
  })

  it('update_node warns instead of dropping it in silence', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:1',
        patch: {
          children: [{ type: 'TEXT' }],
        } as never,
      },
      stubClient(),
    )
    const out = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    const note = out.warnings.find(w =>
      w.includes('children'),
    )
    expect(note).toBeDefined()
    // The three tools that DO move structure, named where the mistake is made.
    expect(note).toContain('create_node')
    expect(note).toContain('reparent_node')
  })

  it('a patch WITHOUT children says nothing about it', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:1', patch: { opacity: 0.5 } },
      stubClient(),
    )
    const { text } = result.content[0]
    expect(text).not.toContain('children')
  })
})
