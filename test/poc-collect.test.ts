import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, readFile, rm } from 'node:fs/promises'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { POC_RELAY_OPTS } from '../scripts/poc-relay'
import {
  extractProbeFrame,
  extractProbeRows,
  startCollector,
  toJsonl,
  trackFlushSeq,
} from '../scripts/poc-collect'

// docs/scratch/plans/2026-07-26-change-feed.md, Task 1a.
//
// The collector's ONLY contract is the file it writes: Task 1f reads
// docs/scratch/poc/feed-poc.jsonl with `jq -s`, so every line must be one
// self-contained JSON object. These tests pin the frame → rows extraction, the
// line format (against real jq, with Task 1f's own queries), and the whole
// transport end to end over a real relay.

const E2E_PORT = 3143
const CHANNEL = 'poc-collect-e2e'

const tmpOut = () =>
  `/tmp/poc-collect-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.jsonl`

const broadcast = (rows: unknown[]) => ({
  type: 'broadcast',
  message: {
    command: 'feed_probe',
    params: { rows },
  },
})

describe('extractProbeRows', () => {
  it('takes the rows out of a feed_probe broadcast', () => {
    expect(
      extractProbeRows(broadcast([{ a: 1 }, { b: 2 }])),
    ).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('ignores a broadcast of any other command', () => {
    expect(
      extractProbeRows({
        type: 'broadcast',
        message: {
          command: 'get_node',
          params: { rows: [{ a: 1 }] },
        },
      }),
    ).toEqual([])
  })

  it('ignores non-broadcast frames', () => {
    expect(
      extractProbeRows({
        type: 'system',
        message: { id: 's', result: 'Connected' },
      }),
    ).toEqual([])
  })

  it('is total over junk', () => {
    expect(extractProbeRows(null)).toEqual([])
    expect(extractProbeRows(undefined)).toEqual([])
    expect(extractProbeRows('nope')).toEqual([])
    expect(extractProbeRows(broadcast([]))).toEqual([])
    expect(
      extractProbeRows({
        type: 'broadcast',
        message: { command: 'feed_probe', params: {} },
      }),
    ).toEqual([])
  })
})

describe('toJsonl', () => {
  it('writes one self-contained JSON object per line', () => {
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe(
      '{"a":1}\n{"b":2}\n',
    )
  })

  it('appends nothing for no rows', () => {
    expect(toJsonl([])).toBe('')
  })
})

describe("the file Task 1f's jq reads", () => {
  const rows = [
    {
      raw: 'PROPERTY_CHANGE',
      dt: 10,
      verdict: 'kept',
      id: 'n1',
    },
    {
      raw: 'PROPERTY_CHANGE',
      dt: 30,
      verdict: 'kept',
      id: 'n1',
    },
    {
      raw: 'PROPERTY_CHANGE',
      dt: 20,
      verdict: 'kept',
      id: 'n2',
    },
    {
      raw: 'PROPERTY_CHANGE',
      dt: 40,
      verdict: 'dropped-touched',
      id: 'n3',
    },
    { raw: 'CREATE', dt: 5, verdict: 'kept', id: 'n4' },
  ]
  let out = ''

  afterEach(async () => {
    if (out !== '') {
      await rm(out, { force: true })
      out = ''
    }
  })

  const jq = async (filter: string): Promise<string> => {
    const proc = Bun.spawn(['jq', '-s', filter, out], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(`jq failed: ${stderr}`)
    }
    return stdout.trim()
  }

  it('answers the POC pending count query', async () => {
    out = tmpOut()
    await Bun.write(out, toJsonl(rows))
    // Verbatim from the plan, Task 1f.
    expect(
      await jq(
        '[.[] | select(.verdict == "kept") | .id] | unique | length',
      ),
    ).toBe('3')
  })

  it('answers the Measurement A distribution query', async () => {
    out = tmpOut()
    await Bun.write(out, toJsonl(rows))
    const result = JSON.parse(
      await jq(`
  group_by(.raw) | map({
    shape: .[0].raw,
    n: length,
    p50: (sort_by(.dt) | .[(length*0.50|floor)].dt),
    p95: (sort_by(.dt) | .[(length*0.95|floor)].dt),
    p99: (sort_by(.dt) | .[(length*0.99|floor)].dt),
    max: (max_by(.dt).dt)
  })`),
    ) as { shape: string; n: number; max: number }[]
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      shape: 'CREATE',
      n: 1,
    })
    expect(result[1]).toMatchObject({
      shape: 'PROPERTY_CHANGE',
      n: 4,
      max: 40,
    })
  })

  it('stays readable when rows are appended in separate writes', async () => {
    out = tmpOut()
    await Bun.write(out, toJsonl(rows.slice(0, 2)))
    await appendFile(out, toJsonl(rows.slice(2)))
    expect(
      await jq(
        '[.[] | select(.verdict == "kept") | .id] | unique | length',
      ),
    ).toBe('3')
  })
})

describe('the collector end to end', () => {
  let server: ReturnType<typeof startRelay> | null = null
  let collector: Awaited<
    ReturnType<typeof startCollector>
  > | null = null
  let out = ''

  afterEach(async () => {
    if (collector !== null) {
      await collector.stop()
      collector = null
    }
    if (server !== null) {
      stopRelay(server)
      server = null
    }
    if (out !== '') {
      await rm(out, { force: true })
      out = ''
    }
  })

  const until = async (
    ok: () => boolean | Promise<boolean>,
    what: string,
  ): Promise<void> => {
    for (let waited = 0; waited < 5000; waited += 25) {
      if (await ok()) {
        return
      }
      await Bun.sleep(25)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('discovers the channel, joins it, and writes every probe row', async () => {
    out = tmpOut()
    server = startRelay(E2E_PORT, POC_RELAY_OPTS)

    // A stand-in for the plugin: joins the channel, then pushes probe rows.
    const plugin = await new Promise<WebSocket>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://localhost:${E2E_PORT}`,
        )
        ws.onopen = () => resolve(ws)
        ws.onerror = () => reject(new Error('no relay'))
      },
    )
    plugin.send(
      JSON.stringify({ type: 'join', channel: CHANNEL }),
    )

    collector = startCollector({
      relayUrl: `ws://localhost:${E2E_PORT}`,
      out,
      pollMs: 25,
      log: () => undefined,
    })

    await until(
      () =>
        collector?.channels().includes(CHANNEL) === true,
      'the collector to join the channel',
    )

    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          command: 'feed_probe',
          params: {
            flushSeq: 0,
            rowCount: 2,
            session: 'sess-e2e',
            channel: CHANNEL,
            rows: [
              { tEvent: 1, verdict: 'kept', id: 'n1' },
              {
                tEvent: 2,
                verdict: 'dropped-touched',
                id: 'n2',
              },
            ],
          },
        },
      }),
    )

    await until(
      () => collector?.rows() === 2,
      'two rows to arrive',
    )
    await collector.stop()
    const collectorLostFrames = collector.lostFrames()
    collector = null
    plugin.close()

    const lines = (await readFile(out, 'utf8'))
      .split('\n')
      .filter(l => l !== '')
    expect(lines).toHaveLength(2)
    // Every row carries the channel and sandbox session that produced it, so
    // two plugins interleaving into one file stay partitionable.
    expect(lines.map(l => JSON.parse(l))).toEqual([
      {
        tEvent: 1,
        verdict: 'kept',
        id: 'n1',
        ch: CHANNEL,
        session: 'sess-e2e',
      },
      {
        tEvent: 2,
        verdict: 'dropped-touched',
        id: 'n2',
        ch: CHANNEL,
        session: 'sess-e2e',
      },
    ])
    expect(collectorLostFrames).toBe(0)
  })

  it('writes a GAP row when frames are lost between the sandbox and the file', async () => {
    out = tmpOut()
    server = startRelay(E2E_PORT, POC_RELAY_OPTS)

    const plugin = await new Promise<WebSocket>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://localhost:${E2E_PORT}`,
        )
        ws.onopen = () => resolve(ws)
        ws.onerror = () => reject(new Error('no relay'))
      },
    )
    plugin.send(
      JSON.stringify({ type: 'join', channel: CHANNEL }),
    )

    collector = startCollector({
      relayUrl: `ws://localhost:${E2E_PORT}`,
      out,
      pollMs: 25,
      log: () => undefined,
    })
    await until(
      () =>
        collector?.channels().includes(CHANNEL) === true,
      'the collector to join the channel',
    )

    const frame = (flushSeq: number, id: string) =>
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          command: 'feed_probe',
          params: {
            flushSeq,
            rowCount: 1,
            session: 'sess-gap',
            channel: CHANNEL,
            rows: [{ tEvent: flushSeq, id }],
          },
        },
      })
    plugin.send(frame(0, 'n1'))
    // flushSeq 1 and 2 never arrive — the 4 MiB cap, the production token
    // bucket, or a reload dropped them.
    plugin.send(frame(3, 'n2'))

    await until(
      () => collector?.rows() === 2,
      'both surviving frames to arrive',
    )
    await collector.stop()
    const lost = collector.lostFrames()
    collector = null
    plugin.close()

    const rows = (await readFile(out, 'utf8'))
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lost).toBe(2)
    expect(rows.find(r => r.raw === 'GAP')).toMatchObject({
      raw: 'GAP',
      fromSeq: 0,
      toSeq: 3,
      lostFrames: 2,
      ch: CHANNEL,
      session: 'sess-gap',
    })
  })

  it('does not write anything for non-probe traffic', async () => {
    out = tmpOut()
    server = startRelay(E2E_PORT, POC_RELAY_OPTS)

    const plugin = await new Promise<WebSocket>(
      (resolve, reject) => {
        const ws = new WebSocket(
          `ws://localhost:${E2E_PORT}`,
        )
        ws.onopen = () => resolve(ws)
        ws.onerror = () => reject(new Error('no relay'))
      },
    )
    plugin.send(
      JSON.stringify({ type: 'join', channel: CHANNEL }),
    )

    collector = startCollector({
      relayUrl: `ws://localhost:${E2E_PORT}`,
      out,
      pollMs: 25,
      log: () => undefined,
    })
    await until(
      () =>
        collector?.channels().includes(CHANNEL) === true,
      'the collector to join the channel',
    )

    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          command: 'get_node',
          params: { nodeId: '1:2' },
        },
      }),
    )
    await Bun.sleep(200)
    expect(collector.rows()).toBe(0)
    plugin.close()
  })
})

describe('extractProbeFrame', () => {
  it('carries the frame-level provenance alongside the rows', () => {
    expect(
      extractProbeFrame({
        type: 'broadcast',
        message: {
          command: 'feed_probe',
          params: {
            flushSeq: 7,
            rowCount: 2,
            session: 'sess-1',
            channel: 'ch-a',
            rows: [{ a: 1 }, { b: 2 }],
          },
        },
      }),
    ).toEqual({
      rows: [{ a: 1 }, { b: 2 }],
      flushSeq: 7,
      rowCount: 2,
      session: 'sess-1',
      channel: 'ch-a',
    })
  })

  it('is total over a frame that predates the provenance fields', () => {
    expect(
      extractProbeFrame(broadcast([{ a: 1 }])),
    ).toEqual({
      rows: [{ a: 1 }],
      flushSeq: null,
      rowCount: null,
      session: null,
      channel: null,
    })
  })
})

describe('trackFlushSeq', () => {
  it('reports no gap on a contiguous run', () => {
    const state = new Map<string, number>()
    expect(trackFlushSeq(state, 's', 0).gap).toBe(null)
    expect(trackFlushSeq(state, 's', 1).gap).toBe(null)
    expect(trackFlushSeq(state, 's', 2).gap).toBe(null)
  })

  it('reports the first frame it sees as a start, never as a gap', () => {
    // A collector started after the plugin legitimately sees seq 57 first.
    const r = trackFlushSeq(new Map(), 's', 57)
    expect(r.gap).toBe(null)
    expect(r.started).toBe(57)
  })

  it('reports lost frames when the sequence jumps', () => {
    const state = new Map<string, number>()
    trackFlushSeq(state, 's', 4)
    expect(trackFlushSeq(state, 's', 9).gap).toEqual({
      fromSeq: 4,
      toSeq: 9,
      lostFrames: 4,
    })
    // and it resynchronises rather than reporting the same gap forever
    expect(trackFlushSeq(state, 's', 10).gap).toBe(null)
  })

  it('keeps sessions independent', () => {
    const state = new Map<string, number>()
    trackFlushSeq(state, 'a', 5)
    expect(trackFlushSeq(state, 'b', 0).gap).toBe(null)
    expect(trackFlushSeq(state, 'a', 6).gap).toBe(null)
  })

  it('treats a backwards seq as a restart, not a gap', () => {
    const state = new Map<string, number>()
    trackFlushSeq(state, 's', 9)
    const r = trackFlushSeq(state, 's', 0)
    expect(r.gap).toBe(null)
    expect(r.restarted).toBe(true)
    expect(trackFlushSeq(state, 's', 1).gap).toBe(null)
  })

  it('says nothing about a frame with no flushSeq', () => {
    const state = new Map<string, number>()
    expect(trackFlushSeq(state, 's', null).gap).toBe(null)
    expect(state.size).toBe(0)
  })
})
