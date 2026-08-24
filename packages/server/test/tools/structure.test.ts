// structure.test.ts — handleDeleteNode / handleSetFocus.
//
// Both are mutation handlers routed through formatMutationResult: a null reply
// → failure text, a {error} reply → an error, otherwise JSON.stringify. Asserts
// on REAL handler output. Handlers now take a ScopedFigmaClient (the withFile
// wrapper gates + scopes); the not-connected guard is gone (the wrapper owns it).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import { COMMANDS } from '@figma-agent-bridge/shared'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import {
  createFigmaClient,
  type FigmaClient,
  type ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import {
  handleDeleteNode,
  handleSetFocus,
  handleReparentNode,
} from '@figma-agent-bridge/server/tools/structure'
import { withFile } from '@figma-agent-bridge/server/tools/with-file'
import { createMockPlugin } from '../mocks/mock-plugin'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubScoped = (opts: {
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

describe('handleDeleteNode', () => {
  it('forwards COMMANDS.DELETE_NODE with {nodeId}', async () => {
    const sent: Sent[] = []
    await handleDeleteNode(
      { nodeId: '1:42' },
      stubScoped({
        sent,
        reply: { id: '1:42', name: 'Card', type: 'FRAME' },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.DELETE_NODE)
    expect(sent[0].params).toEqual({ nodeId: '1:42' })
  })

  it('emits the deleted {id,name,type}', async () => {
    const result = await handleDeleteNode(
      { nodeId: '1:42' },
      stubScoped({
        reply: { id: '1:42', name: 'Card', type: 'FRAME' },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      name: string
      type: string
    }
    expect(out).toEqual({
      id: '1:42',
      name: 'Card',
      type: 'FRAME',
    })
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleDeleteNode(
      { nodeId: 'nope' },
      stubScoped({
        reply: { error: 'Node not found: nope' },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Node not found')
    expect(data.code).toBe('NODE_NOT_FOUND')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleDeleteNode(
      { nodeId: '1:1' },
      stubScoped({ reply: null }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Failed to delete node.',
      code: 'PLUGIN_ERROR',
    })
  })
})

describe('handleSetFocus', () => {
  it('forwards COMMANDS.SET_FOCUS with {nodeIds}', async () => {
    const sent: Sent[] = []
    await handleSetFocus(
      { nodeIds: ['1:1', '1:2'] },
      stubScoped({
        sent,
        reply: {
          viewport: { center: { x: 0, y: 0 }, zoom: 1 },
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_FOCUS)
    expect(sent[0].params).toEqual({
      nodeIds: ['1:1', '1:2'],
    })
  })

  it('emits the {viewport}', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:1'] },
      stubScoped({
        reply: {
          viewport: { center: { x: 5, y: 6 }, zoom: 2 },
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      viewport: {
        center: { x: number; y: number }
        zoom: number
      }
    }
    expect(out.viewport.zoom).toBe(2)
    expect(out.viewport.center).toEqual({ x: 5, y: 6 })
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleSetFocus(
      { nodeIds: ['1:1'] },
      stubScoped({ reply: null }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Failed to set focus.',
      code: 'PLUGIN_ERROR',
    })
  })
})

describe('handleReparentNode', () => {
  it('a thrown transport failure envelopes DISCONNECTED', async () => {
    const client: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.reject(new Error('Not connected')),
    }
    const result = await handleReparentNode(
      { nodeId: '1:1', parentId: '1:2' },
      client,
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Not connected',
      code: 'DISCONNECTED',
    })
  })
})

// Representative end-to-end routing: a handler invoked through the withFile
// wrapper (or a real scoped client) reaches the plugin joined on the target
// file's channel, and a mismatched fileKey is refused by the wrapper's gate.
describe('delete_node routing through the scoped client', () => {
  const TEST_CHANNEL = 'structure-routing'
  const FK = 'fk-structure'
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    // Port 0 = OS-assigned ephemeral port — an unrelated
    // local listener can never collide with this block.
    server = startRelay(0)
    const relayUrl = `ws://localhost:${server.port}`
    client = createFigmaClient(relayUrl)
    plugin = createMockPlugin({
      relayUrl,
      channel: TEST_CHANNEL,
      fileKey: FK,
    })
    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    // Guarded: a beforeEach that threw must surface its own
    // error, not this teardown's TypeError.
    client?.disconnect()
    if (server) {
      stopRelay(server)
    }
  })

  it('routes to the joined file and returns the deleted node', async () => {
    const scoped = client.forFile(FK)
    const res = await handleDeleteNode(
      { nodeId: '1:42' },
      scoped,
    )
    expect(JSON.parse(res.content[0].text).id).toBe('1:42')
  })

  it('the wrapper refuses an unavailable fileKey (WRONG_FILE) and never calls the handler', async () => {
    const wrapped = withFile(client, handleDeleteNode)
    const res = await wrapped({
      fileKey: 'fk-nope',
      nodeId: '1:42',
    })
    expect(JSON.parse(res.content[0].text).code).toBe(
      'WRONG_FILE',
    )
  })
})

// PAGE branch of DELETE_NODE (M4 — delete_page guard).
// The mock routes page: prefix nodeIds to PAGE semantics; all assertions here
// drive the mock-backed contract — live Figma verification is deferred to the
// controller (create 2 pages, delete the current, confirm switch + remove;
// delete the sole remaining page, confirm clean {error}).
describe('delete_node PAGE branch (M4 guard)', () => {
  const TEST_PORT = 3118
  const RELAY_URL = `ws://localhost:${TEST_PORT}`
  const TEST_CHANNEL = 'page-delete'
  const FK = 'fk-page-delete'
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      fileKey: FK,
    })
    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('last-page: returns error text containing "last remaining page"', async () => {
    const scoped = client.forFile(FK)
    const res = await handleDeleteNode(
      { nodeId: 'page:only' },
      scoped,
    )
    // formatMutationResult surfaces a plugin {error} as the typed envelope.
    const data = JSON.parse(res.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('last remaining page')
    expect(data.code).toBe('PLUGIN_ERROR')
  })

  it('current-page: returns currentPageId in reply (switch occurred)', async () => {
    const scoped = client.forFile(FK)
    const res = await handleDeleteNode(
      { nodeId: 'page:current' },
      scoped,
    )
    const out = JSON.parse(res.content[0].text) as {
      id: string
      name: string
      type: string
      currentPageId: string
    }
    expect(out.id).toBe('page:current')
    expect(out.type).toBe('PAGE')
    // switched to the adjacent page (page:other in the mock)
    expect(out.currentPageId).toBe('page:other')
  })

  it('non-current page: removes and returns currentPageId (unchanged)', async () => {
    const scoped = client.forFile(FK)
    const res = await handleDeleteNode(
      { nodeId: 'page:noncurrent' },
      scoped,
    )
    const out = JSON.parse(res.content[0].text) as {
      id: string
      type: string
      currentPageId: string
    }
    expect(out.id).toBe('page:noncurrent')
    expect(out.type).toBe('PAGE')
    expect(out.currentPageId).toBe('page:current')
  })

  it('setCurrentPageAsync absent: degrade warns and skips remove (no error)', async () => {
    const scoped = client.forFile(FK)
    const res = await handleDeleteNode(
      { nodeId: 'page:noapi' },
      scoped,
    )
    // A degrade reply has no {error} key — formatMutationResult emits JSON, not "Error: …".
    expect(res.content[0].text).not.toContain('"error"')
    const out = JSON.parse(res.content[0].text) as {
      id: string
      type: string
      warnings: string[]
    }
    expect(out.id).toBe('page:noapi')
    expect(out.type).toBe('PAGE')
    expect(out.warnings[0]).toContain(
      'setCurrentPageAsync unavailable',
    )
  })
})
