import { describe, expect, it } from 'bun:test'
import {
  formatReconciliation,
  parseJsonl,
  reconcile,
  selectRun,
} from '../scripts/poc-actor-verify'
import type { ActorRecord } from '../scripts/poc-user-actor'

// docs/scratch/plans/2026-07-26-change-feed.md, Task 1e.
//
// osascript key-driving is NOT self-verifying. Figma can be frontmost — so the
// actor's own guard passes — while the keys land in the plugin's iframe or a
// panel field and the document never changes. The actor then reports a clean
// 20-of-20 run that produced nothing, and case 10 ("the POC pending count is
// exactly 20") reads as a filter defect instead of a harness defect.
//
// This reconciler is the fix: it joins the actor's timestamped log to the
// collector's feed-poc.jsonl and reports, per action, whether ANY document
// change arrived in that action's window. An action with none is `silent`, and
// a run with any silent action is not `ok`. That converts the failure mode from
// "quietly wrong number" to "loud red".

const action = (
  seq: number,
  tStart: number,
  over: Partial<
    Extract<ActorRecord, { kind: 'action' }>
  > = {},
): ActorRecord => ({
  kind: 'action',
  run: 'r1',
  seq,
  mode: 'nudge',
  label: 'case-10',
  detail: 'key right',
  tTarget: tStart,
  tStart,
  tEnd: tStart + 20,
  lateMs: 0,
  ok: true,
  ...over,
})

const runRec = (
  over: Partial<Extract<ActorRecord, { kind: 'run' }>> = {},
): ActorRecord => ({
  kind: 'run',
  run: 'r1',
  mode: 'nudge',
  count: 2,
  cadenceMs: 150,
  armMs: 800,
  label: 'case-10',
  dryRun: false,
  tArmed: 900,
  tFirst: 1_000,
  ...over,
})

const endRec = (
  over: Partial<Extract<ActorRecord, { kind: 'end' }>> = {},
): ActorRecord => ({
  kind: 'end',
  run: 'r1',
  sent: 2,
  aborted: false,
  tEnd: 5_000,
  ...over,
})

const feed = (
  tEvent: number,
  id: string | null,
  verdict: string,
) => ({
  tEvent,
  id,
  verdict,
  raw: 'PROPERTY_CHANGE',
  props: ['x'],
})

describe('parseJsonl', () => {
  it('reads one object per line and skips blanks', () => {
    const r = parseJsonl<{ a: number }>(
      '{"a":1}\n\n{"a":2}\n',
    )
    expect(r.rows).toEqual([{ a: 1 }, { a: 2 }])
    expect(r.bad).toBe(0)
  })

  it('COUNTS a corrupt line instead of dying on it', () => {
    // A torn append must not take the whole battery's analysis with it — but
    // it must also not pass unnoticed, because rows are missing.
    const r = parseJsonl<unknown>(
      '{"a":1}\n{"a":\n{"a":3}\n',
    )
    expect(r.rows.length).toBe(2)
    expect(r.bad).toBe(1)
  })
})

describe('selectRun', () => {
  it('defaults to the LAST run in the log', () => {
    const recs: ActorRecord[] = [
      runRec({ run: 'old' }),
      action(1, 1_000, { run: 'old' }),
      endRec({ run: 'old' }),
      runRec({ run: 'new' }),
      action(1, 9_000, { run: 'new' }),
    ]
    expect(selectRun(recs).map(r => r.run)).toEqual([
      'new',
      'new',
    ])
  })

  it('takes a named run', () => {
    const recs: ActorRecord[] = [
      runRec({ run: 'old' }),
      action(1, 1_000, { run: 'old' }),
      runRec({ run: 'new' }),
    ]
    expect(selectRun(recs, 'old').length).toBe(2)
  })

  it('throws on a run id that is not in the log', () => {
    expect(() => selectRun([runRec()], 'nope')).toThrow(
      /nope/,
    )
  })
})

describe('reconcile', () => {
  const opts = { graceMs: 100 }

  it('attributes a change that arrives inside an action window', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [feed(1_050, 'n1', 'kept')],
      opts,
    )
    expect(r.actions[0]?.rows).toBe(1)
    expect(r.actions[0]?.silent).toBe(false)
    expect(r.keptIds).toEqual(['n1'])
    expect(r.ok).toBe(true)
  })

  it('flags an action that produced NOTHING as silent, and fails the run', () => {
    // The whole point: this is what a keystroke swallowed by the plugin iframe
    // looks like from the outside.
    const r = reconcile(
      [
        runRec(),
        action(1, 1_000),
        action(2, 1_150),
        endRec(),
      ],
      [feed(1_050, 'n1', 'kept')],
      opts,
    )
    expect(r.silent).toBe(1)
    expect(r.actions[1]?.silent).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('ignores changes outside every window and counts them unattributed', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [
        feed(1_050, 'n1', 'kept'),
        feed(4_000, 'n9', 'kept'),
      ],
      opts,
    )
    expect(r.actions[0]?.rows).toBe(1)
    expect(r.unattributed).toBe(1)
    // Only attributed rows are the actor's; n9 is somebody else's write.
    expect(r.keptIds).toEqual(['n1'])
  })

  it('tallies the verdicts, so a FALSE DROP of a user edit is visible', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [
        feed(1_010, 'n1', 'dropped-touched'),
        feed(1_020, 'n1', 'kept'),
        feed(1_030, 'n2', 'dropped-cascade'),
      ],
      opts,
    )
    expect(r.actions[0]?.verdicts).toEqual({
      'dropped-touched': 1,
      kept: 1,
      'dropped-cascade': 1,
    })
    expect(r.droppedUserEdits).toBe(2)
  })

  it('gives an overlapping row to the EARLIEST window and reports ambiguity', () => {
    // At a 150ms cadence with a grace above the batch period the windows
    // overlap. Silently picking one would be fake precision; the count is
    // reported so the operator can widen the cadence if it matters.
    const r = reconcile(
      [
        runRec(),
        action(1, 1_000),
        action(2, 1_030),
        endRec(),
      ],
      [feed(1_060, 'n1', 'kept')],
      { graceMs: 500 },
    )
    expect(r.actions[0]?.rows).toBe(1)
    expect(r.actions[1]?.rows).toBe(0)
    expect(r.ambiguous).toBe(1)
  })

  it('fails a run the actor itself aborted', () => {
    const r = reconcile(
      [
        runRec(),
        action(1, 1_000),
        endRec({ sent: 1, aborted: true }),
      ],
      [feed(1_050, 'n1', 'kept')],
      opts,
    )
    expect(r.aborted).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('fails a log with no actions at all rather than reporting a clean pass', () => {
    const r = reconcile([runRec()], [], opts)
    expect(r.ok).toBe(false)
  })

  it('dedupes kept ids across actions — the POC pending count is DISTINCT ids', () => {
    const r = reconcile(
      [
        runRec(),
        action(1, 1_000),
        action(2, 2_000),
        endRec(),
      ],
      [
        feed(1_010, 'n1', 'kept'),
        feed(2_010, 'n1', 'kept'),
      ],
      opts,
    )
    expect(r.keptIds).toEqual(['n1'])
  })
})

describe('formatReconciliation', () => {
  it('leads with the verdict and names the silent actions', () => {
    const r = reconcile(
      [
        runRec(),
        action(1, 1_000),
        action(2, 1_150),
        endRec(),
      ],
      [feed(1_050, 'n1', 'kept')],
      { graceMs: 100 },
    )
    const text = formatReconciliation(r)
    expect(text).toContain('UNRELIABLE')
    expect(text).toContain('silent')
    expect(text).toContain('#2')
  })

  it('says OK when every action landed', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [feed(1_050, 'n1', 'kept')],
      { graceMs: 100 },
    )
    expect(formatReconciliation(r)).toContain('OK')
  })
})

describe('reconcile with the agent writing concurrently', () => {
  const opts = { graceMs: 100 }
  const claim = (tEvent: number, id: string) => ({
    tEvent,
    id,
    raw: 'CLAIM',
    site: 'createSingleNode',
  })
  const contextSelect = (tEvent: number) => ({
    tEvent,
    id: null,
    raw: 'CONTEXT_SELECT',
    verdict: 'dropped-context',
  })

  it('does NOT let an agent CLAIM row clear `silent`', () => {
    // Measurement B runs the actor CONCURRENTLY with agent commands. If any
    // row at all cleared `silent`, no action would ever be silent in that
    // mode and the reconciler would report `ok` for a run in which the actor
    // typed into a panel field and produced nothing — precisely the
    // misdiagnosis this file exists to prevent, in the one mode where the
    // agent is also writing.
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [claim(1_010, 'agent-1')],
      opts,
    )
    expect(r.silent).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('does NOT let a CONTEXT_* row clear `silent`', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [contextSelect(1_010)],
      opts,
    )
    expect(r.silent).toBe(1)
  })

  it('reports the strict count separately from the loose one', () => {
    // A real user mutation the filter DROPPED clears the loose guarantee but
    // not the strict one, and the operator must be able to see which of the
    // two they have.
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [feed(1_010, 'n1', 'dropped-cascade')],
      opts,
    )
    expect(r.silent).toBe(0)
    expect(r.silentStrict).toBe(1)
    expect(r.actions[0].mutations).toBe(1)
    expect(r.actions[0].keptRows).toBe(0)
  })

  it('counts only MUTATION rows as filtered user edits', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [
        feed(1_005, 'n1', 'kept'),
        contextSelect(1_010),
        claim(1_015, 'agent-1'),
      ],
      opts,
    )
    expect(r.droppedUserEdits).toBe(0)
    expect(r.silentStrict).toBe(0)
  })

  it('warns in the report when only the strict guarantee holds', () => {
    const r = reconcile(
      [runRec(), action(1, 1_000), endRec({ sent: 1 })],
      [
        feed(1_005, 'n1', 'kept'),
        // an agent write in the same window
        feed(1_006, 'agent-1', 'dropped-touched'),
      ],
      opts,
    )
    expect(r.unattributed).toBe(0)
    expect(formatReconciliation(r)).toContain('strict')
  })
})
