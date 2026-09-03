// create-tree.test.ts — the M3 recursive create (REBUILD on NodeSpec).
//
// create_tree sends COMMANDS.CREATE_TREE with { tree, parentId?, refs? } where
// `tree`/`refs` are TreeNodeSpecs CONVERTED on the grammar WRITE FACE via
// specToFigmaForCreate (atom leaves parsed; name ?? type fallback), recursing
// into children. `{ ref }` and `{ id }` nodes pass through as bare markers the
// plugin resolves. Reports through formatMutationResult so a plugin {error}
// surfaces as an error.
//
// `convertTree` (the pure recursive converter) is unit-tested directly for the
// recursive children + ref-pool + ordering shape; the handler is tested via a
// stub FigmaClient that captures the forwarded command + params.

import { describe, expect, it } from 'bun:test'
import {
  handleCreateTree,
  convertTree,
  assertNoNestedComponent,
} from '@figma-agent-bridge/server/tools/create-tree'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

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
    return (
      opts.reply ?? {
        id: 'created:1',
        name: 'Card',
        type: 'FRAME',
      }
    )
  },
})

describe('convertTree (recursive children + ref-pool)', () => {
  it('converts a plain node: atom leaves parsed, name ?? type fallback', () => {
    const out = convertTree({
      type: 'RECTANGLE',
      size: [10, 10],
      fills: ['#FF0000'],
    })
    expect(out.type).toBe('RECTANGLE')
    expect(out.name).toBe('RECTANGLE') // name ?? type fallback
    expect(out.fills).toEqual([
      { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
    ])
  })

  it('B29: a sized frame WITH a child keeps the size it stated', () => {
    // The live regression this rule exists for: `size:[300,200]` plus one child
    // read back [300,30] / ["FIXED","HUG"] — the injected auto-layout hugged
    // the height away. An empty frame keeps its size either way, which is why
    // the shape that matters here is the one with a child.
    const out = convertTree({
      type: 'FRAME',
      name: 'Card',
      size: [300, 200],
      children: [{ type: 'RECTANGLE', size: [100, 20] }],
    })
    expect(out.layout).toEqual({ mode: 'V' })
    expect(out.sizing).toEqual(['FIXED', 'FIXED'])
    // The child stated a size and no layout of its own, and is not a frame —
    // it takes neither half of the default.
    const child = (
      out.children as Record<string, unknown>[]
    )[0]
    expect(child.layout).toBeUndefined()
    expect(child.sizing).toBeUndefined()
  })

  it('recurses into children, converting each level', () => {
    const out = convertTree({
      type: 'FRAME',
      name: 'Card',
      children: [
        {
          type: 'FRAME',
          name: 'Row',
          children: [
            {
              type: 'TEXT',
              size: [80, 20],
              text: {
                content: 'Hi',
                font: 'font(Inter,Bold,16)',
              },
            },
          ],
        },
      ],
    })
    const children = out.children as Record<
      string,
      unknown
    >[]
    expect(children).toHaveLength(1)
    expect(children[0].type).toBe('FRAME')
    const grandchildren = children[0].children as Record<
      string,
      unknown
    >[]
    expect(grandchildren[0].type).toBe('TEXT')
    // text.font atom parsed to a { family, style, size } object.
    const text = grandchildren[0].text as {
      font: { family: string; size: number }
    }
    expect(text.font.family).toBe('Inter')
    expect(text.font.size).toBe(16)
  })

  it('passes a { ref } node through unchanged (re-built by the plugin)', () => {
    expect(convertTree({ ref: 'btn' })).toEqual({
      ref: 'btn',
    })
  })

  it('passes an { id } clone node through unchanged', () => {
    expect(convertTree({ id: '1:99' })).toEqual({
      id: '1:99',
    })
  })

  // ── B83: a { ref } with fields beside it ──────────────────────────────────
  //
  // LIVE (2026-09-01): twelve icon components in ONE create_tree, each child
  // `{ref:'ink', vectorPaths:['path(NONE,"M 3 3 L 8 3 …")']}` over a shared
  // `refs.ink` VECTOR spec. The call returned THIRTEEN ids and `warnings: []`
  // — a clean success — and the read-back showed every vector at [100,100]
  // with `vectorPaths: []`. The atoms were fine: the identical string through
  // `update_node` on the same node landed perfectly, size [14,14], path
  // rebased. They never reached the write face, because the union's `{ref}`
  // branch was a bare `z.object` and zod strips what it does not name.
  describe('a { ref } carrying overrides', () => {
    const inkPool = {
      ink: {
        type: 'VECTOR',
        name: 'ink',
        size: [14, 14] as [number, number],
        strokes: ['#7C5CFF'],
        fills: [],
      },
    }

    it('merges the sibling fields over the pooled spec', () => {
      const out = convertTree(
        {
          ref: 'ink',
          vectorPaths: ['path(NONE,"M 3 3 L 8 3")'],
        } as never,
        undefined,
        inkPool as never,
      ) as Record<string, unknown>
      // The override landed…
      expect(out.vectorPaths).toBeDefined()
      // …and the pooled spec is still what the node IS.
      expect(out.type).toBe('VECTOR')
      expect(out.name).toBe('ink')
      expect(out.size).toEqual([14, 14])
      expect(out.strokes).toBeDefined()
      expect(out.ref).toBeUndefined()
    })

    it('gives each use its own copy', () => {
      const out = convertTree(
        {
          type: 'FRAME',
          children: [
            {
              ref: 'ink',
              name: 'first',
              vectorPaths: ['path(NONE,"M 0 0 L 1 1")'],
            },
            { ref: 'ink', name: 'second' },
          ],
        } as never,
        undefined,
        inkPool as never,
      )
      const kids = out.children as Record<string, unknown>[]
      expect(kids[0].name).toBe('first')
      expect(kids[1].name).toBe('second')
      expect(kids[0].vectorPaths).toBeDefined()
      expect(kids[1].vectorPaths).toBeUndefined()
    })

    it('stays a marker when the ref carries nothing of its own', () => {
      expect(
        convertTree(
          { ref: 'ink' },
          undefined,
          inkPool as never,
        ),
      ).toEqual({ ref: 'ink' })
    })

    it('leaves an unknown ref to the plugin to refuse', () => {
      expect(
        convertTree(
          { ref: 'nope', name: 'x' } as never,
          undefined,
          inkPool as never,
        ),
      ).toEqual({ ref: 'nope' })
    })

    it('refuses an { id } clone that carries fields it cannot apply', () => {
      // The other half of B83's ask. There is no pooled spec to merge onto —
      // the source is a node in the document — so silence is the one answer
      // that must not be given.
      expect(() =>
        convertTree({
          id: '1:99',
          vectorPaths: ['path(NONE,"M 0 0")'],
        } as never),
      ).toThrow(/vectorPaths/)
      expect(() =>
        convertTree({
          id: '1:99',
          vectorPaths: ['path(NONE,"M 0 0")'],
        } as never),
      ).toThrow(/update_node/)
    })
  })

  it('keeps ref/clone markers inside a children array', () => {
    const out = convertTree({
      type: 'FRAME',
      children: [
        { ref: 'btn' },
        { id: '1:99' },
        { type: 'RECTANGLE', size: [4, 4] },
      ],
    })
    const children = out.children as Record<
      string,
      unknown
    >[]
    expect(children[0]).toEqual({ ref: 'btn' })
    expect(children[1]).toEqual({ id: '1:99' })
    expect(children[2].type).toBe('RECTANGLE')
  })

  // Issue #2: create_tree validates every CREATED node's type against the SAME
  // CREATABLE_TYPES list create_node uses, so the unspecced composite-via-children
  // family (BOOLEAN_OPERATION, GROUP, TRANSFORM_GROUP) is rejected consistently.
  it('throws a clear error for a BOOLEAN_OPERATION node (use boolean_op instead)', () => {
    expect(() =>
      convertTree({
        type: 'BOOLEAN_OPERATION',
        children: [
          { type: 'RECTANGLE', size: [4, 4] },
          { type: 'ELLIPSE', size: [4, 4] },
        ],
      } as unknown as Parameters<typeof convertTree>[0]),
    ).toThrow(/Unsupported node type "BOOLEAN_OPERATION"/)
  })

  it('throws a clear error for a GROUP node nested inside a tree', () => {
    expect(() =>
      convertTree({
        type: 'FRAME',
        children: [
          {
            type: 'GROUP',
            children: [{ type: 'RECTANGLE', size: [4, 4] }],
          },
        ],
      } as unknown as Parameters<typeof convertTree>[0]),
    ).toThrow(/Unsupported node type "GROUP"/)
  })

  it('throws a clear error for a TRANSFORM_GROUP node', () => {
    expect(() =>
      convertTree({
        type: 'TRANSFORM_GROUP',
        children: [{ type: 'RECTANGLE', size: [4, 4] }],
      } as unknown as Parameters<typeof convertTree>[0]),
    ).toThrow(/Unsupported node type "TRANSFORM_GROUP"/)
  })

  // Issue #3: TEXT_PATH (figma.createTextPath) is real but was never specced/wired
  // (vectorNodeId/startSegment/startPosition), so it is honest-rejected against the
  // SAME CREATABLE_TYPES list — deferred to the spec-completeness phase. See
  // docs/deferred-capabilities.md.
  it('throws a clear error for a TEXT_PATH node (deferred, not creatable)', () => {
    expect(() =>
      convertTree({ type: 'TEXT_PATH' }),
    ).toThrow(/Unsupported node type "TEXT_PATH"/)
  })

  // { id } / { ref } markers are EXEMPT: they reference/clone an EXISTING node
  // (not a new type) so they pass through untouched even for a node whose
  // existing type is a composite (e.g. cloning an existing BOOLEAN_OPERATION).
  it('does NOT validate the type of an { id } clone marker (clone-of-composite still works)', () => {
    expect(convertTree({ id: '1:99' })).toEqual({
      id: '1:99',
    })
  })

  it('does NOT validate the type of a { ref } marker', () => {
    expect(convertTree({ ref: 'btn' })).toEqual({
      ref: 'btn',
    })
  })

  it('maps the layout struct to the plugin spacing/padding shape (ordering precursor)', () => {
    const out = convertTree({
      type: 'FRAME',
      layout: {
        mode: 'V',
        gap: 12,
        pad: [16, 16, 16, 16],
        align: ['MIN', 'CENTER'],
      },
      sizing: ['FILL', 'HUG'],
    })
    expect(out.layout).toEqual({
      mode: 'V',
      spacing: 12,
      padding: [16, 16, 16, 16],
      align: ['MIN', 'CENTER'],
    })
    // sizing rides as a post-append key the plugin sets AFTER appendChild.
    expect(out.sizing).toEqual(['FILL', 'HUG'])
  })
})

describe('handleCreateTree', () => {
  it('sends COMMANDS.CREATE_TREE with a converted tree + parentId', async () => {
    const sent: Sent[] = []
    await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'Card',
          fills: ['#FFFFFF'],
          children: [{ type: 'RECTANGLE', size: [4, 4] }],
        },
        parentId: '1:2',
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe(COMMANDS.CREATE_TREE)
    expect(sent[0].params?.parentId).toBe('1:2')
    const tree = sent[0].params?.tree as {
      type: string
      fills: { type: string }[]
      children: { type: string }[]
    }
    expect(tree.type).toBe('FRAME')
    expect(tree.fills[0].type).toBe('SOLID') // atom parsed
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].type).toBe('RECTANGLE')
  })

  // Issue #2: a created composite-via-children type is rejected at the SERVER
  // boundary with a clean { error } and never forwarded to the plugin.
  it('rejects a BOOLEAN_OPERATION child with a clear error before sending', async () => {
    const sent: Sent[] = []
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          children: [
            {
              type: 'BOOLEAN_OPERATION',
              children: [
                { type: 'RECTANGLE', size: [4, 4] },
                { type: 'ELLIPSE', size: [4, 4] },
              ],
            } as unknown as { type: string },
          ],
        },
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(0)
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.code).toBe('UNSUPPORTED_NODE_TYPE')
    expect(data.error).toContain('BOOLEAN_OPERATION')
    // The message points the agent at the right tool + self-documents valids.
    expect(data.error).toContain('boolean_op')
    expect(data.error).toContain('FRAME')
  })

  it('rejects a GROUP child with a clear error before sending', async () => {
    const sent: Sent[] = []
    const result = await handleCreateTree(
      {
        tree: {
          type: 'GROUP',
          children: [{ type: 'RECTANGLE', size: [4, 4] }],
        } as unknown as { type: string },
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(0)
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.code).toBe('UNSUPPORTED_NODE_TYPE')
    expect(data.error).toContain('GROUP')
  })

  it('forwards an { id } clone marker untouched (clone path unaffected)', async () => {
    const sent: Sent[] = []
    await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          children: [{ id: '1:99' }],
        },
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
    const tree = sent[0].params?.tree as {
      children: { id: string }[]
    }
    expect(tree.children[0]).toEqual({ id: '1:99' })
  })

  it('converts the ref-pool and forwards it as { refs }', async () => {
    const sent: Sent[] = []
    await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          children: [{ ref: 'btn' }, { ref: 'btn' }],
        },
        refs: {
          btn: {
            type: 'RECTANGLE',
            name: 'Button',
            fills: ['#0000FF'],
          },
        },
      },
      stubClient({ sent }),
    )
    const params = sent[0].params as Record<string, unknown>
    // tree keeps the two { ref } markers (re-used → re-built by the plugin).
    const tree = params.tree as {
      children: { ref: string }[]
    }
    expect(tree.children).toEqual([
      { ref: 'btn' },
      { ref: 'btn' },
    ])
    // refs carries the CONVERTED pool entry (atom parsed).
    const refs = params.refs as {
      btn: { type: string; fills: { type: string }[] }
    }
    expect(refs.btn.type).toBe('RECTANGLE')
    expect(refs.btn.fills[0].type).toBe('SOLID')
  })

  it('omits refs when none are supplied', async () => {
    const sent: Sent[] = []
    await handleCreateTree(
      { tree: { type: 'FRAME' } },
      stubClient({ sent }),
    )
    expect(sent[0].params?.refs).toBeUndefined()
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleCreateTree(
      { tree: { type: 'FRAME' } },
      stubClient({
        reply: {
          error:
            'Parent not found or cannot have children: 1:2',
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

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
    }
    const result = await handleCreateTree(
      { tree: { type: 'FRAME' } },
      client,
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'plugin exploded',
      code: 'PLUGIN_ERROR',
    })
  })
})

// tool-surface.md: `create_tree(tree, {parentId?, refs?}) → {root, ids[]}`.
// Returning the root ALONE is the bug the change feed's own design names — a
// generic id-harvester misses N-1 nodes, and an agent that just built a tree
// cannot address what it built without a follow-up read.
describe('handleCreateTree reply shape — {root, ids[]}', () => {
  it('returns the root AND every created id, not the root alone', async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'Card',
          children: [
            { type: 'TEXT', name: 'Title' },
            { type: 'RECTANGLE', name: 'Divider' },
          ],
        },
      },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'Card',
          type: 'FRAME',
          ids: ['created:1', 'created:2', 'created:3'],
        },
      }),
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.root).toEqual({
      id: 'created:1',
      name: 'Card',
      type: 'FRAME',
    })
    expect(data.ids).toEqual([
      'created:1',
      'created:2',
      'created:3',
    ])
  })

  it('is HONEST when the plugin reports no ids: the root only, and it says so', async () => {
    const result = await handleCreateTree(
      { tree: { type: 'FRAME', name: 'Card' } },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'Card',
          type: 'FRAME',
        },
      }),
    )
    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.root).toEqual({
      id: 'created:1',
      name: 'Card',
      type: 'FRAME',
    })
    expect(data.ids).toEqual(['created:1'])
    // In the reply's own `warnings[]`, not in prose after it (B61).
    expect(data.warnings).toHaveLength(1)
    expect((data.warnings as string[])[0]).toContain(
      'reported no created ids',
    )
  })

  it('keeps a plugin {error} an error (no root, no ids)', async () => {
    const result = await handleCreateTree(
      { tree: { type: 'FRAME' } },
      stubClient({ reply: { error: 'Parent not found' } }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Parent not found',
      code: 'NODE_NOT_FOUND',
    })
  })
})

// B28: the plugin DEGRADES rather than throws on a write Figma refuses (T7) —
// e.g. `sizing:['FILL',…]` on a child of a parent that is not auto-layout — and
// the caller only ever sees the ROOT's reply for the whole subtree. So a degrade
// at any depth rides home on `reply.warnings`, and this handler is the one place
// it can join the server's own lossy-conversion notes. Not merging here is not a
// formatting miss: it is the build silently shipping a node sized differently
// than it asked for.
//
// The stubbed warning is the REAL emitter's wording (code.ts
// applyPostAppendProperties: `sizing not applicable on this node (<TYPE>):
// <error>`) — a stub that invents its own format tests nothing about the
// production path.
describe('handleCreateTree — plugin-reported degrades', () => {
  it('surfaces a plugin warning in the reply’s own warnings[]', async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'Card',
          children: [{ type: 'FRAME', name: 'Body' }],
        },
      },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'Card',
          type: 'FRAME',
          ids: ['created:1', 'created:2'],
          warnings: [
            'sizing not applicable on this node (FRAME): Error: FILL can only be set on children of auto-layout frames',
          ],
        },
      }),
    )
    const { text } = result.content[0]
    const data = JSON.parse(text) as Record<string, unknown>
    expect(data.warnings).toEqual([
      'sizing not applicable on this node (FRAME): Error: FILL can only be set on children of auto-layout frames',
    ])
    // Reported ONCE, and as DATA. It used to be loose `Warning:` prose after
    // the JSON, which is how B61's live gate saw a clean build on a subtree
    // whose root had just had its stated size hugged away.
    expect(
      text.split('sizing not applicable'),
    ).toHaveLength(2)
    expect(text).not.toContain('Warning: ')
    expect(data.ids).toEqual(['created:1', 'created:2'])
  })

  it('adds no Warning: line when the plugin reports none', async () => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'Card',
          children: [{ type: 'TEXT', name: 'Title' }],
        },
      },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'Card',
          type: 'FRAME',
          ids: ['created:1', 'created:2'],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Warning:')
  })
})

// ---------------------------------------------------------------------------
// B61 (live-gate follow-up) — a create_tree degrade has to be READABLE
// ---------------------------------------------------------------------------
//
// The B61 warning fired in the plugin and the live probe still saw nothing.
// `shapeReply` pulled `warnings` OUT of the JSON body and the handler appended
// it as loose `Warning:` prose after the JSON — so every T7 degrade a subtree
// build produces (a refused FILL on a slot child, B35's discarded child
// positions, B61's discarded size) left the structured reply looking clean.
//
// `update_node` says the rule in its own source: merge into the reply's
// structured `warnings[]`, "one concept, one surface … rather than appending
// loose text". create_tree was the one write path that did the other thing, and
// it is the path that builds whole screens.
//
// This is the class the earlier tests missed: every one of them asserted the
// warning reached a `string[]` SINK. None asserted it reached the CALLER.
describe('create_tree degrades reach the caller (B61)', () => {
  const withPluginWarnings = async (
    pluginWarnings: string[],
  ): Promise<{
    text: string
    body: { warnings?: string[]; root?: unknown }
  }> => {
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'b61x',
          size: [400, 60],
          layout: { mode: 'H', gap: 16 },
          children: [
            { type: 'RECTANGLE', size: [60, 30] },
            { type: 'RECTANGLE', size: [60, 30] },
          ],
        },
      },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'b61x',
          type: 'FRAME',
          ids: ['created:1', 'created:2', 'created:3'],
          warnings: pluginWarnings,
        },
      }),
    )
    const { text } = result.content[0]
    return {
      text,
      body: JSON.parse(text.split('\n\nWarning:')[0]) as {
        warnings?: string[]
      },
    }
  }

  const B61_NOTE =
    'size not applied — asked [400, 60], "b61x" reads [136, 60].' +
    ' Auto-layout owns the width (layoutSizingHorizontal: HUG).' +
    ' Pin it with sizing:["FIXED","FIXED"].'

  it('puts the plugin’s warning in the structured reply, not only in prose', async () => {
    const { body } = await withPluginWarnings([B61_NOTE])
    expect(body.warnings).toEqual([B61_NOTE])
  })

  it('keeps the root and ids beside it', async () => {
    const { body } = await withPluginWarnings([B61_NOTE])
    expect(body.root).toEqual({
      id: 'created:1',
      name: 'b61x',
      type: 'FRAME',
    })
    expect((body as { ids?: string[] }).ids).toHaveLength(3)
  })

  it('reports each degrade ONCE — never in the body and the prose both', async () => {
    const { text } = await withPluginWarnings([B61_NOTE])
    expect(text.split('size not applied')).toHaveLength(2)
  })

  it('merges the server’s own conversion notes into the same list', async () => {
    // One concept, one surface: a lossy conversion on the write face and a
    // plugin-side degrade are the same kind of news to the caller.
    const result = await handleCreateTree(
      {
        tree: {
          type: 'FRAME',
          name: 'b61y',
          // A var() on a per-corner radius has no binding route — the write
          // face warns and applies the literal.
          radius: 'var(radius/md)[8,8,0,0]',
          children: [{ type: 'RECTANGLE', size: [4, 4] }],
        },
      },
      stubClient({
        reply: {
          id: 'created:1',
          name: 'b61y',
          type: 'FRAME',
          ids: ['created:1', 'created:2'],
          warnings: [B61_NOTE],
        },
      }),
    )
    const body = JSON.parse(
      result.content[0].text.split('\n\nWarning:')[0],
    ) as { warnings?: string[] }
    expect(body.warnings).toHaveLength(2)
    expect(body.warnings?.[0]).toBe(B61_NOTE)
    expect(body.warnings?.[1]).toContain(
      'per-corner radius',
    )
  })

  it('stays clean when nothing degraded', async () => {
    const { body, text } = await withPluginWarnings([])
    expect('warnings' in body).toBe(false)
    expect(text).not.toContain('Warning:')
  })
})

// ─── I69 — a component master is built in place ──────────────────────────────
//
// Building N masters used to cost 2N+ round-trips: create_tree refused
// `type:'COMPONENT'`, so every master was a create_tree for the body plus a
// create_component to promote it. A tree node of `type:'COMPONENT'` now creates
// the master itself, children included.
//
// The one shape Figma has no room for is a master inside a master. That is
// refused on the WRITE FACE, before a node is created, because it is a property
// of the SUBMITTED TREE alone — no document read can change the answer, and a
// tree that dies half-built is the failure create_tree is specified never to
// have.

describe('I69 — COMPONENT in create_tree', () => {
  it('converts a COMPONENT node instead of rejecting the type', () => {
    const out = convertTree({
      type: 'COMPONENT',
      name: 'Button',
      children: [
        {
          type: 'TEXT',
          text: {
            content: 'Go',
            font: 'font(Inter,Bold,16)',
          },
        },
      ],
    })
    expect(out.type).toBe('COMPONENT')
    expect(out.name).toBe('Button')
    expect(
      (out.children as Record<string, unknown>[])[0].type,
    ).toBe('TEXT')
  })

  it('gives a COMPONENT the same creation default a FRAME gets', () => {
    // A master is the container the stack default was written for. It states no
    // layout, so it stacks; it stated a size, so the size is pinned against the
    // hug the stack would otherwise apply (B29).
    const out = convertTree({
      type: 'COMPONENT',
      name: 'Button',
      size: [200, 48],
      children: [{ type: 'RECTANGLE', size: [8, 8] }],
    })
    expect(out.layout).toEqual({ mode: 'V' })
    expect(out.sizing).toEqual(['FIXED', 'FIXED'])
  })

  it('refuses a COMPONENT nested inside a COMPONENT, naming the way through', () => {
    expect(() =>
      assertNoNestedComponent({
        type: 'COMPONENT',
        name: 'Card',
        children: [
          {
            type: 'FRAME',
            name: 'Body',
            children: [
              { type: 'COMPONENT', name: 'Badge' },
            ],
          },
        ],
      }),
    ).toThrow(/no nested masters/i)
  })

  it('names both the inner master and the master that encloses it', () => {
    let message = ''
    try {
      assertNoNestedComponent({
        type: 'COMPONENT',
        name: 'Card',
        children: [{ type: 'COMPONENT', name: 'Badge' }],
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('Badge')
    expect(message).toContain('Card')
    // The way through: an INSTANCE of a master built elsewhere.
    expect(message).toContain('INSTANCE')
  })

  it('allows an INSTANCE child inside a COMPONENT', () => {
    expect(() =>
      assertNoNestedComponent({
        type: 'COMPONENT',
        name: 'Card',
        children: [
          {
            type: 'INSTANCE',
            component: { id: '1:2' },
          },
          { id: '1:99' },
        ],
      }),
    ).not.toThrow()
  })

  it('allows sibling COMPONENTs under a plain FRAME', () => {
    expect(() =>
      assertNoNestedComponent({
        type: 'FRAME',
        name: 'Library',
        children: [
          { type: 'COMPONENT', name: 'A' },
          { type: 'COMPONENT', name: 'B' },
        ],
      }),
    ).not.toThrow()
  })

  it('follows a { ref } into the pool: a COMPONENT ref used inside a COMPONENT refuses', () => {
    expect(() =>
      assertNoNestedComponent(
        {
          type: 'COMPONENT',
          name: 'Card',
          children: [{ ref: 'badge' }],
        },
        { badge: { type: 'COMPONENT', name: 'Badge' } },
      ),
    ).toThrow(/no nested masters/i)
  })

  it('allows the same COMPONENT ref used outside a COMPONENT', () => {
    expect(() =>
      assertNoNestedComponent(
        {
          type: 'FRAME',
          name: 'Library',
          children: [{ ref: 'badge' }],
        },
        { badge: { type: 'COMPONENT', name: 'Badge' } },
      ),
    ).not.toThrow()
  })

  it('does not recurse forever on a cyclic ref pool', () => {
    // The plugin owns the cycle error; this guard must simply not hang before
    // the walk gets there.
    expect(() =>
      assertNoNestedComponent(
        { type: 'FRAME', children: [{ ref: 'a' }] },
        {
          a: { type: 'FRAME', children: [{ ref: 'b' }] },
          b: { type: 'FRAME', children: [{ ref: 'a' }] },
        },
      ),
    ).not.toThrow()
  })

  it('handleCreateTree refuses a nested master before any node is created', async () => {
    const sent: Sent[] = []
    const result = await handleCreateTree(
      {
        tree: {
          type: 'COMPONENT',
          name: 'Card',
          children: [{ type: 'COMPONENT', name: 'Badge' }],
        },
      },
      stubClient({ sent }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toMatch(/no nested masters/i)
    expect(sent).toHaveLength(0)
  })
})
