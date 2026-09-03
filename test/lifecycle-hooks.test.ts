import { test, expect } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'

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

// ── SessionEnd's second responsibility: the Change Feed count sweep ──────────
// (claude-plugin.md §4 / change-feed.md, Lifecycle.)

// `exists` rather than node's existsSync: the repo's eslint forbids sync fs.
const exists = (path: string) => Bun.file(path).exists()

const endSession = async (opts: {
  changesDir: string
  sessionId?: string
}) => {
  const proc = Bun.spawn(
    ['bash', `${root}plugin/hooks/session-end`],
    {
      env: {
        ...process.env,
        FIGMA_BRIDGE_CHANGES_DIR: opts.changesDir,
        FIGMA_BRIDGE_RELAY_PORT: '1', // closed → the POST fails open
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  proc.stdin.write(
    JSON.stringify(
      opts.sessionId === undefined
        ? {}
        : { session_id: opts.sessionId },
    ),
  )
  await proc.stdin.end()
  return proc.exited
}

test('SessionEnd removes this session count files and leaves the sentinel', async () => {
  const dir = `/tmp/cf-end-${Date.now()}`
  await mkdir(`${dir}/fk-a`, { recursive: true })
  await writeFile(`${dir}/fk-a/sess-9.json`, '{}')
  await writeFile(`${dir}/fk-a/_unattributed.json`, '{}')
  expect(
    await endSession({
      changesDir: dir,
      sessionId: 'sess-9',
    }),
  ).toBe(0)
  expect(await exists(`${dir}/fk-a/sess-9.json`)).toBe(
    false,
  )
  // The sentinel belongs to NO session — no session ending can retire it.
  expect(
    await exists(`${dir}/fk-a/_unattributed.json`),
  ).toBe(true)
})

test('SessionEnd sweeps every file directory, and only this session', async () => {
  const dir = `/tmp/cf-end-multi-${Date.now()}`
  for (const key of ['fk-a', 'fk-b']) {
    await mkdir(`${dir}/${key}`, { recursive: true })
    await writeFile(`${dir}/${key}/sess-9.json`, '{}')
    await writeFile(`${dir}/${key}/sess-8.json`, '{}')
  }
  expect(
    await endSession({
      changesDir: dir,
      sessionId: 'sess-9',
    }),
  ).toBe(0)
  expect(await exists(`${dir}/fk-a/sess-9.json`)).toBe(
    false,
  )
  expect(await exists(`${dir}/fk-b/sess-9.json`)).toBe(
    false,
  )
  // Another session's mirror is another process's business.
  expect(await exists(`${dir}/fk-a/sess-8.json`)).toBe(true)
  expect(await exists(`${dir}/fk-b/sess-8.json`)).toBe(true)
})

test('SessionEnd sanitizes the stem the same way the writer does', async () => {
  // Driven by sanitizeKey itself, so the hook's sed twin is pinned to the
  // writer's rule rather than to a hand-copied expectation: a one-character
  // drift sweeps a path that does not exist and the counts live forever.
  const { sanitizeKey } =
    await import('@figma-agent-bridge/shared/paths')
  const ids = [
    'Yv8QhK2nRb0aC1dE3fG4hJ',
    'sess-9f2c8d7a_b1',
    '4b8e1f60-2c3a-4d5e-8f01-9ab2cd3ef456',
    'fk/a.b:c',
    '../secrets',
  ]
  for (const id of ids) {
    const dir = `/tmp/cf-end-sane-${Date.now()}-${ids.indexOf(id)}`
    const file = `${dir}/fk-a/${sanitizeKey(id)}.json`
    await mkdir(`${dir}/fk-a`, { recursive: true })
    await writeFile(file, '{}')
    expect(
      await endSession({ changesDir: dir, sessionId: id }),
    ).toBe(0)
    expect(await exists(file)).toBe(false)
  }
})

test('SessionEnd sweeps this session write residue, and only its own', async () => {
  // The count mirror writes `<stem>.json.<writer>.<n>.tmp` then renames
  // (count-mirror.ts, tmpFor). A kill between the two leaves the temp behind
  // and no other owner ever removes it: the server unlinks only its own
  // sentinels and no reader opens a .tmp.
  const dir = `/tmp/cf-end-tmp-${Date.now()}`
  await mkdir(`${dir}/fk-a`, { recursive: true })
  await writeFile(
    `${dir}/fk-a/sess-9.json.srv-abc.1.tmp`,
    '{}',
  )
  await writeFile(
    `${dir}/fk-a/sess-8.json.srv-abc.1.tmp`,
    '{}',
  )
  // Two predicates, not a widened glob — a neighbour whose name merely starts
  // with `<stem>.json` is not this session's residue.
  await writeFile(`${dir}/fk-a/sess-9.jsonx`, '{}')
  expect(
    await endSession({
      changesDir: dir,
      sessionId: 'sess-9',
    }),
  ).toBe(0)
  expect(
    await exists(`${dir}/fk-a/sess-9.json.srv-abc.1.tmp`),
  ).toBe(false)
  expect(
    await exists(`${dir}/fk-a/sess-8.json.srv-abc.1.tmp`),
  ).toBe(true)
  expect(await exists(`${dir}/fk-a/sess-9.jsonx`)).toBe(
    true,
  )
})

test('SessionEnd sweeps nothing when the payload carries no session_id', async () => {
  const dir = `/tmp/cf-end-nosid-${Date.now()}`
  await mkdir(`${dir}/fk-a`, { recursive: true })
  await writeFile(`${dir}/fk-a/sess-9.json`, '{}')
  expect(await endSession({ changesDir: dir })).toBe(0)
  expect(await exists(`${dir}/fk-a/sess-9.json`)).toBe(true)
})

test('SessionEnd exits 0 when the changes dir does not exist', async () => {
  expect(
    await endSession({
      changesDir: `/tmp/cf-end-absent-${Date.now()}`,
      sessionId: 'sess-9',
    }),
  ).toBe(0)
})
