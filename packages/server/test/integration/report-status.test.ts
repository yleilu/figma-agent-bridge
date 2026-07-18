// report-status.test.ts — end-to-end: report_status pushes a file-scoped
// agent-status frame over the real relay, and only to the addressed file's
// channel (status-monitor.md). Mirrors figma-client.test.ts's notifyStatus
// raw-peer pattern, but drives it through the actual tool handler.

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
import { handleReportStatus } from '@figma-agent-bridge/server/tools/report-status'

const PORT = 3141
const WS_URL = `ws://localhost:${PORT}`

const connectRaw = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      resolve(ws)
    }
    ws.onerror = () => {
      reject(new Error('WebSocket connection failed'))
    }
  })

const createMessageQueue = (ws: WebSocket) => {
  const queue: unknown[] = []
  let waiter: ((value: unknown) => void) | null = null

  ws.onmessage = event => {
    const parsed = JSON.parse(event.data as string)
    if (waiter !== null) {
      const resolve = waiter
      waiter = null
      resolve(parsed)
    } else {
      queue.push(parsed)
    }
  }

  return (): Promise<unknown> =>
    new Promise(resolve => {
      const first = queue.shift()
      if (first !== undefined) {
        resolve(first)
      } else {
        waiter = resolve
      }
    })
}

const closeWs = (ws: WebSocket): Promise<void> =>
  new Promise(resolve => {
    ws.onclose = () => {
      resolve()
    }
    ws.close()
  })

describe('report_status → relay (file-scoped broadcast)', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient

  beforeEach(async () => {
    server = startRelay(PORT)
    client = createFigmaClient(WS_URL)
    await client.joinChannel('file-a', 'fk-a')
    await client.joinChannel('file-b', 'fk-b')
  })

  afterEach(() => {
    client.disconnect()
    stopRelay(server)
  })

  it('broadcasts only to file-a, carrying the reported text and identity', async () => {
    const peerA = await connectRaw()
    const qa = createMessageQueue(peerA)
    peerA.send(
      JSON.stringify({ type: 'join', channel: 'file-a' }),
    )
    await qa() // join ack

    const peerB = await connectRaw()
    const qb = createMessageQueue(peerB)
    peerB.send(
      JSON.stringify({ type: 'join', channel: 'file-b' }),
    )
    await qb() // join ack
    let peerBExtra = 0
    peerB.onmessage = () => {
      peerBExtra++
    }

    await handleReportStatus(
      { text: 'Building nav', label: 'nav' },
      client.forFile('fk-a', {
        sessionId: 's',
        agentId: 'a',
        agentType: 'Explore',
      }),
    )

    const got = await qa()
    expect(got).toMatchObject({
      type: 'agent-status',
      record: {
        key: 'a',
        sessionId: 's',
        agentId: 'a',
        agentType: 'Explore',
        label: 'nav',
        level: 'normal',
        text: 'Building nav',
        activity: 'busy',
      },
    })

    // peerB (a different file's channel) must NOT receive it.
    await Bun.sleep(50)
    expect(peerBExtra).toBe(0)

    await closeWs(peerA)
    await closeWs(peerB)
  })
})
