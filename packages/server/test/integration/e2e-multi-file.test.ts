import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleDeleteNode } from '@figma-agent-bridge/server/tools/structure'
import { createMockPlugin } from '../mocks/mock-plugin'

// Unique port for this suite: the whole server test tree runs in one `bun test`
// process, so a port shared with another integration file would race under the
// full parallel run (two relays binding the same socket). 3140 is unused.
const PORT = 3140
const WS = `ws://localhost:${PORT}`

describe('two files from one client (per-call fileKey routing)', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  const plugins: ReturnType<typeof createMockPlugin>[] = []

  beforeEach(async () => {
    server = startRelay(PORT)
    client = createFigmaClient(WS)
    const a = createMockPlugin({
      relayUrl: WS,
      channel: 'file-a',
      documentName: 'Doc A',
      fileKey: 'fk-a',
    })
    const b = createMockPlugin({
      relayUrl: WS,
      channel: 'file-b',
      documentName: 'Doc B',
      fileKey: 'fk-b',
    })
    plugins.push(a, b)
    await a.start()
    await b.start()
    await client.joinChannel('file-a', 'fk-a')
    await client.joinChannel('file-b', 'fk-b')
  })

  afterEach(() => {
    plugins.forEach(p => p.stop())
    plugins.length = 0
    client.disconnect()
    stopRelay(server)
  })

  it('drives each file by its own fileKey and neither mis-routes', async () => {
    const ra = await handleDeleteNode(
      { nodeId: '1:42' },
      client.forFile('fk-a'),
    )
    const rb = await handleDeleteNode(
      { nodeId: '1:42' },
      client.forFile('fk-b'),
    )
    expect(JSON.parse(ra.content[0].text).id).toBe('1:42')
    expect(ra.content[0].text).not.toContain(
      'identity guard',
    )
    expect(JSON.parse(rb.content[0].text).id).toBe('1:42')
    expect(rb.content[0].text).not.toContain(
      'identity guard',
    )
  })

  it('a command stamped for the WRONG file is refused by the identity guard', async () => {
    // Simulate a STALE fileKey→channel mapping: bind fk-a to file-b's channel.
    // The delete for fk-a then sends on file-b's channel stamped meta.fileKey=fk-a,
    // but plugin B's own fileKey is fk-b → the identity guard refuses (B3
    // defense-in-depth: a stale registry entry can never mis-write file B).
    const stale = createFigmaClient(WS)
    await stale.joinChannel('file-b', 'fk-a')
    const res = await handleDeleteNode(
      { nodeId: '1:42' },
      stale.forFile('fk-a'),
    )
    expect(res.content[0].text).toContain('identity guard')
    stale.disconnect()
  })
})
