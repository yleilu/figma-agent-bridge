// scripts/poc-actor-verify.ts — reconcile a scripted-user run against the feed
// (docs/scratch/plans/2026-07-26-change-feed.md, Task 1e). THROWAWAY: deleted
// with the rest of the probe harness in Task 7.
//
// WHY THIS EXISTS. `osascript` key-driving is not self-verifying. Figma can be
// frontmost — so poc-user-actor's own guard passes — while the keys land in the
// plugin's iframe, a panel field, or a text node in edit mode, and the document
// never changes. The actor then reports a clean 20-of-20 run that produced
// nothing at all.
//
// That failure is silent in the direction that matters. Case 10 asks for a POC
// pending count of exactly 20 after 20 user edits; an actor that sent 20 keys
// and produced 4 edits reports 4, which reads as the FILTER dropping user work
// — the worst possible misdiagnosis, since it argues for shrinking SETTLE_MS
// and reopening the fail-open hole the POC exists to close.
//
// So: join the actor's timestamped log to the collector's feed-poc.jsonl by
// time, and require that every action produced at least one document change.
// An action that produced none is `silent`, a run with any silent action is not
// `ok`, and the CLI exits non-zero. Never score a case against a run this
// refuses.
//
// TWO GUARANTEES, NOT ONE. `silent` counts only rows that are real document
// MUTATIONS — CLAIM, CONTEXT_*, PROBE_* and GAP rows are excluded, because the
// agent (or the probe itself) emits those and Measurement B runs the actor
// CONCURRENTLY with agent commands. Even so, `silent` is only a guarantee
// while the agent is idle: a genuine agent PROPERTY_CHANGE landing in an
// action's window still clears it. `silentStrict` is the agent-proof reading
// — no row in the window SURVIVED the filter — and both are reported so an
// operator can see which of the two they actually have.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ACTOR_OUT,
  type ActorRecord,
} from './poc-user-actor'

// `.pathname` on a file: URL is percent-encoded; a repo path with a space in
// it would resolve to a file that does not exist.
const REPO_ROOT = fileURLToPath(
  new URL('../', import.meta.url),
)

/** The collector's output — scripts/poc-collect.ts DEFAULT_OUT. */
export const DEFAULT_FEED = `${REPO_ROOT}docs/scratch/poc/feed-poc.jsonl`

/**
 * How long after an action's keystroke a change may still be attributed to it.
 * MUST exceed the measured `documentchange` batch period, which is the very
 * thing Measurement A reports — so this is a knob, not a constant, and the
 * default is deliberately generous.
 */
export const DEFAULT_GRACE_MS = 1000

/** The subset of a feed-poc.jsonl row this reconciler reads. */
export type FeedRow = {
  tEvent?: unknown
  id?: unknown
  verdict?: unknown
  raw?: unknown
}

export type ParsedJsonl<T> = { rows: T[]; bad: number }

/**
 * One JSON object per line. A torn append must not take the whole battery's
 * analysis with it, so a bad line is COUNTED rather than thrown — but it is
 * counted, because rows are then missing and the numbers are under-reports.
 */
export const parseJsonl = <T>(
  text: string,
): ParsedJsonl<T> => {
  const rows: T[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    try {
      rows.push(JSON.parse(trimmed) as T)
    } catch {
      bad += 1
    }
  }
  return { rows, bad }
}

/** The records of one run: the named one, or the last one in the log. */
export const selectRun = (
  records: readonly ActorRecord[],
  runId?: string,
): ActorRecord[] => {
  const id =
    runId ??
    [...records].reverse().find(r => r.kind === 'run')?.run
  if (id === undefined) {
    throw new Error(
      '[poc-actor-verify] the actor log contains no run record',
    )
  }
  const of = records.filter(r => r.run === id)
  if (of.length === 0) {
    throw new Error(
      `[poc-actor-verify] no records for run ${id}`,
    )
  }
  return of
}

/**
 * Row shapes the AGENT (or the probe itself) emits, which a user keystroke
 * never produces.
 *
 * `silent` exists to catch "the keys landed somewhere harmless and the
 * document never changed". That guarantee only holds while every row in the
 * window is attributable to the actor — and Measurement B is specified to run
 * the actor CONCURRENTLY with agent commands. In that mode the agent's own
 * CLAIM rows and its own `set_selection`'s CONTEXT_SELECT rows fall inside
 * every action window, so counting them would make no action ever silent and
 * the reconciler would report `ok` for a run that produced nothing.
 *
 * CONTEXT_* is excluded even though a human click also produces one: the
 * actor's own modes produce a real PROPERTY_CHANGE for every action, so
 * nothing is lost, and the agent can produce a CONTEXT_* at any moment.
 */
const NON_MUTATION_RAW = new Set([
  'CLAIM',
  'CONTEXT_PAGE',
  'CONTEXT_SELECT',
  'PROBE_ERROR',
  'PROBE_OVERFLOW',
  'PROBE_JUNK',
  'GAP',
])

/** A row that represents a real document mutation. */
export const isMutationRow = (row: FeedRow): boolean =>
  typeof row.raw === 'string' &&
  !NON_MUTATION_RAW.has(row.raw)

export type ActionAttribution = {
  seq: number
  detail: string
  tStart: number
  tEnd: number
  /** The last instant a change is still attributed to this action. */
  windowEnd: number
  rows: number
  /** Rows in this window that are real document mutations. */
  mutations: number
  /** Rows in this window that SURVIVED the filter. */
  keptRows: number
  /** Distinct ids of rows this action produced that SURVIVED the filter. */
  kept: string[]
  verdicts: Record<string, number>
  /** Rows in this window that another window also covers. */
  ambiguous: number
  /** No document MUTATION arrived — the keystroke did nothing. Holds only
   *  while the agent is idle; see `silentStrict`. */
  silent: boolean
  /** No row SURVIVED the filter for this action. The only guarantee that
   *  still means something while the agent is writing concurrently — but it
   *  also fires when the filter correctly-or-incorrectly dropped the user's
   *  edit, so it is reported, never used to fail the run on its own. */
  silentStrict: boolean
  ok: boolean
}

export type Reconciliation = {
  run: string
  mode: string
  label: string
  aborted: boolean
  sent: number
  graceMs: number
  actions: ActionAttribution[]
  /** Actions that produced no document mutation. Must be 0. */
  silent: number
  /** Actions none of whose rows survived the filter. Report this next to
   *  `silent` — with the agent writing concurrently it is the stricter (and
   *  the only agent-proof) reading of "the keystroke reached the feed". */
  silentStrict: number
  /** Distinct kept ids across the run — the actor's share of the POC
   *  pending count. */
  keptIds: string[]
  /** Attributed rows the filter dropped: candidate FALSE drops of user work,
   *  which is case 5's disclosed residual and case 1's failure mode. */
  droppedUserEdits: number
  /** Feed rows inside the run's span that no action window covers — the
   *  agent's own writes, mostly. */
  unattributed: number
  ambiguous: number
  badFeedLines: number
  badActorLines: number
  ok: boolean
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

export const reconcile = (
  records: readonly ActorRecord[],
  feedRows: readonly FeedRow[],
  opts: {
    graceMs?: number
    badFeedLines?: number
    badActorLines?: number
  } = {},
): Reconciliation => {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const run = records.find(r => r.kind === 'run')
  const end = [...records]
    .reverse()
    .find(r => r.kind === 'end')
  const actionRecs = records.filter(
    r => r.kind === 'action',
  )

  const windows = actionRecs.map(a => ({
    seq: a.seq,
    detail: a.detail,
    tStart: a.tStart,
    tEnd: a.tEnd,
    windowEnd: a.tEnd + graceMs,
    ok: a.ok,
  }))

  const attributions: ActionAttribution[] = windows.map(
    w => ({
      seq: w.seq,
      detail: w.detail,
      tStart: w.tStart,
      tEnd: w.tEnd,
      windowEnd: w.windowEnd,
      rows: 0,
      mutations: 0,
      keptRows: 0,
      kept: [],
      verdicts: {},
      ambiguous: 0,
      silent: true,
      silentStrict: true,
      ok: w.ok,
    }),
  )

  const keptIds = new Set<string>()
  const keptPerAction = attributions.map(
    () => new Set<string>(),
  )
  let unattributed = 0
  let ambiguous = 0
  let droppedUserEdits = 0

  // The run's wall-clock span, used to decide which feed rows are even in
  // scope: feed-poc.jsonl accumulates across the whole battery, so rows from
  // before or after the run are not this run's business. It runs to the `end`
  // record, not merely to the last action window — a row that arrived while
  // the actor was still running but that no action explains is exactly what
  // `unattributed` is for.
  const spanStart = windows[0]?.tStart ?? Infinity
  const spanEnd = Math.max(
    windows[windows.length - 1]?.windowEnd ?? -Infinity,
    end?.tEnd ?? -Infinity,
  )

  for (const row of feedRows) {
    const at = num(row.tEvent)
    if (at === null) {
      continue
    }
    const covering = windows
      .map((w, i) => ({ w, i }))
      .filter(
        ({ w }) => at >= w.tStart && at <= w.windowEnd,
      )
    if (covering.length === 0) {
      if (at >= spanStart && at <= spanEnd) {
        unattributed += 1
      }
      continue
    }
    // Earliest window wins. Overlap is real at a short cadence with a grace
    // above the batch period; picking silently would be fake precision, so the
    // ambiguity is counted and reported instead.
    const first = covering[0]
    const target = attributions[first.i]
    target.rows += 1
    if (covering.length > 1) {
      target.ambiguous += 1
      ambiguous += 1
    }
    const verdict =
      typeof row.verdict === 'string'
        ? row.verdict
        : 'unknown'
    target.verdicts[verdict] =
      (target.verdicts[verdict] ?? 0) + 1
    const mutation = isMutationRow(row)
    if (mutation) {
      target.mutations += 1
      target.silent = false
    }
    if (verdict === 'kept') {
      target.keptRows += 1
      target.silentStrict = false
      if (typeof row.id === 'string') {
        keptIds.add(row.id)
        keptPerAction[first.i].add(row.id)
      }
    } else if (mutation && verdict.startsWith('dropped-')) {
      droppedUserEdits += 1
    }
  }

  attributions.forEach((a, i) => {
    a.kept = [...keptPerAction[i]].sort()
  })

  const silent = attributions.filter(a => a.silent).length
  const silentStrict = attributions.filter(
    a => a.silentStrict,
  ).length
  const aborted = end?.aborted ?? false

  return {
    run: run?.run ?? records[0]?.run ?? 'unknown',
    mode: run?.mode ?? 'unknown',
    label: run?.label ?? '',
    aborted,
    sent:
      end?.sent ?? attributions.filter(a => a.ok).length,
    graceMs,
    actions: attributions,
    silent,
    silentStrict,
    keptIds: [...keptIds].sort(),
    droppedUserEdits,
    unattributed,
    ambiguous,
    badFeedLines: opts.badFeedLines ?? 0,
    badActorLines: opts.badActorLines ?? 0,
    ok:
      !aborted &&
      silent === 0 &&
      attributions.length > 0 &&
      attributions.every(a => a.ok),
  }
}

export const formatReconciliation = (
  r: Reconciliation,
): string => {
  const head = r.ok
    ? `[actor-verify] OK — run ${r.run} (${r.mode}${
        r.label === '' ? '' : `, ${r.label}`
      }): all ${r.actions.length} actions landed`
    : `[actor-verify] UNRELIABLE — run ${r.run} (${r.mode}${
        r.label === '' ? '' : `, ${r.label}`
      }): ${r.silent} silent action(s)${
        r.aborted ? ', run ABORTED' : ''
      }. Do not score any case against this run.`
  const lines = [
    head,
    `  actions        ${r.actions.length} (sent ${r.sent})`,
    `  silent         ${r.silent}${
      r.silent === 0
        ? ''
        : ` → #${r.actions
            .filter(a => a.silent)
            .map(a => a.seq)
            .join(', #')}`
    } (no document MUTATION in the window; assumes an idle agent)`,
    `  silent strict  ${r.silentStrict}${
      r.silentStrict === 0
        ? ''
        : ` → #${r.actions
            .filter(a => a.silentStrict)
            .map(a => a.seq)
            .join(', #')}`
    } (no row SURVIVED the filter — the only agent-proof reading)`,
    `  kept ids       ${r.keptIds.length}${
      r.keptIds.length === 0
        ? ''
        : ` → ${r.keptIds.join(', ')}`
    }`,
    `  dropped rows   ${r.droppedUserEdits} (attributed to the actor, i.e. filtered USER edits)`,
    `  unattributed   ${r.unattributed} (rows in the run's span from someone else — the agent)`,
    `  ambiguous      ${r.ambiguous} (grace ${r.graceMs}ms overlaps the cadence)`,
  ]
  if (r.badActorLines > 0 || r.badFeedLines > 0) {
    lines.push(
      `  CORRUPT LINES  actor ${r.badActorLines}, feed ${r.badFeedLines} — rows are missing`,
    )
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const actorPath = flag('--actor') ?? DEFAULT_ACTOR_OUT
  const feedPath = flag('--feed') ?? DEFAULT_FEED
  const graceRaw = flag('--grace-ms')
  const actorText = await readFile(actorPath, 'utf8')
  const feedText = await readFile(feedPath, 'utf8')
  const actorLog = parseJsonl<ActorRecord>(actorText)
  const feedLog = parseJsonl<FeedRow>(feedText)
  const result = reconcile(
    selectRun(actorLog.rows, flag('--run')),
    feedLog.rows,
    {
      graceMs:
        graceRaw === undefined
          ? DEFAULT_GRACE_MS
          : Number(graceRaw),
      badActorLines: actorLog.bad,
      badFeedLines: feedLog.bad,
    },
  )
  console.log(formatReconciliation(result))
  if (!result.ok) {
    // Non-zero so a battery script cannot carry on scoring cases against a
    // run this refused.
    process.exitCode = 1
  }
}
