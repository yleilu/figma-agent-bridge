import type { StatusRecord } from '@figma-agent-bridge/shared'
import {
  COMMANDS,
  READ_ONLY_COMMANDS,
} from '@figma-agent-bridge/shared'

// status-monitor.md § Derived presence — the roster's lower tier: rows the
// PANEL synthesizes from the command frames it is already carrying, so it
// can never claim "No agent active" while an agent works. Pure and
// panel-local: a derived row is never stored by the relay, never broadcast,
// and never crosses the wire.

// A derived row IS the evidence of traffic, so it lives exactly as long as
// the evidence: 30s past the last command frame for its session, then gone.
// No idle-fade tier — there is no narrative to leave behind.
export const DERIVED_TTL_MS = 30_000

// How often the panel re-checks the TTL. Nothing outside this iframe knows a
// derived row exists, so unlike a reported row (swept by the relay, which
// broadcasts the removal) it needs its own clock.
export const DERIVED_SWEEP_MS = 5_000

// A burst of same-class frames changes nothing that renders, so it must not
// churn state: a re-render restarts the busy dot's pulse loop. Only
// updatedAt would move, and lagging it by <2s on a 30s TTL costs nothing.
const COALESCE_MS = 2_000

// A row the panel derived rather than received. The mark is panel-local
// (like RosterRecord's `synthetic`), which is why it lives here and not on
// the wire type in shared.
export type DerivedRecord = StatusRecord & { derived: true }

export type StatusMap = Record<string, StatusRecord>

const KNOWN_COMMANDS: ReadonlySet<string> = new Set<string>(
  Object.values(COMMANDS),
)

// Commands that CANNOT change the document. READ_ONLY_COMMANDS answers a
// neighbouring question — "can this cause a documentchange /
// currentpagechange / selectionchange event?" — so the two context moves
// that fire an event while touching no node are added back here. Selecting
// a layer or switching page is not editing, and must not read as it.
const CHANGES_NOTHING: ReadonlySet<string> =
  new Set<string>([
    ...READ_ONLY_COMMANDS,
    COMMANDS.SET_SELECTION,
    COMMANDS.SET_CURRENT_PAGE,
  ])

/**
 * A session's row key. The anonymous row (no identity in the envelope) takes
 * the EMPTY suffix, which no named session can produce — so a session that
 * happens to be called anything at all can never collide with it.
 */
export const derivedKey = (sessionId?: string): string =>
  `derived:${sessionId ?? ''}`

/**
 * The verb class a derived row shows in place of a narrative. Deliberately
 * coarse: the panel knows what KIND of call arrived, never what the agent is
 * doing, and says exactly that much.
 *
 * One question of the command registry — *can this call change the
 * document?* It cannot (a read, or a context move) → `Reading`; it can →
 * `Editing`; `export` is its own class; a command the registry does not know
 * → `Working`. Asking the registry rather than listing 60 commands keeps the
 * classification total over it: a command added to COMMANDS and to neither
 * read set is a write, and reads `Editing`.
 */
export const classifyCommand = (
  command: string,
): string => {
  if (command === COMMANDS.EXPORT) return 'Exporting'
  if (CHANGES_NOTHING.has(command)) return 'Reading'
  return KNOWN_COMMANDS.has(command) ? 'Editing' : 'Working'
}

export const deriveRow = (
  command: string,
  sessionId: string | undefined,
  now: number,
): DerivedRecord => ({
  key: derivedKey(sessionId),
  // An empty sessionId names no session, so it IS the anonymous row.
  sessionId: sessionId === '' ? undefined : sessionId,
  level: 'normal',
  // The class stands in for the skeleton: a row that is provably busy shows
  // the class it is busy with, and never impersonates a report_status line.
  text: classifyCommand(command),
  activity: 'busy',
  updatedAt: now,
  derived: true,
})

/** Record one inbound command frame as presence. */
export const upsertDerived = (
  derived: StatusMap,
  command: string,
  sessionId: string | undefined,
  now: number,
): StatusMap => {
  const row = deriveRow(command, sessionId, now)
  const prev = derived[row.key]
  if (
    prev !== undefined &&
    prev.text === row.text &&
    now - prev.updatedAt < COALESCE_MS
  ) {
    return derived
  }
  return { ...sweepDerived(derived, now), [row.key]: row }
}

/**
 * Drop every derived row whose traffic has been quiet past the TTL. Returns
 * the SAME map when nothing expired, so a tick that finds everything live is
 * a no-op for React.
 */
export function sweepDerived(
  derived: StatusMap,
  now: number,
): StatusMap {
  const live = Object.entries(derived).filter(
    ([, r]) => now - r.updatedAt < DERIVED_TTL_MS,
  )
  return live.length === Object.keys(derived).length
    ? derived
    : Object.fromEntries(live)
}

/**
 * The panel's rows: every reported row, plus each derived row that is still
 * live AND not pre-empted.
 *
 * Pre-emption is decided HERE rather than at upsert so it cannot be undone:
 * a derived row that a report_status superseded stays hidden however many
 * command frames follow it. The anonymous row claims no session and so
 * cannot be matched to one — ANY reported row pre-empts it, because an
 * unattributable row beside an attributed one reads as a second agent that
 * does not exist.
 */
export const mergeStatus = (
  explicit: StatusMap,
  derived: StatusMap,
  now: number,
): StatusMap => {
  const reported = Object.values(explicit)
  const sessions = new Set(
    reported
      .map(r => r.sessionId)
      .filter(s => s !== undefined),
  )
  const rows: StatusMap = {}
  for (const r of Object.values(derived)) {
    const preempted =
      r.sessionId === undefined
        ? reported.length > 0
        : sessions.has(r.sessionId)
    if (!preempted && now - r.updatedAt < DERIVED_TTL_MS) {
      rows[r.key] = r
    }
  }
  return { ...rows, ...explicit }
}
