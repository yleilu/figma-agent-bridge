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
import {
  findRelayPort,
  probeRelay,
} from '../../packages/server/src/find-relay'

describe('probeRelay', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(3090)
  })

  afterEach(() => {
    stopRelay(server)
  })

  it('returns true for a running relay', async () => {
    expect(await probeRelay(3090)).toBe(true)
  })

  it('returns false for a non-relay server', async () => {
    const fake = Bun.serve({
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
              name: 'something-else',
            }),
          )
        },
      },
    })

    expect(await probeRelay(3091)).toBe(false)
    fake.stop(true)
  })

  it('returns false for a closed port', async () => {
    expect(await probeRelay(3092)).toBe(false)
  })
})

describe('findRelayPort', () => {
  let server: Server<{ id: string }>

  afterEach(() => {
    if (server) {
      stopRelay(server)
    }
  })

  it('finds a running relay', async () => {
    server = startRelay(3080)
    const port = await findRelayPort(3080, 3085)
    expect(port).toBe(3080)
  })

  it('throws when no relay found', async () => {
    await expect(findRelayPort(3093, 3094)).rejects.toThrow(
      'No relay found',
    )
  })
})
