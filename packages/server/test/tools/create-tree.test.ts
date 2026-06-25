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
} from '@figma-agent-bridge/server/tools/create-tree'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  connected?: boolean
  reply?: unknown
  sent?: Sent[]
}): FigmaClient => ({
  joinChannel: async () => 'ch',
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
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
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
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateTree(
      { tree: { type: 'FRAME' } },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

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
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Parent not found',
    )
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: FigmaClient = {
      joinChannel: async () => '',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
      disconnect: () => {},
      isConnected: () => true,
      currentChannel: () => 'ch',
    }
    const result = await handleCreateTree(
      { tree: { type: 'FRAME' } },
      client,
    )
    expect(result.content[0].text).toBe(
      'Error: plugin exploded',
    )
  })
})
