import { describe, expect, it } from 'bun:test'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { ensureRelay } from '@figma-agent-bridge/server/ensure-relay'

const TEST_PORT = 3100
const HTTP_URL = `http://localhost:${TEST_PORT}`

describe('ensureRelay', () => {
  it('returns started: false when relay is already running', async () => {
    const server = startRelay(TEST_PORT)

    try {
      const result = await ensureRelay(HTTP_URL, TEST_PORT)

      expect(result).toEqual({ started: false })
    } finally {
      stopRelay(server)
    }
  })

  it('spawns relay and returns started: true', async () => {
    const result = await ensureRelay(HTTP_URL, TEST_PORT)

    expect(result.started).toBe(true)
    expect(result.error).toBeUndefined()

    // Verify relay is actually reachable
    const res = await fetch(`${HTTP_URL}/channels`)
    expect(res.ok).toBe(true)
  })
})
