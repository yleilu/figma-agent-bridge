// packages/shared/test/tool-params.test.ts
//
// tool-params.ts is imported via its subpath (NOT the barrel) because some
// of its schema names deliberately shadow the green-window schemas.ts /
// create-schemas.ts versions still used by the live server.
import { describe, expect, it } from 'bun:test'
import {
  fileTargetParamsSchema,
  getNodeParamsSchema,
  getNodesParamsSchema,
  inspectParamsSchema,
  searchParamsSchema,
  statusParamsSchema,
  setSelectionParamsSchema,
  deleteNodeParamsSchema,
  updateNodeParamsSchema,
  createNodeParamsSchema,
  createTreeParamsSchema,
  bindVariableParamsSchema,
  getVariablesParamsSchema,
  getComponentsParamsSchema,
  batchParamsSchema,
  searchComponentsParamsSchema,
  reindexParamsSchema,
  recordFeedbackParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'

// ---------------------------------------------------------------------------
// getNodeParamsSchema — tree read mixin (depth/budget/fields/profile/match)
// ---------------------------------------------------------------------------
describe('getNodeParamsSchema', () => {
  it('accepts a minimal payload (fileKey + nodeId)', () => {
    expect(
      getNodeParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
      }).success,
    ).toBe(true)
  })

  it('accepts the reduced mixin (depth + fields + profile only)', () => {
    expect(
      getNodeParamsSchema.safeParse({
        fileKey: 'fk',
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
      fileKey: 'fk',
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
      fileKey: 'fk',
      nodeId: '1:2',
      match: { type: ['FRAME', 'TEXT'], name: 'Row' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('match')
    }
  })

  it('rejects a missing nodeId', () => {
    expect(
      getNodeParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(false)
  })

  it('accepts negative depth (depth -1 = unlimited)', () => {
    expect(
      getNodeParamsSchema.safeParse({
        fileKey: 'fk',
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
  it('accepts a minimal payload (fileKey + nodeIds)', () => {
    expect(
      getNodesParamsSchema.safeParse({
        fileKey: 'fk',
        nodeIds: ['1:2', '3:4'],
      }).success,
    ).toBe(true)
  })

  it('accepts the reduced mixin (depth + fields + profile only)', () => {
    expect(
      getNodesParamsSchema.safeParse({
        fileKey: 'fk',
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
      fileKey: 'fk',
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
    expect(
      getNodesParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(false)
  })

  it('rejects non-array nodeIds', () => {
    expect(
      getNodesParamsSchema.safeParse({
        fileKey: 'fk',
        nodeIds: '1:2',
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// inspectParamsSchema — tree read mixin + optional nodeId/pageId
// ---------------------------------------------------------------------------
describe('inspectParamsSchema', () => {
  it('accepts a fileKey-only payload (current selection)', () => {
    expect(
      inspectParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(true)
  })

  it('rejects a missing fileKey', () => {
    expect(inspectParamsSchema.safeParse({}).success).toBe(
      false,
    )
  })

  it('accepts nodeId only', () => {
    expect(
      inspectParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
      }).success,
    ).toBe(true)
  })

  it('accepts pageId only', () => {
    expect(
      inspectParamsSchema.safeParse({
        fileKey: 'fk',
        pageId: 'p:1',
      }).success,
    ).toBe(true)
  })

  it('accepts both nodeId and pageId', () => {
    expect(
      inspectParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        pageId: 'p:1',
      }).success,
    ).toBe(true)
  })

  it('accepts a maximal payload (nodeId + all mixin fields)', () => {
    expect(
      inspectParamsSchema.safeParse({
        fileKey: 'fk',
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
  it('accepts a fileKey-only payload (match-all)', () => {
    expect(
      searchParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(true)
  })

  it('rejects a missing fileKey', () => {
    expect(searchParamsSchema.safeParse({}).success).toBe(
      false,
    )
  })

  it('accepts cursor + limit (list mixin fields)', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        cursor: 'abc',
        limit: 10,
      }).success,
    ).toBe(true)
  })

  it('accepts pageId restriction', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        pageId: 'p:1',
        match: { type: 'TEXT' },
      }).success,
    ).toBe(true)
  })

  // B2 — search `depth` bounds the SCAN SCOPE (how deep the plugin traverses);
  // results stay a flat Rule-A list.
  it('accepts a depth scan-scope bound', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        depth: 2,
      }).success,
    ).toBe(true)
  })

  it('accepts depth -1 (scan everything)', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        depth: -1,
      }).success,
    ).toBe(true)
  })

  it('rejects a non-integer depth', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        depth: 1.5,
      }).success,
    ).toBe(false)
  })

  it('accepts a full payload', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
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
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        limit: 0,
      }).success,
    ).toBe(false)
  })

  it('rejects an empty cursor', () => {
    expect(
      searchParamsSchema.safeParse({
        fileKey: 'fk',
        cursor: '',
      }).success,
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
        fileKey: 'fk',
        nodeIds: ['1:2', '3:4'],
      }).success,
    ).toBe(true)
  })

  it('accepts an empty nodeIds array (clear selection)', () => {
    expect(
      setSelectionParamsSchema.safeParse({
        fileKey: 'fk',
        nodeIds: [],
      }).success,
    ).toBe(true)
  })

  it('rejects missing nodeIds', () => {
    expect(
      setSelectionParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
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
        fileKey: 'fk',
        nodeId: '1:2',
        patch: {},
      }).success,
    ).toBe(true)
  })

  it('accepts a single-field patch (opacity)', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        patch: { opacity: 0.5 },
      }).success,
    ).toBe(true)
  })

  it('accepts a single-field patch (name)', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        patch: { name: 'Card' },
      }).success,
    ).toBe(true)
  })

  it('rejects missing nodeId', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        fileKey: 'fk',
        patch: {},
      }).success,
    ).toBe(false)
  })

  it('rejects missing patch', () => {
    expect(
      updateNodeParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
      }).success,
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
        fileKey: 'fk',
        spec: { type: 'FRAME' },
      }).success,
    ).toBe(true)
  })

  it('accepts a spec with atom leaves + parentId', () => {
    expect(
      createNodeParamsSchema.safeParse({
        fileKey: 'fk',
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
        fileKey: 'fk',
        spec: { name: 'NoType' },
      }).success,
    ).toBe(false)
  })

  it('rejects a missing spec', () => {
    expect(
      createNodeParamsSchema.safeParse({
        fileKey: 'fk',
        parentId: '1:2',
      }).success,
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
        fileKey: 'fk',
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
        fileKey: 'fk',
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
        fileKey: 'fk',
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
      createTreeParamsSchema.safeParse({
        fileKey: 'fk',
        parentId: '1:2',
      }).success,
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
        fileKey: 'fk',
        nodeId: '1:2',
        variableId: 'VariableID:1',
        field: 'fills',
      }).success,
    ).toBe(true)
  })

  it('accepts variableId without field (partial field-binding; handler validates the pairing)', () => {
    // After M13: both variableId and field are optional at schema level to
    // allow the mode-only call path. The handler enforces that when variableId
    // is present, field must also be present (or vice versa) — but that's a
    // semantic constraint, not a Zod shape constraint.
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        variableId: 'VariableID:1',
      }).success,
    ).toBe(true)
  })

  it('accepts field without variableId (partial field-binding; handler validates the pairing)', () => {
    // Same reasoning as the test above: schema permits partial; handler validates.
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        field: 'fills',
      }).success,
    ).toBe(true)
  })

  it('rejects missing nodeId', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        variableId: 'VariableID:1',
        field: 'fills',
      }).success,
    ).toBe(false)
  })

  // M13 — mode param
  it('accepts mode-only payload (no variableId/field) for pure mode-set', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        mode: { 'col:1': { modeId: 'm:1' } },
      }).success,
    ).toBe(true)
  })

  it('accepts a combined mode + variableId + field payload', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        variableId: 'v:9',
        field: 'fills',
        mode: { 'col:1': { modeId: 'm:1' } },
      }).success,
    ).toBe(true)
  })

  it('accepts mode entry with modeName instead of modeId', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        mode: { 'col:1': { modeName: 'Dark' } },
      }).success,
    ).toBe(true)
  })

  it('accepts mode entry with clearMode:true', () => {
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
        mode: { 'col:1': { clearMode: true } },
      }).success,
    ).toBe(true)
  })

  it('accepts a nodeId-only payload (schema-level; handler rejects empty calls)', () => {
    // After M13: variableId/field are optional (mode may provide the binding).
    // The "at least one of {field+variableId, mode}" constraint lives in the
    // handler (not schema), because .refine() breaks the .shape access that
    // registerFileTool needs. This test documents that the schema permits a
    // nodeId-only call so we know the handler guard is what catches it.
    expect(
      bindVariableParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getVariablesParamsSchema
// ---------------------------------------------------------------------------
describe('getVariablesParamsSchema', () => {
  it('accepts a fileKey-only payload (all collections)', () => {
    expect(
      getVariablesParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(true)
  })

  it('rejects a missing fileKey', () => {
    expect(
      getVariablesParamsSchema.safeParse({}).success,
    ).toBe(false)
  })

  it('accepts a collectionId filter', () => {
    expect(
      getVariablesParamsSchema.safeParse({
        fileKey: 'fk',
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
  it('accepts a fileKey-only payload (local-only, default page)', () => {
    expect(
      getComponentsParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(true)
  })

  it('rejects a missing fileKey', () => {
    expect(
      getComponentsParamsSchema.safeParse({}).success,
    ).toBe(false)
  })

  it('accepts a query filter', () => {
    expect(
      getComponentsParamsSchema.safeParse({
        fileKey: 'fk',
        query: 'Button',
      }).success,
    ).toBe(true)
  })

  it('accepts includeRemote (the opt-in remote-discovery gate)', () => {
    const parsed = getComponentsParamsSchema.safeParse({
      fileKey: 'fk',
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
        fileKey: 'fk',
        cursor: 'eyJwb3MiOjQyfQ==',
        limit: 50,
      }).success,
    ).toBe(true)
  })

  it('rejects a non-positive limit', () => {
    expect(
      getComponentsParamsSchema.safeParse({
        fileKey: 'fk',
        limit: 0,
      }).success,
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
        fileKey: 'fk',
        op: 'delete_node',
        ops: [{ nodeId: '1:1' }, { nodeId: '1:2' }],
      }).success,
    ).toBe(true)
  })

  it('accepts a heterogeneous batch (per-entry op)', () => {
    expect(
      batchParamsSchema.safeParse({
        fileKey: 'fk',
        ops: [
          { op: 'update_node', nodeId: '1:1', patch: {} },
          { op: 'set_focus', nodeIds: ['1:2'] },
        ],
      }).success,
    ).toBe(true)
  })

  it('passes through arbitrary per-op params (passthrough entry)', () => {
    const parsed = batchParamsSchema.safeParse({
      fileKey: 'fk',
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
        fileKey: 'fk',
        op: 'delete_node',
        ops: [],
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown op (not a WRITE command)', () => {
    expect(
      batchParamsSchema.safeParse({
        fileKey: 'fk',
        op: 'inspect',
        ops: [{ nodeId: '1:1' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a missing ops array', () => {
    expect(
      batchParamsSchema.safeParse({
        fileKey: 'fk',
        op: 'delete_node',
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fileTargetParamsSchema (per-call fileKey — B3)
// ---------------------------------------------------------------------------
describe('fileTargetParamsSchema (per-call fileKey — B3)', () => {
  it('requires a non-empty fileKey', () => {
    expect(
      fileTargetParamsSchema.safeParse({}).success,
    ).toBe(false)
    expect(
      fileTargetParamsSchema.safeParse({ fileKey: '' })
        .success,
    ).toBe(false)
    expect(
      fileTargetParamsSchema.safeParse({ fileKey: 'fk-1' })
        .success,
    ).toBe(true)
  })

  it('accepts the reserved sessionId (optional, forward-compat)', () => {
    expect(
      fileTargetParamsSchema.safeParse({
        fileKey: 'fk-1',
        sessionId: 's-1',
      }).success,
    ).toBe(true)
  })

  it('every file-addressed tool schema carries fileKey', () => {
    expect(
      getNodeParamsSchema.safeParse({ nodeId: '1:2' })
        .success,
    ).toBe(false)
    expect(
      getNodeParamsSchema.safeParse({
        fileKey: 'fk',
        nodeId: '1:2',
      }).success,
    ).toBe(true)
    expect(
      deleteNodeParamsSchema.safeParse({ nodeId: '1:2' })
        .success,
    ).toBe(false)
    expect(
      batchParamsSchema.safeParse({
        ops: [{ op: 'delete_node', nodeId: '1' }],
      }).success,
    ).toBe(false)
    expect(
      batchParamsSchema.safeParse({
        fileKey: 'fk',
        ops: [{ op: 'delete_node', nodeId: '1' }],
      }).success,
    ).toBe(true)
  })

  it('component-index tools use fileKey (renamed from fileId)', () => {
    expect(
      searchComponentsParamsSchema.safeParse({
        fileId: 'fk',
        query: 'x',
      }).success,
    ).toBe(false)
    expect(
      searchComponentsParamsSchema.safeParse({
        fileKey: 'fk',
        query: 'x',
      }).success,
    ).toBe(true)
    expect(
      reindexParamsSchema.safeParse({ fileId: 'fk' })
        .success,
    ).toBe(false)
    expect(
      reindexParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// recordFeedbackParamsSchema
// ---------------------------------------------------------------------------
describe('recordFeedbackParamsSchema', () => {
  it('accepts a valid bug report', () => {
    const parsed = recordFeedbackParamsSchema.parse({
      category: 'bugs',
      title: 'resize_node no-ops on locked nodes',
      description: 'Got success but nothing changed.',
      tool: 'resize_node',
    })
    expect(parsed.category).toBe('bugs')
  })
  it('rejects an unknown category', () => {
    expect(() =>
      recordFeedbackParamsSchema.parse({
        category: 'wishlist',
        title: 't',
        description: 'd',
      }),
    ).toThrow()
  })
  it('makes tool optional', () => {
    const parsed = recordFeedbackParamsSchema.parse({
      category: 'proposals',
      title: 't',
      description: 'd',
    })
    expect(parsed.tool).toBeUndefined()
  })
})
