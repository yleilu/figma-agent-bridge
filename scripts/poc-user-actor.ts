// scripts/poc-user-actor.ts — the change-feed POC's scripted "user"
// (docs/scratch/plans/2026-07-26-change-feed.md, Task 1e). THROWAWAY: deleted
// with the rest of the probe harness in Task 7.
//
// ── THE ONE PROPERTY THAT MATTERS ───────────────────────────────────────────
// The actor's edits must reach Figma WITHOUT passing through `handleCommand`.
// Anything dispatched over the relay is wrapped by `pocScope.enter/exit` in
// code.ts, so its ids land in the self-write window's touched set — it IS an
// agent write, by construction. An actor built on the relay would make every
// case that asks "does a real user edit survive the filter?" vacuously true and
// the POC would prove nothing.
//
// So the actor drives the real Figma UI with real keystrokes, the way a person
// does: the edit is produced by Figma's own editor, reaches `documentchange`
// through the same path a human's does, and the plugin cannot tell the
// difference. That is the whole design. `osascript` is only the delivery
// mechanism; see LIMITS below for what it costs.
//
// ── WHY THIS IS TYPESCRIPT AND NOT THE PLAN'S .sh ───────────────────────────
// The plan sketched `scripts/poc-user-actor.sh`. Two of the task's own
// requirements are not reachable from bash on macOS:
//
//   * TIMESTAMPS. Case 1 needs a user edit landing at a KNOWN moment inside a
//     long agent write, and the row it produces is correlated to
//     `feed-poc.jsonl` by millisecond `tEvent`. BSD `date` has no millisecond
//     format, and shelling out to get one costs more than the interval being
//     measured.
//   * DETERMINISM. `sleep 0.15` in a loop schedules relative to the END of the
//     previous `osascript`, so every process spawn (~80-200ms, and variable)
//     accumulates into the cadence. Here each action is scheduled against an
//     ABSOLUTE instant computed once, and the record carries `lateMs` — the
//     drift is reported rather than hidden.
//
// The mechanism the plan chose (osascript into the real Figma UI) is unchanged.
//
// ── THE SAFETY GUARD (from .claude/skills/figma-plugin-automation, §3) ──────
// Keystrokes go to the FRONTMOST app. `activate` alone is NOT reliable, and the
// skill records keys leaking into the terminal as stray plugin chat messages.
// For this actor a leak is worse than untidy: `rename` types text and then
// presses Return, so a leaked run executes whatever it typed in a shell. Every
// action therefore re-checks `frontmost of process "Figma"` inside the same
// osascript that sends the keys, and returns ABORT instead of typing. The first
// ABORT stops the whole run — see `runActor`.
//
// ── LIMITS AN OPERATOR MUST KNOW ────────────────────────────────────────────
//  1. FOCUS. Arrow keys only nudge the selection when the CANVAS has focus. If
//     focus is in the plugin's iframe (likely right after a Quick-Actions
//     launch) or in a panel field, the keys go there and the actor no-ops
//     SILENTLY — Figma is frontmost, so the guard passes. Click once on empty
//     canvas, then select the target, before running the actor. Reconcile the
//     run afterwards with `scripts/poc-actor-verify.ts`, which is what turns a
//     silent no-op into a visible failure.
//  2. SELECTION — ARM THE TARGET BY HAND. The actor edits whatever is
//     selected; it never selects anything itself. There is ONE dispatch point
//     in code.ts, so EVERY command opens the write window — including reads.
//     `set_selection` is the natural way to arm a target and it puts that
//     exact id into `touched()` for SETTLE_MS, so any actor edit on it inside
//     the window is dropped and cases 1 and 10 fail for a HARNESS artifact
//     rather than a design property. The gate's failure branch is defined as
//     "the value of SETTLE_MS at which case 1 starts failing", so this
//     artifact would move the falsification boundary and could trigger the
//     STOP / human-escalation path on a filter that is not actually
//     falsified.
//     THE PROTOCOL: click the node in Figma. Do not arm with `set_selection`
//     or any other MCP call, and record the arming method per case in the
//     results doc. If a command must be used, `--arm-ms` MUST exceed the
//     SETTLE_MS under test plus a margin — and the default (800 ms) is BELOW
//     plausible swept values, so it is not safe by default.
//  3. `walk` mode depends on Tab selecting the next sibling. It is the least
//     certain of the three modes; verify its coverage before scoring case 10
//     on it.
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { genId } from '@figma-agent-bridge/shared/id'

// `.pathname` on a file: URL is percent-encoded; a repo path with a space in
// it would resolve to a file that does not exist.
const REPO_ROOT = fileURLToPath(
  new URL('../', import.meta.url),
)

/** Sibling of the collector's feed-poc.jsonl, and read against it by
 *  scripts/poc-actor-verify.ts. */
export const DEFAULT_ACTOR_OUT = `${REPO_ROOT}docs/scratch/poc/user-actor.jsonl`

/** macOS virtual key codes. */
export const KEY = {
  left: 123,
  right: 124,
  tab: 48,
  f2: 120,
  return: 36,
} as const

export const ACTOR_MODES = [
  'nudge',
  'rename',
  'walk',
] as const

export type ActorMode = (typeof ACTOR_MODES)[number]

export type Step =
  | { kind: 'key'; code: number; note: string }
  | { kind: 'type'; text: string }
  | { kind: 'delay'; ms: number }

/**
 * The alphabet a `type` step may draw from. Deliberately narrow: the text is
 * interpolated into an AppleScript string literal that is then typed into the
 * frontmost window, so anything able to close that literal is an injection —
 * and the very next step presses Return.
 */
const KEYSTROKE_SAFE = /^[A-Za-z0-9 ._-]+$/

/** The name a `rename` action types. Generated, never operator-supplied, and
 *  carrying the sequence number so a `props: ["name"]` row in feed-poc.jsonl
 *  can be attributed to one specific action. */
export const renameTextFor = (seq: number): string =>
  `poc-user-edit-${seq}`

/**
 * The keystrokes one action sends.
 *
 * `nudge` alternates right/left rather than always nudging one way: over a
 * run whose length is a multiple of 4 the node ends where it started, so a
 * SETTLE_MS sweep can re-run the same battery on the same file without the
 * target drifting out of the viewport — while still emitting exactly one `x`
 * PROPERTY_CHANGE per press.
 *
 * The alternation period is 4 (right, right, left, left), NOT 2. A strict
 * right/left alternation is net-zero per PAIR, and documentchange is batched:
 * if a right and the following left land in one batch, Figma coalesces them
 * into a single `x` change — or none at all, since x returns to its original
 * value. `poc-actor-verify` then scores one of the two actions `silent` and
 * refuses the whole run. Failure is in the safe direction (loud, not silent),
 * but it produces spurious UNRELIABLE verdicts precisely when the cadence is
 * tuned near the batch period — which is what Measurement B asks for. With
 * period 4, consecutive same-direction presses always land on distinct x
 * values.
 */
export const stepsFor = (
  mode: ActorMode,
  seq: number,
): Step[] => {
  if (mode === 'rename') {
    return [
      { kind: 'key', code: KEY.f2, note: 'F2' },
      { kind: 'delay', ms: 200 },
      { kind: 'type', text: renameTextFor(seq) },
      { kind: 'key', code: KEY.return, note: 'return' },
    ]
  }
  if (mode === 'walk') {
    // Case 10 wants edits across N DISTINCT nodes: nudge, then Tab to the next
    // sibling. Not net-zero — each visited node keeps its +1px.
    return [
      { kind: 'key', code: KEY.right, note: 'right' },
      { kind: 'delay', ms: 120 },
      { kind: 'key', code: KEY.tab, note: 'tab' },
    ]
  }
  return [
    (seq - 1) % 4 < 2
      ? { kind: 'key', code: KEY.right, note: 'right' }
      : { kind: 'key', code: KEY.left, note: 'left' },
  ]
}

/** A one-line rendering of an action, stored on its record so a feed row can
 *  be read back against the key that produced it. */
export const describeSteps = (
  steps: readonly Step[],
): string =>
  steps
    .filter(s => s.kind !== 'delay')
    .map(s =>
      s.kind === 'key'
        ? `key ${s.note}`
        : `type "${s.text}"`,
    )
    .join(' + ')

const FRONTMOST_GUARD = [
  '  tell application "System Events"',
  '    if not (frontmost of process "Figma") then',
  '      return "ABORT"',
  '    end if',
]

/** AppleScript for one action, with the frontmost guard ahead of every key. */
export const buildActionScript = (
  steps: readonly Step[],
): string => {
  const body = steps.map(step => {
    if (step.kind === 'key') {
      return `        key code ${step.code}`
    }
    if (step.kind === 'delay') {
      return `        delay ${step.ms / 1000}`
    }
    if (!KEYSTROKE_SAFE.test(step.text)) {
      throw new Error(
        `[poc-user-actor] refusing to type text that is not keystroke-safe: ${step.text}`,
      )
    }
    return `        keystroke "${step.text}"`
  })
  return [
    'on run',
    ...FRONTMOST_GUARD,
    '    tell process "Figma"',
    ...body,
    '    end tell',
    '  end tell',
    '  return "OK"',
    'end run',
  ].join('\n')
}

/** AppleScript for the one-time preamble: bring Figma forward and report
 *  whether it actually got there. Mirrors scripts/reload-plugin.sh. */
export const buildActivateScript = (): string =>
  [
    'on run',
    '  tell application "Figma" to activate',
    '  delay 1.2',
    '  tell application "System Events"',
    '    set frontmost of process "Figma" to true',
    '    delay 0.7',
    '    if frontmost of process "Figma" then',
    '      return "OK"',
    '    else',
    '      return "ABORT"',
    '    end if',
    '  end tell',
    'end run',
  ].join('\n')

export type ActorPlan = {
  mode: ActorMode
  count: number
  cadenceMs: number
  armMs: number
  /** Absolute epoch ms to fire the FIRST action, or null for "once armed". */
  startAt: number | null
  label: string
  out: string
  runId: string
  dryRun: boolean
}

/**
 * When the first action fires. `startAt` can only push it LATER: an instant
 * already in the past must not cancel the arm window, because the arm window
 * is what lets the previous agent command's SETTLE_MS elapse.
 */
export const firstActionAt = (
  plan: ActorPlan,
  readyAt: number,
): number =>
  Math.max(readyAt + plan.armMs, plan.startAt ?? 0)

/** Absolute instants for every action, all measured off the first one — so a
 *  slow osascript spawn shows up as `lateMs` on one action instead of shifting
 *  every action after it. */
export const plannedStarts = (
  plan: ActorPlan,
  firstAt: number,
): number[] =>
  Array.from(
    { length: plan.count },
    (_, i) => firstAt + i * plan.cadenceMs,
  )

const asMode = (raw: string): ActorMode => {
  const found = ACTOR_MODES.find(m => m === raw)
  if (found === undefined) {
    throw new Error(
      `[poc-user-actor] unknown mode "${raw}" — expected one of ${ACTOR_MODES.join(', ')}`,
    )
  }
  return found
}

const asInt = (raw: string, flag: string): number => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `[poc-user-actor] ${flag} expects a non-negative integer, got "${raw}"`,
    )
  }
  return n
}

/**
 * Arguments. Both forms are accepted: the plan's shell-style
 * `poc-user-actor nudge 20` positional pair, and explicit flags.
 *
 * Unknown flags THROW rather than being ignored — a mistyped `--start-in` that
 * silently defaults would put the case-1 edit outside the agent write it is
 * supposed to land inside, and the run would look fine.
 */
export const parseActorArgs = (
  argv: readonly string[],
  opts: { now?: number; runId?: string } = {},
): ActorPlan => {
  const now = opts.now ?? Date.now()
  const plan: ActorPlan = {
    mode: 'nudge',
    count: 20,
    cadenceMs: 150,
    armMs: 800,
    startAt: null,
    label: '',
    out: DEFAULT_ACTOR_OUT,
    runId: opts.runId ?? genId('actor'),
    dryRun: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) {
        throw new Error(
          `[poc-user-actor] ${arg} expects a value`,
        )
      }
      i += 1
      return v
    }
    switch (arg) {
      case '--mode':
        plan.mode = asMode(next())
        break
      case '--count':
        plan.count = asInt(next(), '--count')
        break
      case '--cadence-ms':
        plan.cadenceMs = asInt(next(), '--cadence-ms')
        break
      case '--arm-ms':
        plan.armMs = asInt(next(), '--arm-ms')
        break
      case '--start-at':
        plan.startAt = asInt(next(), '--start-at')
        break
      case '--start-in':
        plan.startAt = now + asInt(next(), '--start-in')
        break
      case '--label':
        plan.label = next()
        break
      case '--out':
        plan.out = next()
        break
      case '--run':
        plan.runId = next()
        break
      case '--dry-run':
        plan.dryRun = true
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(
            `[poc-user-actor] unknown flag ${arg}`,
          )
        }
        positional.push(arg)
    }
  }
  if (positional[0] !== undefined) {
    plan.mode = asMode(positional[0])
  }
  if (positional[1] !== undefined) {
    plan.count = asInt(positional[1], 'count')
  }
  return plan
}

export type ActorRecord =
  | {
      kind: 'run'
      run: string
      mode: ActorMode
      count: number
      cadenceMs: number
      armMs: number
      label: string
      dryRun: boolean
      tArmed: number
      tFirst: number
    }
  | {
      kind: 'action'
      run: string
      seq: number
      mode: ActorMode
      label: string
      detail: string
      /** The instant this action was SCHEDULED for. */
      tTarget: number
      /** The instant the keystroke was actually dispatched. */
      tStart: number
      /** The instant osascript returned. The edit landed in [tStart, tEnd]. */
      tEnd: number
      lateMs: number
      ok: boolean
      error?: string
    }
  | {
      kind: 'end'
      run: string
      sent: number
      aborted: boolean
      reason?: string
      tEnd: number
    }

export type ActorDeps = {
  osa: (script: string) => Promise<string>
  now: () => number
  waitUntil: (at: number) => Promise<void>
  write: (line: string) => void | Promise<unknown>
  log?: (line: string) => void
}

export type ActorResult = {
  sent: number
  aborted: boolean
  records: ActorRecord[]
}

/**
 * Drive one run.
 *
 * The abort rule is the important part. A run that skips a refused action and
 * carries on produces a log of N actions of which some silently did nothing,
 * and case 10 ("the user makes 20 edits, the POC pending count is exactly 20")
 * would then be scored against an actor that sent 14. The first refusal ends
 * the run, is recorded, and makes the process exit non-zero.
 */
export const runActor = async (
  plan: ActorPlan,
  deps: ActorDeps,
): Promise<ActorResult> => {
  const records: ActorRecord[] = []
  const log = deps.log ?? (() => undefined)
  const emit = async (rec: ActorRecord): Promise<void> => {
    records.push(rec)
    await deps.write(`${JSON.stringify(rec)}\n`)
  }

  if (!plan.dryRun) {
    const front = await deps.osa(buildActivateScript())
    if (front.trim() !== 'OK') {
      log(
        '[actor] ABORT: Figma is not frontmost — sent no keys (this is the terminal-leak guard)',
      )
      await emit({
        kind: 'end',
        run: plan.runId,
        sent: 0,
        aborted: true,
        reason: 'figma-not-frontmost',
        tEnd: deps.now(),
      })
      return { sent: 0, aborted: true, records }
    }
  }

  const tArmed = deps.now()
  const tFirst = firstActionAt(plan, tArmed)
  const targets = plannedStarts(plan, tFirst)
  await emit({
    kind: 'run',
    run: plan.runId,
    mode: plan.mode,
    count: plan.count,
    cadenceMs: plan.cadenceMs,
    armMs: plan.armMs,
    label: plan.label,
    dryRun: plan.dryRun,
    tArmed,
    tFirst,
  })

  let sent = 0
  let aborted = false
  for (const [i, target] of targets.entries()) {
    const seq = i + 1
    const steps = stepsFor(plan.mode, seq)
    const detail = describeSteps(steps)
    // Built BEFORE the wait so unsafe text fails the run immediately rather
    // than half way through a battery.
    const script = buildActionScript(steps)
    await deps.waitUntil(target)
    const tStart = deps.now()
    let ok = false
    let error: string | undefined
    if (plan.dryRun) {
      // The schedule and the log, with nothing typed anywhere. This is how an
      // operator checks a `--start-in` lands inside the agent write it is
      // meant to land inside, before running it for real.
      ok = true
    } else {
      try {
        const reply = (await deps.osa(script)).trim()
        ok = reply === 'OK'
        if (!ok) {
          error = reply
        }
      } catch (err) {
        error = String(err)
      }
    }
    const tEnd = deps.now()
    await emit({
      kind: 'action',
      run: plan.runId,
      seq,
      mode: plan.mode,
      label: plan.label,
      detail,
      tTarget: target,
      tStart,
      tEnd,
      lateMs: tStart - target,
      ok,
      ...(error === undefined ? {} : { error }),
    })
    if (!ok) {
      log(
        `[actor] ABORT at action ${seq}: ${error ?? 'refused'}`,
      )
      aborted = true
      break
    }
    sent += 1
  }

  await emit({
    kind: 'end',
    run: plan.runId,
    sent,
    aborted,
    ...(aborted ? { reason: 'action-refused' } : {}),
    tEnd: deps.now(),
  })
  return { sent, aborted, records }
}

/** Run one AppleScript and hand back its result. */
const osascript = async (
  script: string,
): Promise<string> => {
  const proc = Bun.spawn(['osascript', '-'], {
    stdin: new TextEncoder().encode(script),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(
      `osascript exited ${code}: ${err.trim() || out.trim()}`,
    )
  }
  return out
}

const sleepUntil = async (at: number): Promise<void> => {
  const ms = at - Date.now()
  if (ms > 0) {
    await Bun.sleep(ms)
  }
}

if (import.meta.main) {
  const plan = parseActorArgs(Bun.argv.slice(2))
  await mkdir(dirname(plan.out), { recursive: true })
  // Serialized like the collector's: two overlapping appends can interleave a
  // partial line, and one corrupt line makes `jq -s` fail over the whole file.
  let writes: Promise<unknown> = Promise.resolve()
  const result = await runActor(plan, {
    osa: osascript,
    now: Date.now,
    waitUntil: sleepUntil,
    write: line => {
      writes = writes.then(() => appendFile(plan.out, line))
      return writes
    },
    log: line => console.log(line),
  })
  await writes
  console.log(
    `[actor] ${plan.mode} x${result.sent}/${plan.count}${
      plan.dryRun ? ' (dry run)' : ''
    } → ${plan.out}`,
  )
  if (result.aborted) {
    console.error(
      '[actor] RUN ABORTED — do not score any case against this log',
    )
    // Non-zero, but without a stack trace: the message above IS the report.
    process.exitCode = 1
  }
}
