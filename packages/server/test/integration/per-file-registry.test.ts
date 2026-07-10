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
import {
  createFigmaClient,
  discoverChannels,
} from '@figma-agent-bridge/server/figma-client'
import { requireFile } from '@figma-agent-bridge/server/tools/shared'
import { handleDeleteNode } from '@figma-agent-bridge/server/tools/structure'
import { createMockPlugin } from '../mocks/mock-plugin'

const PORT = 3110
const WS_URL = `ws://localhost:${PORT}`
const HTTP_URL = `http://localhost:${PORT}`

describe('per-file channel registry (mock reports fileKey on register)', () => {
  let server: Server<{ id: string }>
  const plugins: ReturnType<typeof createMockPlugin>[] = []

  beforeEach(() => {
    server = startRelay(PORT)
  })

  afterEach(() => {
    for (const p of plugins) {
      p.stop()
    }
    plugins.length = 0
    stopRelay(server)
  })

  it('two saved files register distinct fileKeys discoverable via /channels', async () => {
    const a = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'file-a-ch',
      fileKey: 'key-A',
      documentName: 'File A',
    })
    const b = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'file-b-ch',
      fileKey: 'key-B',
      documentName: 'File B',
    })
    plugins.push(a, b)
    await a.start()
    await b.start()
    await Bun.sleep(30) // let both register frames reach the relay

    const channels = await discoverChannels(HTTP_URL)
    const infoA = channels.find(
      c => c.channel === 'file-a-ch',
    )
    const infoB = channels.find(
      c => c.channel === 'file-b-ch',
    )
    expect(infoA?.fileKey).toBe('key-A')
    expect(infoA?.fileName).toBe('File A')
    expect(infoB?.fileKey).toBe('key-B')
    expect(infoB?.fileName).toBe('File B')
  })

  it('a never-saved file registers fileKey:null (default, honest)', async () => {
    const p = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'unsaved-ch',
      documentName: 'Untitled',
    })
    plugins.push(p)
    await p.start()
    await Bun.sleep(30)

    const channels = await discoverChannels(HTTP_URL)
    const info = channels.find(
      c => c.channel === 'unsaved-ch',
    )
    expect(info?.fileKey).toBeNull()
    expect(info?.fileName).toBe('Untitled')
  })

  it('drives BOTH a saved file (by fileKey) and an unsaved file (by synthetic channel key) from one client', async () => {
    // A saved file addressed by its real figma.fileKey, plus a never-saved file
    // that registers fileKey:null and is addressed by its session channel (its
    // synthetic key). Both must be discoverable AND driveable from one client.
    const saved = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'saved-ch',
      fileKey: 'key-A',
      documentName: 'Saved File',
    })
    const unsaved = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'unsaved-sess', // synthetic fileKey == this channel
      documentName: 'Untitled',
    })
    plugins.push(saved, unsaved)
    await saved.start()
    await unsaved.start()
    await Bun.sleep(30) // let both register frames reach the relay

    const client = createFigmaClient(WS_URL)

    // The unsaved file is discoverable + auto-joined by its synthetic key.
    const gateUnsaved = await requireFile(
      client,
      'unsaved-sess',
    )
    expect(gateUnsaved.ok).toBe(true)
    expect(client.channelFor('unsaved-sess')).toBe(
      'unsaved-sess',
    )

    // The saved file is discoverable + auto-joined by its real fileKey.
    const gateSaved = await requireFile(client, 'key-A')
    expect(gateSaved.ok).toBe(true)
    expect(client.channelFor('key-A')).toBe('saved-ch')

    // Both files are joined on the single client (multi-file, B3).
    expect(client.joinedFiles().sort()).toEqual([
      'key-A',
      'unsaved-sess',
    ])

    // Drive a real handler against each via its scoped client.
    const delUnsaved = JSON.parse(
      (
        await handleDeleteNode(
          { nodeId: '10:1' },
          client.forFile('unsaved-sess'),
        )
      ).content[0].text,
    )
    expect(delUnsaved.id).toBe('10:1')

    const delSaved = JSON.parse(
      (
        await handleDeleteNode(
          { nodeId: '20:2' },
          client.forFile('key-A'),
        )
      ).content[0].text,
    )
    expect(delSaved.id).toBe('20:2')

    client.disconnect()
  })
})
