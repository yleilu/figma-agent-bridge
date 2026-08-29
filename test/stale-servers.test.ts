import { describe, it, expect } from 'bun:test'
import {
  familyOf,
  parseElapsed,
  parsePs,
  report,
  staleServers,
} from '../scripts/stale-servers'

// The install guard (improvement batch A, item 9). `install:local` writes a
// fresh bundle and restarts nothing, so a server started before the write keeps
// serving the code it loaded — and the version handshake cannot see it, because
// every dev build stamps the same version. The build fingerprint (I62) closes
// the bundle half; a tree-runner honestly reports 'source' and is invisible to
// it, which is why this exists and why it lists BOTH families.

describe('parseElapsed', () => {
  it('reads every ps etime shape', () => {
    expect(parseElapsed('01:30')).toBe(90)
    expect(parseElapsed('02:00:00')).toBe(7200)
    expect(parseElapsed('3-04:00:00')).toBe(
      3 * 86400 + 4 * 3600,
    )
  })
  it('answers undefined for anything else', () => {
    expect(parseElapsed('TIME')).toBeUndefined()
    expect(parseElapsed('')).toBeUndefined()
  })
})

describe('familyOf', () => {
  it('recognises an installed BUNDLE server', () => {
    expect(
      familyOf(
        'bun /Users/x/.claude/plugins/cache/figma-agent-bridge/bin/server.js',
      ),
    ).toBe('bundle')
  })
  it('recognises a tree-runner, both spellings', () => {
    expect(
      familyOf(
        'bun run /Users/x/wip/figma-bridge/packages/server/src/index.ts',
      ),
    ).toBe('source')
    expect(
      familyOf(
        'bun --silent run --filter @figma-agent-bridge/server start',
      ),
    ).toBe('source')
  })
  it('leaves unrelated work alone — an over-matching guard gets skipped', () => {
    expect(familyOf('node server.js')).toBeUndefined()
    expect(
      familyOf('bun run packages/relay/src/index.ts'),
    ).toBeUndefined()
    expect(familyOf('vite build --watch')).toBeUndefined()
  })
})

describe('staleServers', () => {
  const now = 1_000_000_000_000
  const bundleWritten = now - 60_000 // the bundle is a minute old

  const rows = [
    // started 10 minutes ago — before the bundle: STALE
    {
      pid: 11,
      elapsedSeconds: 600,
      command: 'bun /x/bin/server.js',
    },
    // started 30 seconds ago — after the bundle: fresh
    {
      pid: 12,
      elapsedSeconds: 30,
      command: 'bun run packages/server/src/index.ts',
    },
    // old, but not a bridge server
    {
      pid: 13,
      elapsedSeconds: 9000,
      command: 'bun run packages/relay/src/index.ts',
    },
  ]

  it('names only the servers older than the bundle', () => {
    const stale = staleServers(rows, bundleWritten, now, 99)
    expect(stale.map(s => s.pid)).toEqual([11])
    expect(stale[0].family).toBe('bundle')
  })

  it('names BOTH families when both are stale', () => {
    const stale = staleServers(
      rows.map(r => ({ ...r, elapsedSeconds: 600 })),
      bundleWritten,
      now,
      99,
    )
    expect(stale.map(s => s.family)).toEqual([
      'bundle',
      'source',
    ])
  })

  it('never names itself', () => {
    expect(
      staleServers(rows, bundleWritten, now, 11),
    ).toHaveLength(0)
  })
})

describe('report', () => {
  it('says nothing when nothing is stale', () => {
    expect(report([])).toBe('')
  })

  it('carries the pid, the start time and a one-line remedy', () => {
    const text = report([
      {
        pid: 4242,
        elapsedSeconds: 600,
        command: 'bun /x/bin/server.js',
        family: 'bundle',
        startedAt: new Date(0),
      },
    ])
    expect(text).toContain('4242')
    expect(text).toContain('bin/server.js')
    expect(text).toContain('kill 4242')
    // …and it explains why the handshake will NOT catch this.
    expect(text).toContain('same version')
  })
})

describe('parsePs', () => {
  it('reads the ps output shape the guard asks for', () => {
    const rows = parsePs(
      [
        '  501     01:30 bun /x/bin/server.js',
        '  502  02:00:00 bun run packages/server/src/index.ts --port 1',
        'garbage line',
      ].join('\n'),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      pid: 501,
      elapsedSeconds: 90,
      command: 'bun /x/bin/server.js',
    })
    expect(rows[1].elapsedSeconds).toBe(7200)
  })
})
