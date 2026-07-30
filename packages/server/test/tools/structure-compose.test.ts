// structure-compose.test.ts — the M3 chunk A composable-edit structure tools:
// clone_node, reparent_node, reorder_children, boolean_op, flatten.
// M10b adds: group_nodes.
//
// Each is a mutation handler routed through formatMutationResult: a null reply
// → failure text, a {error} reply → an error, otherwise JSON.stringify. Asserts
// on REAL handler output + the forwarded command/params via a stub client.

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCloneNode,
  handleReparentNode,
  handleReorderChildren,
  handleBooleanOp,
  handleFlatten,
  handleGroupNodes,
} from '@figma-agent-bridge/server/tools/structure'

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

describe('handleCloneNode', () => {
  it('forwards COMMANDS.CLONE_NODE with {nodeId,parentId,index,count}', async () => {
    const sent: Sent[] = []
    await handleCloneNode(
      {
        nodeId: '1:42',
        parentId: '1:2',
        index: 0,
        count: 3,
      },
      stubClient({
        sent,
        reply: [{ id: 'c:1', name: 'Card', type: 'FRAME' }],
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.CLONE_NODE)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      parentId: '1:2',
      index: 0,
      count: 3,
    })
  })

  it('emits the array of clones', async () => {
    const result = await handleCloneNode(
      { nodeId: '1:42', count: 2 },
      stubClient({
        reply: [
          { id: 'c:1', name: 'Card', type: 'FRAME' },
          { id: 'c:2', name: 'Card', type: 'FRAME' },
        ],
      }),
    )
    const out = JSON.parse(
      result.content[0].text,
    ) as unknown[]
    expect(out).toHaveLength(2)
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleCloneNode(
      { nodeId: 'nope' },
      stubClient({
        reply: {
          error: 'Node not found or not cloneable: nope',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('not cloneable')
    expect(data.code).toBe('NODE_NOT_FOUND')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleCloneNode(
      { nodeId: '1:1' },
      stubClient({ reply: null }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Failed to clone node.',
      code: 'PLUGIN_ERROR',
    })
  })
})

describe('handleReparentNode', () => {
  it('forwards COMMANDS.REPARENT_NODE with {nodeId,parentId,index}', async () => {
    const sent: Sent[] = []
    await handleReparentNode(
      { nodeId: '1:42', parentId: '1:9', index: 2 },
      stubClient({
        sent,
        reply: {
          id: '1:42',
          name: 'Card',
          type: 'FRAME',
          parentId: '1:9',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.REPARENT_NODE)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      parentId: '1:9',
      index: 2,
    })
  })

  it('emits {id,…,parentId}', async () => {
    const result = await handleReparentNode(
      { nodeId: '1:42', parentId: '1:9' },
      stubClient({
        reply: {
          id: '1:42',
          name: 'Card',
          type: 'FRAME',
          parentId: '1:9',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      parentId: string
    }
    expect(out.parentId).toBe('1:9')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleReparentNode(
      { nodeId: '1:42', parentId: 'nope' },
      stubClient({
        reply: {
          error:
            'Parent not found or cannot have children: nope',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Parent not found')
    expect(data.code).toBe('NODE_NOT_FOUND')
  })
})

describe('handleReorderChildren', () => {
  it('forwards COMMANDS.REORDER_CHILDREN with {parentId,nodeIds}', async () => {
    const sent: Sent[] = []
    await handleReorderChildren(
      { parentId: '1:1', nodeIds: ['1:3', '1:2'] },
      stubClient({
        sent,
        reply: {
          parentId: '1:1',
          order: ['1:3', '1:2'],
          warnings: [],
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.REORDER_CHILDREN)
    expect(sent[0].params).toEqual({
      parentId: '1:1',
      nodeIds: ['1:3', '1:2'],
    })
  })

  it('emits {parentId,order,warnings} on the happy path', async () => {
    const result = await handleReorderChildren(
      { parentId: '1:1', nodeIds: ['1:3', '1:2', '1:1c'] },
      stubClient({
        reply: {
          parentId: '1:1',
          order: ['1:3', '1:2', '1:1c'],
          warnings: [],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      order: string[]
      warnings: string[]
    }
    expect(out.order).toEqual(['1:3', '1:2', '1:1c'])
    expect(out.warnings).toEqual([])
  })

  it('surfaces a set-mismatch warning (T7) on success, not an error', async () => {
    const result = await handleReorderChildren(
      { parentId: '1:1', nodeIds: ['1:3', 'ghost'] },
      stubClient({
        reply: {
          parentId: '1:1',
          order: ['1:3'],
          warnings: [
            'reorder_children id set differs from the parent children: not children=[ghost], omitted=[1:2]. Only matching ids were reordered.',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('id set differs')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleReorderChildren(
      { parentId: 'nope', nodeIds: [] },
      stubClient({
        reply: {
          error:
            'Parent not found or has no children: nope',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Parent not found')
    expect(data.code).toBe('NODE_NOT_FOUND')
  })
})

describe('handleBooleanOp', () => {
  it('forwards COMMANDS.BOOLEAN_OP with {op,nodeIds,parentId}', async () => {
    const sent: Sent[] = []
    await handleBooleanOp(
      {
        op: 'SUBTRACT',
        nodeIds: ['1:1', '1:2'],
        parentId: '1:9',
      },
      stubClient({
        sent,
        reply: {
          id: 'bool:1',
          name: 'Subtract',
          type: 'BOOLEAN_OPERATION',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.BOOLEAN_OP)
    expect(sent[0].params).toEqual({
      op: 'SUBTRACT',
      nodeIds: ['1:1', '1:2'],
      parentId: '1:9',
    })
  })

  it('emits the BooleanOperationNode {id,name,type}', async () => {
    const result = await handleBooleanOp(
      { op: 'UNION', nodeIds: ['1:1', '1:2'] },
      stubClient({
        reply: {
          id: 'bool:1',
          name: 'Union',
          type: 'BOOLEAN_OPERATION',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      type: string
    }
    expect(out.type).toBe('BOOLEAN_OPERATION')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleBooleanOp(
      { op: 'UNION', nodeIds: ['1:1', '1:2'] },
      stubClient({
        reply: {
          error:
            'boolean_op requires at least 2 resolvable nodes.',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('requires at least')
    expect(data.code).toBe('INVALID_PARAM')
  })
})

describe('handleFlatten', () => {
  it('forwards COMMANDS.FLATTEN with {nodeIds,parentId}', async () => {
    const sent: Sent[] = []
    await handleFlatten(
      { nodeIds: ['1:1', '1:2'], parentId: '1:9' },
      stubClient({
        sent,
        reply: {
          id: 'vec:1',
          name: 'Vector',
          type: 'VECTOR',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.FLATTEN)
    expect(sent[0].params).toEqual({
      nodeIds: ['1:1', '1:2'],
      parentId: '1:9',
    })
  })

  it('emits the VECTOR {id,name,type}', async () => {
    const result = await handleFlatten(
      { nodeIds: ['1:1'] },
      stubClient({
        reply: {
          id: 'vec:1',
          name: 'Vector',
          type: 'VECTOR',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      type: string
    }
    expect(out.type).toBe('VECTOR')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleFlatten(
      { nodeIds: [] },
      stubClient({
        reply: {
          error:
            'flatten requires at least 1 resolvable node.',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('requires at least')
    expect(data.code).toBe('INVALID_PARAM')
  })
})

describe('handleGroupNodes', () => {
  it('forwards COMMANDS.GROUP_NODES with {nodeIds,parentId}', async () => {
    const sent: Sent[] = []
    await handleGroupNodes(
      { nodeIds: ['1:1', '1:2'], parentId: '1:9' },
      stubClient({
        sent,
        reply: {
          id: 'grp:1',
          name: 'Group',
          type: 'GROUP',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.GROUP_NODES)
    expect(sent[0].params).toEqual({
      nodeIds: ['1:1', '1:2'],
      parentId: '1:9',
    })
  })

  it('emits the GROUP {id,name,type}', async () => {
    const result = await handleGroupNodes(
      { nodeIds: ['1:1'] },
      stubClient({
        reply: {
          id: 'grp:1',
          name: 'Group',
          type: 'GROUP',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      type: string
    }
    expect(out.type).toBe('GROUP')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleGroupNodes(
      { nodeIds: [] },
      stubClient({
        reply: {
          error:
            'group_nodes requires at least 1 resolvable node.',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('requires at least')
    expect(data.code).toBe('INVALID_PARAM')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleGroupNodes(
      { nodeIds: ['1:1'] },
      stubClient({ reply: null }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Failed to group nodes.',
      code: 'PLUGIN_ERROR',
    })
  })
})
