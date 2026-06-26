// packages/shared/test/tool-params.test.ts
//
// tool-params.ts is imported via its subpath (NOT the barrel) because some
// of its schema names deliberately shadow the green-window schemas.ts /
// create-schemas.ts versions still used by the live server.
import { describe, expect, it } from 'bun:test'
import {
  getNodeParamsSchema,
  getNodesParamsSchema,
  inspectParamsSchema,
  searchParamsSchema,
  statusParamsSchema,
  setSelectionParamsSchema,
  updateNodeParamsSchema,
  createNodeParamsSchema,
  createTreeParamsSchema,
  bindVariableParamsSchema,
  getVariablesParamsSchema,
  getComponentsParamsSchema,
  batchParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'

// ---------------------------------------------------------------------------
// getNodeParamsSchema — tree read mixin (depth/budget/fields/profile/match)
// ---------------------------------------------------------------------------
describe('getNodeParamsSchema', () => {
  it('accepts a minimal payload (nodeId only)', () => {
    expect(
      getNodeParamsSchema.safeParse({ nodeId: '1:2' })
        .success,
    ).toBe(true)
  })

  it('accepts the reduced mixin (depth + fields + profile only)', () => {
    expect(
      getNodeParamsSchema.safeParse({
        nodeId: '1:2',
        depth: 3,
        fields: ['id', 'name', 'type'],
        profile: 'layout',
      }).success,
    ).toBe(true)
  })

  // B1 — get_node is the fidelity exception (never budget-truncated, no match
  // filter). Zod strips unknown keys by default, so assert the PARSED OUTPUT
  // never carries budget/match (the schema does not advertise them).
  it('drops budget (the fidelity exception is never budget-truncated)', () => {
    const parsed = getNodeParamsSchema.safeParse({
      nodeId: '1:2',
      budget: 5000,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('budget')
    }
  })

  it('drops match (no source-side filter on the edit reader)', () => {
    const parsed = getNodeParamsSchema.safeParse({
      nodeId: '1:2',
      match: { type: ['FRAME', 'TEXT'], name: 'Row' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('match')
    }
  })

  it('rejects a missing nodeId', () => {
    expect(getNodeParamsSchema.safeParse({}).success).toBe(
      false,
    )
  })

  it('accepts negative depth (depth -1 = unlimited)', () => {
    expect(
      getNodeParamsSchema.safeParse({
        nodeId: '1:2',
        depth: -1,
        profile: 'layout',
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getNodesParamsSchema — tree read mixin
// ---------------------------------------------------------------------------
describe('getNodesParamsSchema', () => {
  it('accepts a minimal payload (nodeIds only)', () => {
    expect(
      getNodesParamsSchema.safeParse({
        nodeIds: ['1:2', '3:4'],
      }).success,
    ).toBe(true)
  })

  it('accepts the reduced mixin (depth + fields + profile only)', () => {
    expect(
      getNodesParamsSchema.safeParse({
        nodeIds: ['1:2'],
        depth: 2,
        fields: ['id', 'name'],
        profile: 'minimal',
      }).success,
    ).toBe(true)
  })

  // B1 — get_nodes is the fidelity exception too: budget/match are not
  // advertised, so a supplied budget/match is stripped from the parsed output.
  it('drops budget and match (fidelity exception, no source filter)', () => {
    const parsed = getNodesParamsSchema.safeParse({
      nodeIds: ['1:2'],
      budget: 1000,
      match: { type: 'FRAME' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('budget')
      expect(parsed.data).not.toHaveProperty('match')
    }
  })

  it('rejects missing nodeIds', () => {
    expect(getNodesParamsSchema.safeParse({}).success).toBe(
      false,
    )
  })

  it('rejects non-array nodeIds', () => {
    expect(
      getNodesParamsSchema.safeParse({ nodeIds: '1:2' })
        .success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// inspectParamsSchema — tree read mixin + optional nodeId/pageId
// ---------------------------------------------------------------------------
describe('inspectParamsSchema', () => {
  it('accepts an empty payload (current selection)', () => {
    expect(inspectParamsSchema.safeParse({}).success).toBe(
      true,
    )
  })

  it('accepts nodeId only', () => {
    expect(
      inspectParamsSchema.safeParse({ nodeId: '1:2' })
        .success,
    ).toBe(true)
  })

  it('accepts pageId only', () => {
    expect(
      inspectParamsSchema.safeParse({ pageId: 'p:1' })
        .success,
    ).toBe(true)
  })

  it('accepts both nodeId and pageId', () => {
    expect(
      inspectParamsSchema.safeParse({
        nodeId: '1:2',
        pageId: 'p:1',
      }).success,
    ).toBe(true)
  })

  it('accepts a maximal payload (nodeId + all mixin fields)', () => {
    expect(
      inspectParamsSchema.safeParse({
        nodeId: '1:2',
        depth: 5,
        budget: 2000,
        fields: ['id', 'type'],
        profile: 'full',
        match: { type: 'COMPONENT' },
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// searchParamsSchema — list read mixin (cursor/limit/fields/match) + pageId
// ---------------------------------------------------------------------------
describe('searchParamsSchema', () => {
  it('accepts an empty payload (match-all)', () => {
    expect(searchParamsSchema.safeParse({}).success).toBe(
      true,
    )
  })

  it('accepts cursor + limit (list mixin fields)', () => {
    expect(
      searchParamsSchema.safeParse({
        cursor: 'abc',
        limit: 10,
      }).success,
    ).toBe(true)
  })

  it('accepts pageId restriction', () => {
    expect(
      searchParamsSchema.safeParse({
        pageId: 'p:1',
        match: { type: 'TEXT' },
      }).success,
    ).toBe(true)
  })

  // B2 — search `depth` bounds the SCAN SCOPE (how deep the plugin traverses);
  // results stay a flat Rule-A list.
  it('accepts a depth scan-scope bound', () => {
    expect(
      searchParamsSchema.safeParse({ depth: 2 }).success,
    ).toBe(true)
  })

  it('accepts depth -1 (scan everything)', () => {
    expect(
      searchParamsSchema.safeParse({ depth: -1 }).success,
    ).toBe(true)
  })

  it('rejects a non-integer depth', () => {
    expect(
      searchParamsSchema.safeParse({ depth: 1.5 }).success,
    ).toBe(false)
  })

  it('accepts a full payload', () => {
    expect(
      searchParamsSchema.safeParse({
        pageId: 'p:1',
        depth: 3,
        cursor: 'eyJwb3MiOjQyfQ==',
        limit: 50,
        fields: ['id', 'name', 'type', 'characters'],
        match: {
          name: 'Button',
          type: ['INSTANCE', 'COMPONENT'],
        },
      }).success,
    ).toBe(true)
  })

  it('rejects a non-positive limit', () => {
    expect(
      searchParamsSchema.safeParse({ limit: 0 }).success,
    ).toBe(false)
  })

  it('rejects an empty cursor', () => {
    expect(
      searchParamsSchema.safeParse({ cursor: '' }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// statusParamsSchema — no params
// ---------------------------------------------------------------------------
describe('statusParamsSchema', () => {
  it('accepts an empty payload', () => {
    expect(statusParamsSchema.safeParse({}).success).toBe(
      true,
    )
  })

  it('ignores extra keys (Zod strips by default)', () => {
    expect(
      statusParamsSchema.safeParse({ extra: 'ignored' })
        .success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setSelectionParamsSchema
// ---------------------------------------------------------------------------
describe('setSelectionParamsSchema', () => {
  it('accepts a list of node ids', () => {
    expect(
      setSelectionParamsSchema.safeParse({
        nodeIds: ['1:2', '3:4'],
      }).success,
    ).toBe(true)
  })

  it('accepts an empty nodeIds array (clear selection)', () => {
    expect(
      setSelectionParamsSchema.safeParse({ nodeIds: [] })
        .success,
    ).toBe(true)
  })

  it('rejects missing nodeIds', () => {
    expect(
      setSelectionParamsSchema.safeParse({}).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// updateNodeParamsSchema
// ---------------------------------------------------------------------------
describe('updateNodeParamsSchema', () => {
  it('accepts a nodeId + empty patch ({})', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        nodeId: '1:2',
        patch: {},
      }).success,
    ).toBe(true)
  })

  it('accepts a single-field patch (opacity)', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        nodeId: '1:2',
        patch: { opacity: 0.5 },
      }).success,
    ).toBe(true)
  })

  it('accepts a single-field patch (name)', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        nodeId: '1:2',
        patch: { name: 'Card' },
      }).success,
    ).toBe(true)
  })

  it('rejects missing nodeId', () => {
    expect(
      updateNodeParamsSchema.safeParse({ patch: {} })
        .success,
    ).toBe(false)
  })

  it('rejects missing patch', () => {
    expect(
      updateNodeParamsSchema.safeParse({ nodeId: '1:2' })
        .success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createNodeParamsSchema — { spec: NodeSpec, parentId? }
// ---------------------------------------------------------------------------
describe('createNodeParamsSchema', () => {
  it('accepts a minimal spec (type only)', () => {
    expect(
      createNodeParamsSchema.safeParse({
        spec: { type: 'FRAME' },
      }).success,
    ).toBe(true)
  })

  it('accepts a spec with atom leaves + parentId', () => {
    expect(
      createNodeParamsSchema.safeParse({
        spec: {
          type: 'FRAME',
          name: 'Card',
          fills: ['#FF0000'],
          layout: { mode: 'V', gap: 8 },
        },
        parentId: '1:2',
      }).success,
    ).toBe(true)
  })

  it('rejects a spec missing type', () => {
    expect(
      createNodeParamsSchema.safeParse({
        spec: { name: 'NoType' },
      }).success,
    ).toBe(false)
  })

  it('rejects a missing spec', () => {
    expect(
      createNodeParamsSchema.safeParse({ parentId: '1:2' })
        .success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createTreeParamsSchema — { tree: TreeNodeSpec, parentId?, refs? }
// ---------------------------------------------------------------------------
describe('createTreeParamsSchema', () => {
  it('accepts a nested tree (recursive children)', () => {
    expect(
      createTreeParamsSchema.safeParse({
        tree: {
          type: 'FRAME',
          children: [
            {
              type: 'TEXT',
              text: {
                content: 'Hi',
                font: 'font(Inter,Bold,12)',
              },
            },
          ],
        },
      }).success,
    ).toBe(true)
  })

  it('accepts a { ref } child + a refs pool', () => {
    expect(
      createTreeParamsSchema.safeParse({
        tree: {
          type: 'FRAME',
          children: [{ ref: 'button' }],
        },
        refs: {
          button: {
            type: 'INSTANCE',
            name: 'Button',
          },
        },
      }).success,
    ).toBe(true)
  })

  it('accepts an { id } clone child', () => {
    expect(
      createTreeParamsSchema.safeParse({
        tree: {
          type: 'FRAME',
          children: [{ id: '9:9' }],
        },
        parentId: '1:2',
      }).success,
    ).toBe(true)
  })

  it('rejects a missing tree', () => {
    expect(
      createTreeParamsSchema.safeParse({ parentId: '1:2' })
        .success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// bindVariableParamsSchema
// ---------------------------------------------------------------------------
describe('bindVariableParamsSchema', () => {
  it('accepts a valid payload', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        nodeId: '1:2',
        variableId: 'VariableID:1',
        field: 'fills',
      }).success,
    ).toBe(true)
  })

  it('rejects missing field', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        nodeId: '1:2',
        variableId: 'VariableID:1',
      }).success,
    ).toBe(false)
  })

  it('rejects missing variableId', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        nodeId: '1:2',
        field: 'fills',
      }).success,
    ).toBe(false)
  })

  it('rejects missing nodeId', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        variableId: 'VariableID:1',
        field: 'fills',
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getVariablesParamsSchema
// ---------------------------------------------------------------------------
describe('getVariablesParamsSchema', () => {
  it('accepts an empty payload (all collections)', () => {
    expect(
      getVariablesParamsSchema.safeParse({}).success,
    ).toBe(true)
  })

  it('accepts a collectionId filter', () => {
    expect(
      getVariablesParamsSchema.safeParse({
        collectionId: 'VariableCollectionId:1',
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getComponentsParamsSchema — T10: query + includeRemote gate + list mixin
// (cursor/limit). includeRemote defaults off (the live timeout fix).
// ---------------------------------------------------------------------------
describe('getComponentsParamsSchema', () => {
  it('accepts an empty payload (local-only, default page)', () => {
    expect(
      getComponentsParamsSchema.safeParse({}).success,
    ).toBe(true)
  })

  it('accepts a query filter', () => {
    expect(
      getComponentsParamsSchema.safeParse({
        query: 'Button',
      }).success,
    ).toBe(true)
  })

  it('accepts includeRemote (the opt-in remote-discovery gate)', () => {
    const parsed = getComponentsParamsSchema.safeParse({
      includeRemote: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.includeRemote).toBe(true)
    }
  })

  it('accepts cursor + limit (list mixin fields)', () => {
    expect(
      getComponentsParamsSchema.safeParse({
        cursor: 'eyJwb3MiOjQyfQ==',
        limit: 50,
      }).success,
    ).toBe(true)
  })

  it('rejects a non-positive limit', () => {
    expect(
      getComponentsParamsSchema.safeParse({ limit: 0 })
        .success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// batchParamsSchema — the one generic batch (D3): op? + ops[{op?, ...params}]
// ---------------------------------------------------------------------------
describe('batchParamsSchema', () => {
  it('accepts a homogeneous batch (top-level op, entries omit op)', () => {
    expect(
      batchParamsSchema.safeParse({
        op: 'delete_node',
        ops: [{ nodeId: '1:1' }, { nodeId: '1:2' }],
      }).success,
    ).toBe(true)
  })

  it('accepts a heterogeneous batch (per-entry op)', () => {
    expect(
      batchParamsSchema.safeParse({
        ops: [
          { op: 'update_node', nodeId: '1:1', patch: {} },
          { op: 'set_focus', nodeIds: ['1:2'] },
        ],
      }).success,
    ).toBe(true)
  })

  it('passes through arbitrary per-op params (passthrough entry)', () => {
    const parsed = batchParamsSchema.safeParse({
      op: 'apply_style',
      ops: [
        { nodeId: '1:1', styleId: 'S:1', field: 'fill' },
      ],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const entry = parsed.data.ops[0] as Record<
        string,
        unknown
      >
      expect(entry.styleId).toBe('S:1')
      expect(entry.field).toBe('fill')
    }
  })

  it('rejects an empty ops array', () => {
    expect(
      batchParamsSchema.safeParse({
        op: 'delete_node',
        ops: [],
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown op (not a WRITE command)', () => {
    expect(
      batchParamsSchema.safeParse({
        op: 'inspect',
        ops: [{ nodeId: '1:1' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a missing ops array', () => {
    expect(
      batchParamsSchema.safeParse({ op: 'delete_node' })
        .success,
    ).toBe(false)
  })
})
