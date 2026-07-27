import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_PORT } from '@figma-agent-bridge/shared/constants'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import {
  POC_RELAY_OPTS,
  POC_RELAY_PORT,
  resolvePocPort,
} from '../scripts/poc-relay'

// docs/scratch/plans/2026-07-26-change-feed.md, Task 1a.
//
// The POC relay exists for exactly one reason: the shipped relay meters every
// inbound frame through a per-connection token bucket (RATE_TOKENS_PER_SEC=50,
// RATE_BURST=100) and DROPS what it cannot pay for, silently — see
// consumeToken() in packages/relay/src/relay.ts. Probe frames ride the same
// `message` frame type as command replies, on the same socket, so on a
// production-sized relay a probe burst corrupts the very timing the POC is
// measuring. These tests pin BOTH halves of that claim: the production sizing
// really does drop, and POC_RELAY_OPTS really does stop it dropping.

const BURST = 300
const DISARMED_PORT = 3141
const PRODUCTION_PORT = 3142
const CHANNEL = 'poc-bucket'

let server: ReturnType<typeof startRelay> | null = null

afterEach(() => {
  if (server !== null) {
    stopRelay(server)
    server = null
  }
})

const connect = (port: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.onopen = () => resolve(ws)
    ws.onerror = () =>
      reject(new Error(`connect failed on ${port}`))
  })

/** Join, and resolve on the relay's system ack (its first reply). */
const joinAndAck = (
  ws: WebSocket,
  channel: string,
): Promise<void> =>
  new Promise(resolve => {
    ws.onmessage = () => resolve()
    ws.send(JSON.stringify({ type: 'join', channel }))
  })

/** Wait until a counter stops moving (or the ceiling is hit). */
const settle = async (
  read: () => number,
): Promise<void> => {
  const step = 50
  let last = -1
  let stable = 0
  for (let waited = 0; waited < 4000; waited += step) {
    await Bun.sleep(step)
    const now = read()
    if (now === last) {
      stable += step
      if (stable >= 250) {
        return
      }
    } else {
      stable = 0
      last = now
    }
  }
}

/** Send BURST probe-shaped frames down one socket; count what lands. */
const burstThrough = async (
  port: number,
): Promise<number> => {
  const rx = await connect(port)
  const tx = await connect(port)
  await joinAndAck(rx, CHANNEL)
  await joinAndAck(tx, CHANNEL)

  let received = 0
  rx.onmessage = e => {
    const frame = JSON.parse(e.data as string) as {
      type?: string
    }
    if (frame.type === 'broadcast') {
      received += 1
    }
  }

  for (let i = 0; i < BURST; i += 1) {
    tx.send(
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          command: 'feed_probe',
          params: { rows: [{ i }] },
        },
      }),
    )
  }
  await settle(() => received)
  rx.close()
  tx.close()
  return received
}

describe('resolvePocPort', () => {
  it('defaults to the POC port', () => {
    expect(resolvePocPort(undefined)).toBe(POC_RELAY_PORT)
    expect(resolvePocPort('')).toBe(POC_RELAY_PORT)
  })

  it('accepts an explicit override', () => {
    expect(resolvePocPort('18999')).toBe(18999)
  })

  it('REFUSES the production port', () => {
    // The whole point of the POC relay is that it is not the shipped one.
    // Disarming the bucket on 18080 would change the behaviour every other
    // part of the system is measured against.
    expect(() =>
      resolvePocPort(String(DEFAULT_PORT)),
    ).toThrow()
  })

  it('rejects a non-port', () => {
    expect(() => resolvePocPort('nope')).toThrow()
    expect(() => resolvePocPort('0')).toThrow()
    expect(() => resolvePocPort('70000')).toThrow()
  })
})

describe('the token bucket the POC relay disarms', () => {
  it('DROPS a probe burst at production sizing', async () => {
    // Frozen bucket clock: no refill during the burst, so the arithmetic is
    // exact rather than a race. The socket opens with RATE_BURST=100 tokens,
    // its own `join` frame spends one, and each `message` spends one more —
    // so 99 of 300 survive and 201 vanish with no error anywhere.
    server = startRelay(PRODUCTION_PORT, {
      rateNow: () => 0,
    })
    expect(await burstThrough(PRODUCTION_PORT)).toBe(99)
  })

  it('delivers the whole burst under POC_RELAY_OPTS', async () => {
    server = startRelay(DISARMED_PORT, {
      ...POC_RELAY_OPTS,
      rateNow: () => 0,
    })
    expect(await burstThrough(DISARMED_PORT)).toBe(BURST)
  })
})
