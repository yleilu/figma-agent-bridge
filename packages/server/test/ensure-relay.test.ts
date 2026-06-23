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

  it('returns an error (no throw) when the relay process fails to spawn', async () => {
    const originalSpawn = Bun.spawn
    // Force the spawn path to throw so the try/catch returns { error }.
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
      () => {
        throw new Error('spawn EACCES')
      }

    try {
      const result = await ensureRelay(
        HTTP_URL,
        TEST_PORT,
        FAST,
      )
      expect(result.proc).toBeUndefined()
      expect(result.error).toBeDefined()
      expect(result.error).toContain('spawn EACCES')
    } finally {
      ;(
        Bun as unknown as { spawn: typeof Bun.spawn }
      ).spawn = originalSpawn
    }
  })

  it('kills the orphan and errors when the relay never becomes ready', async () => {
    // A foreign HTTP server holds the port and always answers non-OK,
    // so /channels never returns res.ok and readiness polling times out.
    const foreign = Bun.serve({
      port: TEST_PORT,
      fetch() {
        return new Response('nope', { status: 503 })
      },
    })

    try {
      const result = await ensureRelay(
        HTTP_URL,
        TEST_PORT,
        {
          pollIntervalMs: 30,
          maxPollAttempts: 4,
        },
      )

      expect(result.error).toBeDefined()
      expect(
        result.error?.includes('did not become ready') ||
          result.error?.includes('exited early'),
      ).toBe(true)

      // The spawned relay (which lost the port bind) must be reaped:
      // ensureRelay does not return a proc on the timeout path.
      expect(result.proc).toBeUndefined()
    } finally {
      foreign.stop(true)
    }
  })

  it('treats a foreign server answering non-OK on the port as "not running"', async () => {
    // res.ok === false on the first health check must NOT short-circuit;
    // ensureRelay proceeds to spawn (and then times out here because the
    // port is occupied), proving the early-return only fires on res.ok.
    const foreign = Bun.serve({
      port: TEST_PORT,
      fetch() {
        return new Response('forbidden', { status: 403 })
      },
    })

    try {
      const result = await ensureRelay(
        HTTP_URL,
        TEST_PORT,
        {
          pollIntervalMs: 30,
          maxPollAttempts: 4,
        },
      )

      // It did NOT early-return success (which would give {} with no error);
      // instead it tried to spawn and timed out.
      expect(result.error).toBeDefined()
    } finally {
      foreign.stop(true)
    }
  })
})
