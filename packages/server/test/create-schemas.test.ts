import { describe, expect, it } from 'bun:test'
import { createFromSvgParamsSchema } from '@figma-agent-bridge/shared'

// The create_node / create_tree / create_component param schemas were the
// green-window versions in create-schemas.ts and were retired in M3-E (the
// live server uses the canonical NodeSpec-based shapes in tool-params.ts,
// covered by tool-params.test.ts). Only createFromSvgParamsSchema remains here.

describe('createFromSvgParamsSchema', () => {
  it('validates SVG string input', () => {
    const result = createFromSvgParamsSchema.safeParse({
      fileKey: 'fk',
      parentId: '1:2',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 2L2 22h20L12 2z"/></svg>',
      name: 'Triangle Icon',
    })
    expect(result.success).toBe(true)
  })

  it('validates without optional name', () => {
    const result = createFromSvgParamsSchema.safeParse({
      fileKey: 'fk',
      parentId: '1:2',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50"/></svg>',
    })
    expect(result.success).toBe(true)
  })

  it('requires fileKey (per-call file addressing — B3)', () => {
    const result = createFromSvgParamsSchema.safeParse({
      parentId: '1:2',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50"/></svg>',
    })
    expect(result.success).toBe(false)
  })
})
