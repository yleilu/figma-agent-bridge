import { afterEach, describe, expect, it } from 'bun:test'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { ensureRelay } from '@figma-agent-bridge/server/ensure-relay'

const TEST_PORT = 3100
const HTTP_URL = `http://localhost:${TEST_PORT}`

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
    // Give OS time to release the port
    await Bun.sleep(200)
  })

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

    // Clean up the spawned process
    if (result.proc) {
      result.proc.kill()
    }
  })
})
