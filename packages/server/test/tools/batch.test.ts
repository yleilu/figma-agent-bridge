// batch.test.ts — handleBatch (the one generic batch tool, D3).
//
// `batch({ op?, ops:[{op?, ...params}] }) → { results, errors[] }`. N WRITE ops
// over EXISTING targets, executed in ARRAY ORDER with PARTIAL SUCCESS. A
// top-level `op` is the default; each entry may override it with its own `op`.
//
// EXECUTION MODEL — one round-trip: the SERVER converts each op's params on the
// grammar write face (reusing specToFigma / value-convert) and sends ONE
// COMMANDS.BATCH carrying the converted ops; the plugin loops them and replies
// with a per-op {ok,result|error}. These unit tests use a stub client whose
// `batch` reply mimics that plugin loop, so we can assert BOTH the converted
// params the server forwarded AND the partial-success merge.

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  BATCH_ENTRY_SCHEMAS,
  handleBatch,
} from '@figma-agent-bridge/server/tools/batch'
import {
  batchOpSchema,
  batchParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'

type SentOp = {
  op: string
  params: Record<string, unknown>
}
type Sent = {
  command: string
  params?: Record<string, unknown>
}

type PerOpReply = {
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * A stub client that, for COMMANDS.BATCH, runs `simulate` over each forwarded
 * (already-converted) op to produce its {ok,result|error} — exactly the shape
 * the real plugin's BATCH loop returns. The default simulator echoes the
 * converted params back so conversion is assertable.
 */
const stubClient = (opts: {
  sent?: Sent[]
  simulate?: (op: SentOp, index: number) => PerOpReply
  reply?: unknown
}): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    if (opts.reply !== undefined) {
      return opts.reply
    }
    const ops = (params?.ops as SentOp[]) ?? []
    const simulate =
      opts.simulate ??
      ((op: SentOp) => ({ ok: true, result: op.params }))
    return { results: ops.map((op, i) => simulate(op, i)) }
  },
})

type BatchOut = {
  results: {
    index: number
    op: string | null
    ok: boolean
    result?: unknown
    error?: string
  }[]
  errors: {
    index: number
    op: string | null
    error?: string
    code: string
  }[]
}

const parse = (text: string): BatchOut =>
  JSON.parse(text) as BatchOut

describe('handleBatch', () => {
  it('homogeneous: a top-level op runs over N targets (entries omit op)', async () => {
    const sent: Sent[] = []
    const result = await handleBatch(
      {
        op: 'delete_node',
        ops: [
          { nodeId: '1:1' },
          { nodeId: '1:2' },
          { nodeId: '1:3' },
        ],
      },
      stubClient({ sent }),
    )
    // ONE round-trip: a single COMMANDS.BATCH carrying all three ops.
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe(COMMANDS.BATCH)
    const forwarded = sent[0].params?.ops as SentOp[]
    expect(forwarded).toHaveLength(3)
    expect(
      forwarded.every(o => o.op === 'delete_node'),
    ).toBe(true)
    expect(forwarded.map(o => o.params.nodeId)).toEqual([
      '1:1',
      '1:2',
      '1:3',
    ])
    const out = parse(result.content[0].text)
    expect(out.results.map(r => r.op)).toEqual([
      'delete_node',
      'delete_node',
      'delete_node',
    ])
    expect(out.results.every(r => r.ok)).toBe(true)
    expect(out.errors).toEqual([])
  })

  it('heterogeneous: each entry sets its own op', async () => {
    const sent: Sent[] = []
    const result = await handleBatch(
      {
        ops: [
          { op: 'update_node', nodeId: '1:1', patch: {} },
          {
            op: 'reparent_node',
            nodeId: '1:2',
            parentId: '1:9',
          },
          {
            op: 'apply_style',
            nodeId: '1:3',
            styleId: 'S:1',
            field: 'fill',
          },
        ],
      },
      stubClient({ sent }),
    )
    const forwarded = sent[0].params?.ops as SentOp[]
    expect(forwarded.map(o => o.op)).toEqual([
      'update_node',
      'reparent_node',
      'apply_style',
    ])
    const out = parse(result.content[0].text)
    expect(out.results.map(r => r.op)).toEqual([
      'update_node',
      'reparent_node',
      'apply_style',
    ])
  })

  it('default-op fallback: per-entry op overrides the top-level op', async () => {
    const sent: Sent[] = []
    await handleBatch(
      {
        op: 'delete_node',
        ops: [
          { nodeId: '1:1' }, // falls back to delete_node
          { op: 'set_focus', nodeIds: ['1:2'] }, // overrides
          { nodeId: '1:3' }, // falls back to delete_node
        ],
      },
      stubClient({ sent }),
    )
    const forwarded = sent[0].params?.ops as SentOp[]
    expect(forwarded.map(o => o.op)).toEqual([
      'delete_node',
      'set_focus',
      'delete_node',
    ])
  })

  it('executes in array order (result indices follow ops order)', async () => {
    const result = await handleBatch(
      {
        op: 'delete_node',
        ops: [
          { nodeId: 'a' },
          { nodeId: 'b' },
          { nodeId: 'c' },
        ],
      },
      stubClient({
        simulate: (op, i) => ({
          ok: true,
          result: { order: i, nodeId: op.params.nodeId },
        }),
      }),
    )
    const out = parse(result.content[0].text)
    expect(out.results.map(r => r.index)).toEqual([0, 1, 2])
    expect(
      out.results.map(
        r => (r.result as { nodeId: string }).nodeId,
      ),
    ).toEqual(['a', 'b', 'c'])
  })

  it('partial success: op[1] fails → its error is recorded, op[0]/op[2] still succeed', async () => {
    const result = await handleBatch(
      {
        op: 'delete_node',
        ops: [
          { nodeId: 'ok-0' },
          { nodeId: 'bad-1' },
          { nodeId: 'ok-2' },
        ],
      },
      stubClient({
        // The plugin loop isolates a per-op failure: op[1] returns {ok:false}.
        simulate: (op, i) =>
          i === 1
            ? { ok: false, error: 'Node not found: bad-1' }
            : {
                ok: true,
                result: { id: op.params.nodeId },
              },
      }),
    )
    const out = parse(result.content[0].text)
    expect(out.results[0].ok).toBe(true)
    expect(out.results[1].ok).toBe(false)
    expect(out.results[1].error).toBe(
      'Node not found: bad-1',
    )
    expect(out.results[2].ok).toBe(true)
    // errors[] summarizes only the failures, with index + op + code.
    expect(out.errors).toEqual([
      {
        index: 1,
        op: 'delete_node',
        error: 'Node not found: bad-1',
        code: 'NODE_NOT_FOUND',
      },
    ])
  })

  it('converts per-op params server-side: update_node patch → specToFigma spec', async () => {
    const sent: Sent[] = []
    await handleBatch(
      {
        ops: [
          {
            op: 'update_node',
            nodeId: '1:1',
            patch: { name: 'Renamed', fills: ['#FF0000'] },
          },
        ],
      },
      stubClient({ sent }),
    )
    const forwarded = sent[0].params?.ops as SentOp[]
    const p = forwarded[0].params
    // The handler reshapes {nodeId,patch} → {nodeId,spec} and parses the fills
    // atom to a Figma paint (proves the SAME server conversion as update_node).
    expect(p.nodeId).toBe('1:1')
    const spec = p.spec as {
      name: string
      fills: { type: string; color: { r: number } }[]
    }
    expect(spec.name).toBe('Renamed')
    expect(spec.fills[0].type).toBe('SOLID')
    expect(spec.fills[0].color.r).toBeCloseTo(1, 5)
  })

  // D3/T7: a batched update_node emits the SAME server-side writer warnings a
  // direct update_node would (e.g. GRID-only layout keys on a non-GRID mode).
  // Each entry gains an optional warnings[] surfacing them.
  it('surfaces per-op server-side writer warnings on a batched update_node entry', async () => {
    const result = await handleBatch(
      {
        ops: [
          {
            op: 'update_node',
            nodeId: '1:1',
            patch: { layout: { mode: 'V', rows: 2 } },
          },
        ],
      },
      stubClient({}),
    )
    const out = parse(
      result.content[0].text,
    ) as BatchOut & {
      results: { warnings?: string[] }[]
    }
    expect(out.results[0].ok).toBe(true)
    expect(
      (out.results[0].warnings ?? []).some(w =>
        w.includes(
          'rows/cols/rowGap/colGap keys are GRID-only',
        ),
      ),
    ).toBe(true)
  })

  it('does not attach an empty warnings[] when an update_node entry is clean', async () => {
    const result = await handleBatch(
      {
        ops: [
          {
            op: 'update_node',
            nodeId: '1:1',
            patch: { opacity: 0.5 },
          },
        ],
      },
      stubClient({}),
    )
    const out = parse(
      result.content[0].text,
    ) as BatchOut & {
      results: { warnings?: string[] }[]
    }
    // No server-side warnings → no warnings key (or an empty one is fine, but
    // the clean path should not invent warnings).
    expect(out.results[0].warnings ?? []).toEqual([])
  })

  it('converts COLOR style values server-side (create_styles atom → Paint)', async () => {
    const sent: Sent[] = []
    await handleBatch(
      {
        ops: [
          {
            op: 'create_styles',
            styles: [
              {
                type: 'paint',
                name: 'Brand/Primary',
                value: '#3B82F6',
              },
            ],
          },
        ],
      },
      stubClient({ sent }),
    )
    const forwarded = sent[0].params?.ops as SentOp[]
    const styles = forwarded[0].params.styles as {
      index: number
      type: string
      value: {
        type: string
        color: { r: number; g: number; b: number }
      }
    }[]
    expect(styles[0].index).toBe(0)
    expect(styles[0].value.type).toBe('SOLID')
    expect(styles[0].value.color.r).toBeCloseTo(0.231, 2)
  })

  it('a server-side conversion failure is isolated to its entry (not sent to the plugin)', async () => {
    const sent: Sent[] = []
    const result = await handleBatch(
      {
        ops: [
          { op: 'delete_node', nodeId: '1:1' },
          // malformed COLOR atom → colorValueToRgba throws server-side.
          {
            op: 'create_variables',
            collection: 'Brand',
            variables: [
              {
                name: 'Bad',
                type: 'COLOR',
                valuesByMode: { Light: 'not-a-hex' },
              },
            ],
          },
          { op: 'delete_node', nodeId: '1:3' },
        ],
      },
      stubClient({ sent }),
    )
    // Only the two valid ops reached the plugin; the bad one was never sent.
    const forwarded = sent[0].params?.ops as SentOp[]
    expect(forwarded).toHaveLength(2)
    expect(forwarded.map(o => o.params.nodeId)).toEqual([
      '1:1',
      '1:3',
    ])
    const out = parse(result.content[0].text)
    // Original array order + index alignment preserved.
    expect(out.results.map(r => r.index)).toEqual([0, 1, 2])
    expect(out.results[0].ok).toBe(true)
    expect(out.results[1].ok).toBe(false)
    expect(out.results[1].error).toContain('6/8-char hex')
    expect(out.results[2].ok).toBe(true)
    expect(out.errors.map(e => e.index)).toEqual([1])
    expect(out.errors[0].code).toBe('INVALID_PARAM')
  })

  it('an entry with neither a top-level nor a per-entry op records an error', async () => {
    const result = await handleBatch(
      { ops: [{ nodeId: '1:1' }] },
      stubClient({}),
    )
    const out = parse(result.content[0].text)
    expect(out.results[0].ok).toBe(false)
    expect(out.results[0].error).toContain('No op')
    expect(out.errors).toHaveLength(1)
    // No RULES pattern matches this message — the honest PLUGIN_ERROR
    // fallback, never INVALID_PARAM (classifyMessage never blames the
    // agent's parameters for a message it does not recognize).
    expect(out.errors[0].code).toBe('PLUGIN_ERROR')
  })

  // Entry validation (batchEntrySchema is .passthrough() BY DESIGN — its doc
  // promises "the per-op param shape is enforced where each command already
  // enforces it"). It was not: batch called the converters directly, so a
  // malformed field reached specToFigma and died as a server-side TypeError
  // reported as PLUGIN_ERROR ("Figma failed and the server cannot say more") —
  // when Figma never saw the request. Each entry is now parsed by its op's OWN
  // registered param schema, the same one index.ts hands the MCP SDK.
  it('rejects a malformed entry as INVALID_PARAM without aborting the batch', async () => {
    const sent: Sent[] = []
    const result = await handleBatch(
      {
        op: 'update_node',
        ops: [
          // radius is an ATOM STRING; a JSON array is not the grammar.
          { nodeId: 'a', patch: { radius: [8, 8, 0, 0] } },
          { nodeId: 'b', patch: { opacity: 0.5 } },
        ],
      },
      stubClient({ sent }),
    )
    const out = parse(result.content[0].text)
    expect(out.errors[0]).toMatchObject({
      index: 0,
      code: 'INVALID_PARAM',
    })
    expect(out.errors[0].error).toContain('radius')
    // The sibling still ran — D3 partial success.
    expect(out.results.find(r => r.index === 1)?.ok).toBe(
      true,
    )
    // The malformed entry never reached the plugin.
    const forwarded = sent[0].params?.ops as SentOp[]
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].params.nodeId).toBe('b')
  })

  it('names the offending field for any patch key, not just radius', async () => {
    const result = await handleBatch(
      {
        op: 'update_node',
        ops: [{ nodeId: 'a', patch: { fills: [123] } }],
      },
      stubClient({}),
    )
    const out = parse(result.content[0].text)
    expect(out.errors[0].code).toBe('INVALID_PARAM')
    expect(out.errors[0].error).toContain('fills')
  })

  it('rejects a top-level param shape error too (missing required key)', async () => {
    const result = await handleBatch(
      { op: 'reparent_node', ops: [{ nodeId: 'a' }] },
      stubClient({}),
    )
    const out = parse(result.content[0].text)
    expect(out.errors[0].code).toBe('INVALID_PARAM')
    expect(out.errors[0].error).toContain('parentId')
  })

  it('surfaces a plugin-level {error} as an error', async () => {
    const result = await handleBatch(
      { op: 'delete_node', ops: [{ nodeId: '1:1' }] },
      stubClient({ reply: { error: 'relay exploded' } }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('relay exploded')
    expect(data.code).toBe('PLUGIN_ERROR')
  })
})

// The fan-out op set is enumerated in tool-surface.md's "The one generic batch".
// delete_styles sat in that list and not in the enum, so batch({op:'delete_styles'})
// was rejected at validation while its sibling delete_variables went through.
// The op-set tests below assert only that batchParamsSchema ACCEPTS the op —
// they never execute a batch, which is why they could not see that the
// execution path forwarded delete_styles entries untagged. This one runs the
// handler and inspects what actually reaches the plugin.
describe('batch delete_styles — index-tagged like the standalone handler', () => {
  it('tags every style entry with its index (tool-surface.md:371)', async () => {
    const sent: Record<string, unknown>[] = []
    const client = {
      fileKey: 'FK',
      sendCommand: (_cmd: string, params: unknown) => {
        sent.push(params as Record<string, unknown>)
        return Promise.resolve({ results: [], errors: [] })
      },
    } as unknown as Parameters<typeof handleBatch>[1]

    await handleBatch(
      {
        op: 'delete_styles',
        ops: [
          {
            styles: [
              { id: 'S:1' },
              { id: 'bogus' },
              { name: 'X', type: 'paint' },
            ],
          },
        ],
      } as unknown as Parameters<typeof handleBatch>[0],
      client,
    )

    const fanout = sent[0] as {
      ops: { params: { styles: { index?: number }[] } }[]
    }
    const { styles } = fanout.ops[0].params
    // The plugin builds its reply from entry.index; undefined would be dropped
    // by JSON.stringify, leaving a failure the agent cannot map to its input.
    expect(styles.map(s => s.index)).toEqual([0, 1, 2])
  })
})

// B30: a batched update_component must convert its slot specs on the SAME
// write face the standalone handler uses — an unconverted atom string would
// otherwise be assigned to the slot raw.
describe('batch update_component — slot specs are converted', () => {
  it('parses a slot entry fill atom and passes a bare name through', async () => {
    const sent: Sent[] = []
    await handleBatch(
      {
        op: 'update_component',
        ops: [
          {
            componentId: 'c:1',
            slots: [
              'Header',
              { name: 'Content', fills: ['#141B2E'] },
            ],
          },
        ],
      } as unknown as Parameters<typeof handleBatch>[0],
      stubClient({ sent }),
    )
    const forwarded = sent[0].params?.ops as SentOp[]
    const slots = forwarded[0].params.slots as unknown[]
    expect(slots[0]).toBe('Header')
    const specced = slots[1] as {
      name: string
      fills: { type: string }[]
    }
    expect(specced.name).toBe('Content')
    expect(specced.fills[0].type).toBe('SOLID')
  })
})

// The coverage guard. Entry validation is only as good as its op map: an op
// added to batchOpSchema without a schema here would silently rejoin the
// unvalidated path that produced the raw.trim TypeError. The Record<BatchOp,…>
// key type already makes that a compile error; this asserts it at runtime too,
// and catches the other direction (a key that is no longer a batch op).
describe('batch entry validation covers every op', () => {
  it('wires a schema for every op batch accepts, and nothing else', () => {
    expect(Object.keys(BATCH_ENTRY_SCHEMAS).sort()).toEqual(
      [...batchOpSchema.options].sort(),
    )
  })

  it('every wired schema carries the op fields and none of the call fields', () => {
    for (const op of batchOpSchema.options) {
      const keys = Object.keys(
        BATCH_ENTRY_SCHEMAS[op].shape,
      )
      // Non-empty: a schema reduced to {} would accept anything.
      expect([op, keys.length > 0]).toEqual([op, true])
      expect([op, keys.includes('fileKey')]).toEqual([
        op,
        false,
      ])
    }
  })

  it('every wired schema actually rejects an empty entry', () => {
    // delete_variables is the ONE op whose params are all optional — its "at
    // least one of variables/collections" rule is enforced in the handler, not
    // the schema, so .shape survives for MCP registration (tool-params.ts:848).
    // batch does not run the handlers, so that rule stays unenforced here;
    // every OTHER op has a required field and must reject {}.
    const allOptional = new Set(['delete_variables'])
    for (const op of batchOpSchema.options) {
      if (allOptional.has(op)) {
        continue
      }
      expect([
        op,
        BATCH_ENTRY_SCHEMAS[op].safeParse({}).success,
      ]).toEqual([op, false])
    }
  })

  it('drops the call-level addressing keys — an entry carries only its op params', () => {
    // fileKey is validated on the CALL by fileTool, never per entry; leaving it
    // required would fail every well-formed entry.
    expect(
      BATCH_ENTRY_SCHEMAS.delete_node.safeParse({
        nodeId: '1:1',
      }).success,
    ).toBe(true)
  })
})

describe('batch op set matches the spec', () => {
  it('accepts delete_styles', () => {
    expect(() =>
      batchParamsSchema.parse({
        fileKey: 'fk',
        op: 'delete_styles',
        ops: [{ id: 'S:1' }],
      }),
    ).not.toThrow()
  })

  it('still accepts its sibling delete_variables', () => {
    expect(() =>
      batchParamsSchema.parse({
        fileKey: 'fk',
        op: 'delete_variables',
        ops: [{ variables: ['VariableID:1:2'] }],
      }),
    ).not.toThrow()
  })

  it('still rejects a create op (D3 excludes creation)', () => {
    expect(() =>
      batchParamsSchema.parse({
        fileKey: 'fk',
        op: 'create_node',
        ops: [{}],
      }),
    ).toThrow()
  })
})
