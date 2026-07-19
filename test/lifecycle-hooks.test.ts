import { test, expect } from 'bun:test'

const root = new URL('../', import.meta.url).pathname // test/ → repo root

type Captured = { path: string; body: unknown }

// A throwaway HTTP stub standing in for the relay: captures every request's
// pathname + parsed JSON body, then always answers 200 so the hook's `curl -f`
// never sees a failure.
const withStub = async (
  fn: (
    port: number,
    captured: () => Captured[],
  ) => Promise<void>,
) => {
  const captured: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.json().catch(() => null)
      captured.push({ path: url.pathname, body })
      return new Response('ok')
    },
  })
  try {
    await fn(server.port, () => captured)
  } finally {
    server.stop(true)
  }
}

const run = async (
  script: string,
  payload: unknown,
  port: number,
) => {
  const proc = Bun.spawn(
    ['bash', `${root}plugin/hooks/${script}`],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        FIGMA_BRIDGE_RELAY_PORT: String(port),
      },
    },
  )
  proc.stdin.write(JSON.stringify(payload))
  await proc.stdin.end()
  const code = await proc.exited
  return { code }
}

test('stop: POSTs /agent-status/settle with sessionId', async () => {
  await withStub(async (port, captured) => {
    const { code } = await run(
      'stop',
      { session_id: 's1', hook_event_name: 'Stop' },
      port,
    )
    expect(code).toBe(0)
    expect(captured()).toEqual([
      {
        path: '/agent-status/settle',
        body: { sessionId: 's1' },
      },
    ])
  })
})

test('subagent-stop: POSTs /agent-status/remove with sessionId + agentId', async () => {
  await withStub(async (port, captured) => {
    const { code } = await run(
      'subagent-stop',
      {
        session_id: 's1',
        agent_id: 'a1',
        hook_event_name: 'SubagentStop',
      },
      port,
    )
    expect(code).toBe(0)
    expect(captured()).toEqual([
      {
        path: '/agent-status/remove',
        body: { sessionId: 's1', agentId: 'a1' },
      },
    ])
  })
})

test('subagent-stop: omits agentId when the payload has none', async () => {
  await withStub(async (port, captured) => {
    const { code } = await run(
      'subagent-stop',
      { session_id: 's1', hook_event_name: 'SubagentStop' },
      port,
    )
    expect(code).toBe(0)
    expect(captured()).toEqual([
      {
        path: '/agent-status/remove',
        body: { sessionId: 's1' },
      },
    ])
  })
})

test('session-end: POSTs /agent-status/remove with sessionId', async () => {
  await withStub(async (port, captured) => {
    const { code } = await run(
      'session-end',
      { session_id: 's1', hook_event_name: 'SessionEnd' },
      port,
    )
    expect(code).toBe(0)
    expect(captured()).toEqual([
      {
        path: '/agent-status/remove',
        body: { sessionId: 's1' },
      },
    ])
  })
})

test('fail-open: empty/malformed stdin exits 0 and sends no request', async () => {
  for (const script of [
    'stop',
    'subagent-stop',
    'session-end',
  ]) {
    await withStub(async (port, captured) => {
      for (const raw of ['', 'not json{']) {
        const proc = Bun.spawn(
          ['bash', `${root}plugin/hooks/${script}`],
          {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...process.env,
              FIGMA_BRIDGE_RELAY_PORT: String(port),
            },
          },
        )
        proc.stdin.write(raw)
        await proc.stdin.end()
        const code = await proc.exited
        expect(code).toBe(0)
      }
      expect(captured()).toEqual([])
    })
  }
})

test('fail-open: relay unreachable (dead port) still exits 0', async () => {
  for (const script of [
    'stop',
    'subagent-stop',
    'session-end',
  ]) {
    const { code } = await run(
      script,
      { session_id: 's1', agent_id: 'a1' },
      1, // privileged/closed port → connection refused
    )
    expect(code).toBe(0)
  }
})
