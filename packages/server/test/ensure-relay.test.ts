import { afterEach, describe, expect, it } from 'bun:test'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { ensureRelay } from '@figma-agent-bridge/server/ensure-relay'

const TEST_PORT = 3100
const HTTP_URL = `http://localhost:${TEST_PORT}`

const FAST = { pollIntervalMs: 50, maxPollAttempts: 40 }

const killPort = async (port: number) => {
  try {
    const proc = Bun.spawn(['lsof', '-ti', `:${port}`], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const text = await new Response(proc.stdout).text()
    const pids = text.trim().split('\n').filter(Boolean)

    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // Already dead
      }
    }
  } catch {
    // Nothing listening
  }
}

describe('ensureRelay', () => {
  afterEach(async () => {
    await killPort(TEST_PORT)
    await Bun.sleep(200)
  })

  it('returns no error and no proc when relay is already running', async () => {
    const server = startRelay(TEST_PORT)

    try {
      const result = await ensureRelay(
        HTTP_URL,
        TEST_PORT,
        FAST,
      )

      expect(result.error).toBeUndefined()
      expect(result.proc).toBeUndefined()
    } finally {
      stopRelay(server)
    }
  })

  it('spawns relay and returns a live proc', async () => {
    const result = await ensureRelay(
      HTTP_URL,
      TEST_PORT,
      FAST,
    )

    expect(result.error).toBeUndefined()
    expect(result.proc).toBeDefined()

    const res = await fetch(`${HTTP_URL}/channels`)
    expect(res.ok).toBe(true)

    result.proc?.kill()
  })
})
