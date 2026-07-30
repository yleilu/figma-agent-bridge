// read-serialization.test.ts — pins the one serialization rule in the tool
// contract: `inspect` emits YAML; EVERY other read emits JSON
// (docs/specs/overview.md, "Success payloads").
//
// This guard exists because the obvious assertion does not work. YAML is a
// SUPERSET of JSON, so `YAML.parse()` succeeds on JSON too — every existing
// read test parses with YAML and therefore passes whichever format the handler
// emits. Nothing pinned the format, which is how 13 reads drifted to YAML while
// the contract said JSON.
//
// `JSON.parse` is the discriminator that actually separates them: it accepts
// JSON and rejects `key: value` YAML.

import { describe, expect, it } from 'bun:test'
import {
  handleGetNode,
  handleGetNodes,
  handleInspect,
  handleListPages,
} from '@figma-agent-bridge/server/tools/read'
import { handleGetSelection } from '@figma-agent-bridge/server/tools/selection'
import { handleSearch } from '@figma-agent-bridge/server/tools/search'
import {
  handleGetStyles,
  handleGetVariables,
  handleGetComponents,
  handleListFonts,
} from '@figma-agent-bridge/server/tools/design-system'
import {
  handleGetPluginData,
  handleGetReactions,
  handleGetAnnotations,
} from '@figma-agent-bridge/server/tools/metadata'
import {
  handleSearchComponents,
  handleReindex,
} from '@figma-agent-bridge/server/tools/component-index'
import type { IndexManager } from '@figma-agent-bridge/server/component-index/manager'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

const NODE = {
  id: '1:2',
  name: 'Frame',
  type: 'FRAME',
  children: [],
}

/** A client whose reply is whatever the handler under test expects. */
const stub = (reply: unknown): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async () => reply,
})

const textOf = (r: {
  content: { type: string; text?: string }[]
}): string => r.content[0].text ?? ''

/**
 * True only when the payload is JSON *and could not also be YAML*.
 *
 * Parseability alone is not enough: an empty container serializes to the same
 * `[]` / `{}` in both formats, so a fixture that yields one proves nothing. The
 * quoted-key test is what discriminates — `JSON.stringify(…, null, 2)` always
 * quotes keys, YAML block form never does.
 */
const isJson = (text: string): boolean => {
  try {
    JSON.parse(text)
  } catch {
    return false
  }
  return /"[^"]+":/.test(text)
}

describe('the discriminator itself (liveness)', () => {
  it('accepts pretty-printed JSON', () => {
    expect(isJson(JSON.stringify({ a: 1 }, null, 2))).toBe(
      true,
    )
  })

  it('rejects YAML block form', () => {
    expect(isJson('a: 1\nb:\n  - 2\n')).toBe(false)
  })

  it('rejects an empty container (ambiguous in both formats)', () => {
    expect(isJson('[]')).toBe(false)
    expect(isJson('{}')).toBe(false)
  })
})

describe('inspect is the one YAML reader', () => {
  it('emits YAML, not JSON', async () => {
    const res = await handleInspect(
      { nodeId: '1:2' },
      stub(NODE),
    )
    const text = textOf(res)
    expect(text.length).toBeGreaterThan(0)
    expect(isJson(text)).toBe(false)
    expect(text).toContain('view:')
  })
})

describe('every other read emits JSON', () => {
  const cases: [
    string,
    () => Promise<{
      content: { type: string; text?: string }[]
    }>,
  ][] = [
    [
      'get_node',
      () => handleGetNode({ nodeId: '1:2' }, stub(NODE)),
    ],
    [
      'get_nodes',
      () =>
        handleGetNodes({ nodeIds: ['1:2'] }, stub([NODE])),
    ],
    [
      'list_pages',
      () =>
        handleListPages(
          {},
          stub({
            docName: 'Doc',
            pages: [{ id: '0:1', name: 'Page 1' }],
          }),
        ),
    ],
    [
      'get_selection',
      () =>
        handleGetSelection(
          {},
          stub([
            { id: '1:2', name: 'Frame', type: 'FRAME' },
          ]),
        ),
    ],
    [
      'search',
      () =>
        handleSearch(
          {},
          stub({
            docName: 'Doc',
            results: [
              { id: '1:2', name: 'Frame', type: 'FRAME' },
            ],
          }),
        ),
    ],
    [
      'get_styles',
      () =>
        handleGetStyles(
          {},
          stub({
            styles: [
              {
                id: 'S:1',
                name: 'Brand/Primary',
                type: 'PAINT',
              },
            ],
          }),
        ),
    ],
    [
      'get_variables',
      () =>
        handleGetVariables(
          {},
          stub({
            collections: [
              { id: 'C:1', name: 'Tokens', modes: [] },
            ],
          }),
        ),
    ],
    [
      'get_components',
      () =>
        handleGetComponents(
          {},
          stub({ local: [], remote: [] }),
        ),
    ],
    [
      'list_fonts',
      () => handleListFonts({}, stub({ results: [] })),
    ],
    [
      'get_plugin_data',
      () =>
        handleGetPluginData(
          { nodeId: '1:2' },
          stub({ id: '1:2', data: {} }),
        ),
    ],
    [
      'get_reactions',
      () =>
        handleGetReactions(
          { nodeId: '1:2' },
          stub({ id: '1:2', reactions: [] }),
        ),
    ],
    [
      'get_annotations',
      () =>
        handleGetAnnotations(
          { nodeId: '1:2' },
          stub({ id: '1:2', annotations: [] }),
        ),
    ],
  ]

  // The two non-facade meta-reads take an IndexManager rather than answering
  // straight from the plugin reply, so they are stubbed at that seam.
  const manager = {
    search: async () => ({
      results: [
        { id: '1:2', name: 'Button', type: 'COMPONENT' },
      ],
      indexState: 'warm',
      truncated: false,
    }),
    reindex: async () => ({
      indexed: 1,
      fileKey: 'fk-test',
    }),
  } as unknown as IndexManager

  cases.push(
    [
      'search_components',
      () =>
        handleSearchComponents(
          { query: 'button' },
          stub(null),
          manager,
        ),
    ],
    [
      'reindex',
      () => handleReindex({}, stub(null), manager),
    ],
  )

  it('covers every non-inspect read (liveness)', () => {
    expect(cases.length).toBe(14)
  })

  for (const [name, run] of cases) {
    it(`${name} emits JSON`, async () => {
      const text = textOf(await run())
      expect(text.length).toBeGreaterThan(0)
      expect(isJson(text)).toBe(true)
    })
  }
})
