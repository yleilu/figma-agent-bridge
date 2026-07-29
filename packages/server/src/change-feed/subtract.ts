// Subtraction at ingest — each consumer drops its OWN (change-feed.md,
// "Subtraction at ingest"). Pure: no buffer, no state, no clock.
//
// One plugin serves every session on the file and broadcasts ONE frame to all
// of them, so the plugin ATTRIBUTES and the consumer SUBTRACTS. A drop decided
// in the plugin is a drop for everyone — and a session whose peer's work was
// dropped for it reads `pending_edits: 0`, which the design defines as "nothing
// changed, the snapshot is good". That is the exact failure the feed exists to
// prevent, reached with another agent in place of the user, and reached
// SILENTLY.
import {
  CASCADE_PROPS,
  writerKeyOf,
  type ChangeRecord,
  type WriterKey,
} from '@figma-agent-bridge/shared/change-feed'

/**
 * What ingest does with one arriving record, resolved against THIS server's own
 * writer.
 *
 * A dropped record is not reported as a change to anyone, but it does not
 * vanish: what it touched is appended to the id's history as a SELF RUN,
 * position and all. The position is not an extravagance — it is the difference
 * between a fold that can say "your write was superseded" and one that says it
 * when the opposite is true.
 */
export type IngestResolution =
  | {
      kind: 'foreign'
      key: WriterKey
      rec: ChangeRecord
    }
  | { kind: 'self'; mine: string[] }
  | {
      kind: 'split'
      key: WriterKey
      rec: ChangeRecord
      mine: string[]
    }

/**
 * This writer's bit in the frame's `writers[]` table, or 0 when the table does
 * not name it — the correct answer for a server that caused none of this frame,
 * and the same answer an absent table gives.
 *
 * Bit 31 is the sign bit of a 32-bit signed operand, so a table position at or
 * past it wins no bit. WRITERS_CAP sits well below that; this is the floor
 * under it, not the bound.
 */
export const bitFor = (
  writers: readonly string[] | undefined,
  self: string,
): number => {
  if (writers === undefined) {
    return 0
  }
  const i = writers.indexOf(self)
  return i < 0 || i >= 31 ? 0 : 1 << i
}

/** The writers a mask names, as a set — the operand `writerKeyOf` canonicalises
 *  into the buffer-local run key. */
const namesOf = (
  mask: number,
  writers: readonly string[] | undefined,
): ReadonlySet<string> => {
  const out = new Set<string>()
  if (writers === undefined || mask === 0) {
    return out
  }
  for (let i = 0; i < writers.length && i < 31; i += 1) {
    const name = writers[i]
    if ((mask & (1 << i)) !== 0 && name !== undefined) {
      out.add(name)
    }
  }
  return out
}

const isUpdate = (op: string): boolean =>
  op === 'update' || op === 'style_update'

/** What a dropped record leaves behind: the property names it changed, or the
 *  OP LITERAL for a structural one. No `NodeChangeProperty` or
 *  `StyleChangeProperty` is named `create` or `delete`, so one flat list
 *  carries both without ambiguity. */
const mineOf = (rec: ChangeRecord): string[] =>
  isUpdate(rec.op)
    ? [...new Set(rec.props ?? [])].sort()
    : [rec.op]

/**
 * The ingest table, exactly:
 *
 * | this server's bit | create / delete | update | style records | page slot |
 * | in `by`           | drop → self run | drop → self run | drop → self run | drop |
 * | in `rf`, ANOTHER writer in `by` | keep | KEEP WHOLE | n/a | n/a |
 * | in `rf` only, `by` empty | keep | SUBTRACT CASCADE_PROPS | keep | n/a |
 * | in neither        | keep | keep | keep | keep |
 *
 * `select` reaches it in no row: it carries no id and therefore neither mask.
 */
export const resolveIngest = (
  rec: ChangeRecord,
  writers: readonly string[] | undefined,
  self: string,
): IngestResolution => {
  const bit = bitFor(writers, self)
  const by = rec.by ?? 0
  const rf = rec.rf ?? 0

  // Absent means unattributed, and unattributed means EVERYBODY keeps it: every
  // failure of attribution surfaces as an over-report to someone, never as
  // silence.
  if (bit !== 0 && (by & bit) !== 0) {
    return { kind: 'self', mine: mineOf(rec) }
  }

  if (
    bit !== 0 &&
    (rf & bit) !== 0 &&
    // `rf` is node-only, and subtraction is per PROPERTY: a create or a delete
    // has no property list to subtract from.
    rec.op === 'update' &&
    // An explicit write by SOMEBODY ELSE outranks a cascade explanation. Two
    // sessions working in one auto-layout parent each hold every child of it in
    // `rf`, so a node another session deliberately resized carries this bit
    // too; subtracting there loses a named write to a cascade this reader
    // merely COULD have caused — silence, on the most natural shape of
    // multi-agent work.
    by === 0
  ) {
    const props = rec.props ?? []
    const mine = props.filter(p => CASCADE_PROPS.has(p))
    if (mine.length === 0) {
      return { kind: 'foreign', key: '', rec }
    }
    // Subtraction, not a whole-record drop: `PropertyChange.properties` is an
    // array and one batch can carry another party's cascade AND a rename on the
    // same node. Dropping the whole record on a partial match silently loses
    // the rename.
    const kept = props.filter(p => !CASCADE_PROPS.has(p))
    mine.sort()
    if (kept.length === 0) {
      return { kind: 'self', mine }
    }
    const next: ChangeRecord = { ...rec, props: kept }
    if (rec.set !== undefined) {
      const set: Record<string, unknown> = {}
      for (const p of kept) {
        if (p in rec.set) {
          set[p] = rec.set[p]
        }
      }
      if (Object.keys(set).length > 0) {
        next.set = set
      } else {
        delete next.set
      }
    }
    return { kind: 'split', key: '', rec: next, mine }
  }

  return {
    kind: 'foreign',
    key: writerKeyOf(namesOf(by, writers)),
    rec,
  }
}
