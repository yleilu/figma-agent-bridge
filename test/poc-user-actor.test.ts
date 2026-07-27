import { describe, expect, it } from 'bun:test'
import {
  ACTOR_MODES,
  buildActionScript,
  buildActivateScript,
  describeSteps,
  firstActionAt,
  parseActorArgs,
  plannedStarts,
  renameTextFor,
  runActor,
  stepsFor,
  type ActorPlan,
  type ActorRecord,
} from '../scripts/poc-user-actor'

// docs/scratch/plans/2026-07-26-change-feed.md, Task 1e.
//
// The actor's ONE load-bearing property is that its edits reach Figma WITHOUT
// passing through handleCommand — otherwise every case that asks "does a real
// user edit survive the filter?" is vacuously true, because the edit was an
// agent write by construction. That property is a consequence of the
// mechanism (real keystrokes into the Figma UI) and cannot be unit tested; it
// is verified live.
//
// What CAN be pinned here, and is, is everything that makes the actor's output
// trustworthy:
//
//   1. Keys are only ever sent while Figma is verifiably frontmost. Without
//      that guard a `rename` run types its text — and a Return — into whatever
//      window has focus, which for an agent driving this is a terminal.
//   2. A refused action ABORTS the run. A run with a silent hole in it reads
//      as a complete run, and case 10 ("exactly 20 user edits") would then be
//      scored against an actor that sent 14.
//   3. Every action is timestamped with the instant it was actually sent, and
//      carries the lateness against its scheduled instant. Case 1 needs a user
//      edit at a KNOWN moment inside a long agent write; a nominal cadence
//      that quietly drifts cannot supply one.

const planOf = (
  over: Partial<ActorPlan> = {},
): ActorPlan => ({
  mode: 'nudge',
  count: 2,
  cadenceMs: 100,
  armMs: 0,
  startAt: null,
  label: 'test',
  out: '/tmp/does-not-matter.jsonl',
  runId: 'run1',
  dryRun: false,
  ...over,
})

describe('parseActorArgs', () => {
  it('defaults to a 20-edit nudge run', () => {
    const p = parseActorArgs([], { runId: 'r' })
    expect(p.mode).toBe('nudge')
    expect(p.count).toBe(20)
    expect(p.startAt).toBe(null)
  })

  it('takes the shell-style positional form: <mode> <count>', () => {
    const p = parseActorArgs(['rename', '5'], {
      runId: 'r',
    })
    expect(p.mode).toBe('rename')
    expect(p.count).toBe(5)
  })

  it('takes flags', () => {
    const p = parseActorArgs(
      [
        '--mode',
        'walk',
        '--count',
        '7',
        '--cadence-ms',
        '250',
        '--arm-ms',
        '900',
        '--label',
        'case-10',
        '--out',
        '/tmp/a.jsonl',
        '--dry-run',
      ],
      { runId: 'r' },
    )
    expect(p).toMatchObject({
      mode: 'walk',
      count: 7,
      cadenceMs: 250,
      armMs: 900,
      label: 'case-10',
      out: '/tmp/a.jsonl',
      dryRun: true,
    })
  })

  it('resolves --start-in against now, for scheduling case 1', () => {
    const p = parseActorArgs(['--start-in', '1500'], {
      now: 1_000_000,
      runId: 'r',
    })
    expect(p.startAt).toBe(1_001_500)
  })

  it('takes --start-at as an absolute epoch', () => {
    const p = parseActorArgs(['--start-at', '1700000'], {
      runId: 'r',
    })
    expect(p.startAt).toBe(1_700_000)
  })

  it('rejects a mode it cannot drive', () => {
    expect(() =>
      parseActorArgs(['--mode', 'draw'], { runId: 'r' }),
    ).toThrow(/mode/)
  })

  it('rejects a non-integer count rather than sending 0 keys', () => {
    expect(() =>
      parseActorArgs(['--count', 'lots'], { runId: 'r' }),
    ).toThrow(/count/)
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() =>
      parseActorArgs(['--settle-ms', '400'], {
        runId: 'r',
      }),
    ).toThrow(/--settle-ms/)
  })
})

describe('stepsFor', () => {
  it('nudge alternates in PAIRS, so consecutive presses always change x', () => {
    // A 20-nudge run that walked 20px right would drift the node across the
    // canvas and out of the viewport over a sweep, so the run must be
    // net-zero — but a strict right/left alternation is net-zero PER PAIR,
    // and if a right and the following left land in the same documentchange
    // batch Figma coalesces them into one `x` change or none at all. The
    // reconciler then scores one of the two actions `silent` and refuses the
    // whole run — a spurious UNRELIABLE exactly when the cadence is tuned
    // near the batch period, which is what Measurement B asks for.
    //
    // Period 4 (right, right, left, left) keeps every run whose length is a
    // multiple of 4 net-zero while guaranteeing consecutive presses land on
    // DISTINCT x values.
    const notes = Array.from({ length: 9 }, (_, i) =>
      stepsFor('nudge', i + 1).map(s =>
        s.kind === 'key' ? s.note : s.kind,
      ),
    ).flat()
    expect(notes).toEqual([
      'right',
      'right',
      'left',
      'left',
      'right',
      'right',
      'left',
      'left',
      'right',
    ])
  })

  it('rename opens F2, types a generated name, commits with Return', () => {
    expect(stepsFor('rename', 3)).toEqual([
      { kind: 'key', code: 120, note: 'F2' },
      { kind: 'delay', ms: 200 },
      { kind: 'type', text: 'poc-user-edit-3' },
      { kind: 'key', code: 36, note: 'return' },
    ])
  })

  it('walk nudges then Tabs to the next sibling', () => {
    expect(stepsFor('walk', 1)).toEqual([
      { kind: 'key', code: 124, note: 'right' },
      { kind: 'delay', ms: 120 },
      { kind: 'key', code: 48, note: 'tab' },
    ])
  })

  it('covers every declared mode', () => {
    for (const mode of ACTOR_MODES) {
      expect(stepsFor(mode, 1).length).toBeGreaterThan(0)
    }
  })
})

describe('renameTextFor', () => {
  it('is drawn from an alphabet that cannot escape a keystroke', () => {
    expect(renameTextFor(12)).toBe('poc-user-edit-12')
  })
})

describe('describeSteps', () => {
  it('renders a human-readable detail for the action log', () => {
    expect(describeSteps(stepsFor('rename', 3))).toBe(
      'key F2 + type "poc-user-edit-3" + key return',
    )
  })
})

describe('buildActivateScript', () => {
  it('forces Figma frontmost and reports whether it got there', () => {
    const s = buildActivateScript()
    expect(s).toContain(
      'tell application "Figma" to activate',
    )
    expect(s).toContain(
      'set frontmost of process "Figma" to true',
    )
    expect(s).toContain('"ABORT"')
    expect(s).toContain('"OK"')
  })
})

describe('buildActionScript', () => {
  it('GUARDS on frontmost before any key is sent', () => {
    const s = buildActionScript([
      { kind: 'key', code: 124, note: 'right' },
    ])
    const guard = s.indexOf('frontmost of process "Figma"')
    const key = s.indexOf('key code 124')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(key).toBeGreaterThan(guard)
    expect(s).toContain('return "ABORT"')
  })

  it('emits keystroke, key code and delay steps', () => {
    const s = buildActionScript(stepsFor('rename', 4))
    expect(s).toContain('key code 120')
    expect(s).toContain('delay 0.2')
    expect(s).toContain('keystroke "poc-user-edit-4"')
    expect(s).toContain('key code 36')
  })

  it('REFUSES text outside the keystroke-safe alphabet', () => {
    // The text ends up inside an AppleScript string literal that is then typed
    // into the frontmost window. Anything that can close the literal is an
    // injection, and a run that types it into a terminal presses Return after.
    expect(() =>
      buildActionScript([
        {
          kind: 'type',
          text: 'a" & (do shell script "x") & "',
        },
      ]),
    ).toThrow(/keystroke-safe/)
  })
})

describe('scheduling', () => {
  it('arms relative to readiness when no start instant is given', () => {
    expect(
      firstActionAt(planOf({ armMs: 800 }), 5_000),
    ).toBe(5_800)
  })

  it('honours a --start-at in the future (case 1: a known moment)', () => {
    expect(
      firstActionAt(
        planOf({ armMs: 800, startAt: 9_000 }),
        5_000,
      ),
    ).toBe(9_000)
  })

  it('never fires EARLIER than the arm window, even if --start-at is past', () => {
    expect(
      firstActionAt(
        planOf({ armMs: 800, startAt: 1_000 }),
        5_000,
      ),
    ).toBe(5_800)
  })

  it('schedules against the first instant, so cadence cannot drift', () => {
    expect(
      plannedStarts(
        planOf({ count: 4, cadenceMs: 250 }),
        1_000,
      ),
    ).toEqual([1_000, 1_250, 1_500, 1_750])
  })
})

// ── runActor ────────────────────────────────────────────────────────────────

type FakeOsa = {
  osa: (script: string) => Promise<string>
  scripts: string[]
}

const fakeOsa = (
  replies: (script: string) => string,
): FakeOsa => {
  const scripts: string[] = []
  return {
    scripts,
    osa: (script: string) => {
      scripts.push(script)
      return Promise.resolve(replies(script))
    },
  }
}

const harness = (
  plan: ActorPlan,
  replies: (script: string) => string,
) => {
  const { osa, scripts } = fakeOsa(replies)
  const written: string[] = []
  let clock = 10_000
  return {
    scripts,
    written,
    run: () =>
      runActor(plan, {
        osa,
        now: () => {
          clock += 1
          return clock
        },
        waitUntil: () => Promise.resolve(),
        write: (line: string) => {
          written.push(line)
        },
        log: () => undefined,
      }),
  }
}

const parsed = (written: string[]): ActorRecord[] =>
  written.map(line => JSON.parse(line) as ActorRecord)

describe('runActor', () => {
  it('logs a run record, one record per action, and an end record', async () => {
    const h = harness(planOf({ count: 3 }), () => 'OK')
    const result = await h.run()
    expect(result.sent).toBe(3)
    expect(result.aborted).toBe(false)

    const recs = parsed(h.written)
    expect(recs.map(r => r.kind)).toEqual([
      'run',
      'action',
      'action',
      'action',
      'end',
    ])
    expect(h.written.every(l => l.endsWith('\n'))).toBe(
      true,
    )
  })

  it('timestamps every action with when it was SENT, plus its lateness', async () => {
    const h = harness(planOf({ count: 2 }), () => 'OK')
    await h.run()
    const actions = parsed(h.written).filter(
      r => r.kind === 'action',
    )
    for (const a of actions) {
      if (a.kind !== 'action') {
        continue
      }
      expect(a.tEnd).toBeGreaterThan(a.tStart)
      expect(a.lateMs).toBe(a.tStart - a.tTarget)
      expect(a.run).toBe('run1')
      expect(a.label).toBe('test')
      expect(a.ok).toBe(true)
    }
    expect(
      actions.map(a =>
        a.kind === 'action' ? a.seq : null,
      ),
    ).toEqual([1, 2])
  })

  it('carries the resolved detail so a row can be attributed to a key', async () => {
    const h = harness(
      planOf({ mode: 'rename', count: 1 }),
      () => 'OK',
    )
    await h.run()
    const a = parsed(h.written)[1]
    expect(a?.kind).toBe('action')
    if (a?.kind === 'action') {
      expect(a.detail).toBe(
        'key F2 + type "poc-user-edit-1" + key return',
      )
    }
  })

  it('ABORTS the whole run the first time Figma is not frontmost', async () => {
    // Not "skip and carry on": a short run that looks complete is how an
    // unreliable actor silently weakens the case it is scoring.
    let n = 0
    const h = harness(planOf({ count: 5 }), script => {
      if (script.includes('activate')) {
        return 'OK'
      }
      n += 1
      return n === 3 ? 'ABORT' : 'OK'
    })
    const result = await h.run()
    expect(result.sent).toBe(2)
    expect(result.aborted).toBe(true)

    const recs = parsed(h.written)
    const actions = recs.filter(r => r.kind === 'action')
    expect(actions.length).toBe(3)
    const last = actions[2]
    if (last?.kind === 'action') {
      expect(last.ok).toBe(false)
      expect(last.error).toBe('ABORT')
    }
    const end = recs[recs.length - 1]
    if (end?.kind === 'end') {
      expect(end.aborted).toBe(true)
      expect(end.sent).toBe(2)
    }
  })

  it('sends NO keys at all when Figma never comes frontmost', async () => {
    const h = harness(planOf({ count: 4 }), () => 'ABORT')
    const result = await h.run()
    expect(result.sent).toBe(0)
    expect(result.aborted).toBe(true)
    // One osascript call — the activate probe. Nothing was typed anywhere.
    expect(h.scripts.length).toBe(1)
    const recs = parsed(h.written)
    expect(recs.some(r => r.kind === 'action')).toBe(false)
  })

  it('records an osascript throw as a failed action and stops', async () => {
    const h = harness(planOf({ count: 3 }), script => {
      if (script.includes('activate')) {
        return 'OK'
      }
      throw new Error('osascript: not authorised')
    })
    const result = await h.run()
    expect(result.sent).toBe(0)
    expect(result.aborted).toBe(true)
    const a = parsed(h.written)[1]
    if (a?.kind === 'action') {
      expect(a.ok).toBe(false)
      expect(a.error).toContain('not authorised')
    }
  })

  it('dry-run plans and logs without spawning osascript at all', async () => {
    const h = harness(
      planOf({ count: 3, dryRun: true }),
      () => {
        throw new Error('osascript must not run')
      },
    )
    const result = await h.run()
    expect(result.sent).toBe(3)
    expect(result.aborted).toBe(false)
    expect(h.scripts.length).toBe(0)
    const recs = parsed(h.written)
    expect(
      recs.filter(r => r.kind === 'action').length,
    ).toBe(3)
  })
})
