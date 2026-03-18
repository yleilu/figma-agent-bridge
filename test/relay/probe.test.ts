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
} from '../../packages/relay/src/relay'
import { probePort } from '../../packages/figma-plugin/src/hooks/useDiscovery'

describe('probePort', () => {
  let relayServer: Server<{ id: string }>

  beforeEach(() => {
    relayServer = startRelay(3090)
  })

  afterEach(() => {
    stopRelay(relayServer)
  })

  it('returns true for valid relay', async () => {
    const result = await probePort(3090)
    expect(result).toBe(true)
  })

  it('returns false for non-relay server', async () => {
    const server = Bun.serve({
      port: 3091,
      fetch: (req, srv) => {
        if (srv.upgrade(req)) {
          return undefined
        }
        return new Response('', { status: 426 })
      },
      websocket: {
        message: ws => {
          ws.send(
            JSON.stringify({
              type: 'pong',
              name: 'not-our-relay',
              version: '0.0.1',
            }),
          )
        },
      },
    })

    const result = await probePort(3091)
    expect(result).toBe(false)
    server.stop(true)
  })

  it('returns false for closed port', async () => {
    const result = await probePort(3092)
    expect(result).toBe(false)
  })
})
