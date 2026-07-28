// The ATTRIBUTION rule (change-feed.md, Plugin-side pipeline §2). Source-side,
// because DocumentChange.origin === 'LOCAL' includes the plugin's OWN edits and
// carries no sender within them.
//
// It ATTRIBUTES; it does not filter self-writes. The name is the behaviour: the
// plugin's job here is to say WHO caused each change, and the drop that
// decision feeds belongs to the CONSUMER, once each, at ingest. One plugin
// serves every session on the file and one frame is broadcast to all of them,
// so a drop taken here is a drop taken for readers whose answer is different —
// and a session whose peer's work was dropped for it reads `pending_edits: 0`,
// which the design defines as "nothing changed, the snapshot is good".
import type {
  AttributedRecord,
  ChangeOp,
} from '@figma-agent-bridge/shared/change-feed'
import type { WriteScope } from './write-scope'
import { captureLocator, captureValues } from './capture'

// A Map, not an object literal: `OP_BY_TYPE['constructor']` on a literal
// resolves through Object.prototype and would emit a record whose `op` is a
// function.
const OP_BY_TYPE = new Map<string, ChangeOp>([
  ['CREATE', 'create'],
  ['DELETE', 'delete'],
  ['PROPERTY_CHANGE', 'update'],
  ['STYLE_CREATE', 'style_create'],
  ['STYLE_DELETE', 'style_delete'],
  ['STYLE_PROPERTY_CHANGE', 'style_update'],
])

type RawChange = {
  type?: unknown
  id?: string
  node?: {
    id?: string
    type?: string
    name?: string
    removed?: boolean
  }
  // Nullable: StyleDeleteChange narrows `style` to always-null, which is why
  // the id falls back to the change's own `id`.
  style?: {
    id?: string
    type?: string
    name?: string
    removed?: boolean
  } | null
  properties?: string[]
}

/** A RemovedNode / removed BaseStyle. `removed`, `type` and `id` are the only
 *  three reads the API guarantees on one; everything else throws. */
const isRemoved = (
  target: { removed?: boolean } | null | undefined,
): boolean => target?.removed === true

export type SelfWriteAttributor = {
  /** Map one Figma DocumentChange to a STAMPED record — the writers that
   *  touched the id in `by`, the writers whose reflow closure holds it in
   *  `rf`, both as NAMES — or null if the change is not one this feed
   *  represents. NO record is dropped on attribution here. */
  admit(change: unknown): AttributedRecord | null
  /** Stamp a context slot, or null when a navigation some dispatch is causing
   *  should not be recorded. */
  admitContext(
    rec: AttributedRecord,
  ): AttributedRecord | null
  /** Drops the per-FLUSH-WINDOW memo. Called by `emitFlush` immediately after
   *  the accumulator is drained: a locator is a property of where a node sits
   *  now, so it is computed once per id per window and re-computed in the
   *  next one. */
  resetWindow(): void
}

// A style's id is NOT one stable string. `create_styles` returns
// `S:<key>,` — trailing segment empty — while the documentchange event for
// the same style carries the page id: `S:<key>,1:8`. The KEY is the stable
// part. Matching whole strings therefore never succeeded, and every
// agent-created style leaked into the feed as a user edit.
//
// Node ids are NOT normalised: they are exact, and a prefix match would
// wrongly equate `1:8` with `1:80`.
const styleKey = (id: string): string => {
  const comma = id.indexOf(',')
  return comma === -1 ? id : id.slice(0, comma)
}

/**
 * The id forms one change may be recorded under. Asked at EVENT time and
 * answered from what the scope retains THEN — nothing in the question refers to
 * how long the runtime took to deliver the event, which is what makes an
 * arbitrarily deferred batch decidable at all.
 *
 * A STYLE is matched on its KEY, across the two shapes the runtime and the
 * command path produce. Node ids are matched exactly and never by prefix.
 *
 * They go to the scope as ALIASES of one thing rather than as three separate
 * lookups to be unioned: the union would put two writers back on a record that
 * has one, which is the failure `writersOf` narrowing exists to remove.
 */
const idFormsOf = (id: string, op: ChangeOp): string[] => {
  if (!op.startsWith('style_')) return [id]
  const key = styleKey(id)
  return [id, key, `${key},`]
}

export const createSelfWriteAttributor = (
  scope: WriteScope,
): SelfWriteAttributor => {
  // id → locator, for ONE flush window. The walk is per-record cost inside
  // the synchronous handler and a forty-tick drag is forty records for one
  // id, so it is paid once per id per window. A failed walk is memoised too:
  // repeating it would cost the same and answer the same.
  const locators = new Map<
    string,
    { pg?: string; fr?: string }
  >()

  const locate = (
    id: string,
    target: unknown,
  ): { pg?: string; fr?: string } => {
    const held = locators.get(id)
    if (held !== undefined) return held
    const loc = captureLocator(target)
    locators.set(id, loc)
    return loc
  }

  /** `by` and `rf` are read INDEPENDENTLY and a record can carry both: an id
   *  can sit in one writer's touched set and another's reflow closure, and each
   *  consumer reads its own bit out of each. An empty set is omitted, and
   *  ABSENT MEANS UNATTRIBUTED — which means everybody keeps it, so every
   *  failure of attribution surfaces as an over-report to someone rather than
   *  as silence.
   *
   *  `by` names ONE writer — the latest to touch the id — because a record is
   *  one RUN and a run has one writer. Two writers on one record is not a
   *  richer answer but a self-cancelling one: each discards the record as its
   *  own at ingest, so nobody is told. `rf` stays a SET, because a cascade
   *  genuinely can be explicable by several writers at once and the ingest rule
   *  never acts on it while `by` names somebody. */
  const stamp = (
    rec: AttributedRecord,
    id: string,
    op: ChangeOp,
  ): void => {
    const by = scope.writersOf(...idFormsOf(id, op))
    if (by.size > 0) rec.by = by
    // `rf` is NODE-ONLY: no real StyleChangeProperty is a cascade property, so
    // a style record is decided by `by` alone.
    if (!op.startsWith('style_')) {
      const rf = scope.reflowWritersOf(id)
      if (rf.size > 0) rec.rf = rf
    }
  }

  return {
    admit(change) {
      const c = (change ?? {}) as RawChange
      if (typeof c.type !== 'string') return null
      const op = OP_BY_TYPE.get(c.type)
      if (op === undefined) return null
      const isStyle = c.type.startsWith('STYLE_')
      const target = isStyle ? c.style : c.node
      const id = target?.id ?? c.id
      if (id === undefined) return null

      const rec: AttributedRecord = { op, id }
      if (typeof target?.type === 'string') {
        rec.type = target.type
      }
      const isDelete =
        op === 'delete' || op === 'style_delete'
      // `removed`, not `isDelete`, is what makes `name` unreadable. The typings
      // put `node: SceneNode | RemovedNode` on EVERY BaseNodeChange, and
      // documentchange is BATCHED — a node edited and then deleted inside one
      // batch window arrives as a CREATE or PROPERTY_CHANGE whose node is
      // already gone. A RemovedNode exposes only `removed` / `type` / `id` and
      // THROWS on every other read, and this listener has no try/catch around
      // it: one such change would cost the whole batch its records.
      if (
        !isDelete &&
        !isRemoved(target) &&
        typeof target?.name === 'string'
      ) {
        rec.name = target.name
      }

      if (op === 'update' || op === 'style_update') {
        // `props` is COMPLETE and UNCONDITIONAL. The CASCADE_PROPS subtraction
        // the plugin used to perform here has moved to the server, where it is
        // evaluated against each READER's own closure — so a cascade that is
        // noise to the session that caused it stays NEWS to a session that did
        // not, whose snapshot of that node's geometry has just gone stale.
        const props = [
          ...new Set(c.properties ?? []),
        ].sort()
        rec.props = props
        // Values: read from the node the change handed over. `set` is always a
        // subset of `props`, so a value the record does not report on is never
        // carried. Absent when nothing fit or nothing could be read; a removed
        // target has no readable value at all, and asking would only pay one
        // throw per property.
        if (!isRemoved(target)) {
          const set = captureValues(target, props)
          if (set !== undefined) rec.set = set
        }
      }

      // The locator, NODE records only: a style has no place in the node tree,
      // and a RemovedNode exposes no parent, so a delete is never located.
      if (!isStyle && !isDelete && !isRemoved(target)) {
        const loc = locate(id, target)
        if (loc.pg !== undefined) rec.pg = loc.pg
        if (loc.fr !== undefined) rec.fr = loc.fr
      }

      stamp(rec, id, op)
      return rec
    },
    // Both slots are latest-wins CONTEXT, never mutations, and never count
    // toward pending_edits — so a wrong call here costs a wrong hint, never a
    // wrong count. Decided PER SLOT.
    admitContext(rec) {
      // A record describing a navigation some dispatch is CAUSING is dropped
      // for everyone. With more sessions on the file this window is open more
      // of the time, so more genuine changes are suppressed too (Limitations).
      if (scope.inFlight()) return null
      // A COPY: the caller's record is not the attributor's to mutate, and a
      // stamped slot that leaked back into the caller's hands would carry a
      // membership answer from an earlier moment.
      const out: AttributedRecord = { ...rec }
      if (out.op === 'page' && out.id !== undefined) {
        // The page id a set_current_page names is harvested like any other id,
        // so the page slot is STAMPED like any other record: the session that
        // navigated discards its own at ingest, while the others learn that the
        // page changed under them. Delivery is deferred, so the in-flight flag
        // alone would let the agent's own switch back in long after the command
        // exited, and the block would report "the user just switched page" (a
        // T7 violation).
        stamp(out, out.id, out.op)
      }
      // A `select` record carries NEITHER mask: it has no id, and its `ids` are
      // the CURRENT selection rather than an identity, so testing them against
      // a touched set would drop the user's selection of the very nodes the
      // agent just built — the most likely thing a user selects, and exactly
      // what the slot exists to report.
      return out
    },
    resetWindow() {
      locators.clear()
    },
  }
}
