// The drop rule (change-feed.md, Plugin-side pipeline §2). Source-side, because
// DocumentChange.origin === 'LOCAL' includes the plugin's OWN edits.
import type {
  ChangeOp,
  ChangeRecord,
} from '@figma-agent-bridge/shared/change-feed'
import type { WriteScope } from './write-scope'

/** Geometry a re-flow moves on a node the agent did not name. All are real
 *  NodeChangeProperty values. `name`/`parent`/`fills`/`characters` are NOT here
 *  — a user renaming a node the agent re-flowed must survive. */
export const CASCADE_PROPS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'rotation',
  'relativeTransform',
])

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

export type SelfWriteFilter = {
  admit(change: unknown): ChangeRecord | null
  admitContext(rec: ChangeRecord): boolean
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

const isSelfWrite = (
  id: string,
  op: ChangeOp,
  touched: ReadonlySet<string>,
): boolean => {
  if (touched.has(id)) return true
  if (!op.startsWith('style_')) return false
  const key = styleKey(id)
  return touched.has(key) || touched.has(`${key},`)
}

export const createSelfWriteFilter = (
  scope: WriteScope,
): SelfWriteFilter => ({
  admit(change) {
    const c = (change ?? {}) as RawChange
    if (typeof c.type !== 'string') return null
    const op = OP_BY_TYPE.get(c.type)
    if (op === undefined) return null
    const target = c.type.startsWith('STYLE_')
      ? c.style
      : c.node
    const id = target?.id ?? c.id
    if (id === undefined) return null

    // Node and style records are decided by MEMBERSHIP and nothing else.
    // Membership is asked at EVENT time and answered from what the scope
    // retains THEN; nothing in the question refers to how long the runtime
    // took to deliver the event, which is what makes an arbitrarily deferred
    // batch decidable at all.
    if (isSelfWrite(id, op, scope.touched())) return null

    const rec: ChangeRecord = { op, id }
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
      let props = [...new Set(c.properties ?? [])].sort()
      // `op === 'update'` is the only thing scoping the reflow rule to
      // nodes: no real StyleChangeProperty is a cascade property.
      if (op === 'update' && scope.reflow().has(id)) {
        // Subtraction, not a whole-record drop: one batch can carry the
        // agent's cascade AND the user's rename on the same node.
        props = props.filter(p => !CASCADE_PROPS.has(p))
        if (props.length === 0) return null
      }
      rec.props = props
    }
    return rec
  },
  // The agent's own set_current_page / set_selection fire the same events;
  // a page/select record is context, never a mutation, so dropping one is
  // harmless (it never counts toward pending_edits). Decided PER SLOT, and
  // only the `page` slot can ride retention.
  admitContext(rec) {
    if (scope.inFlight()) return false
    // The page id a set_current_page names is harvested like any other id,
    // so the agent's own page switch is decided by MEMBERSHIP — delivery is
    // deferred, so the in-flight flag alone would let it back in long after
    // the command exited, and the block would report "the user just switched
    // page" (a T7 violation).
    if (
      rec.op === 'page' &&
      rec.id !== undefined &&
      scope.touched().has(rec.id)
    ) {
      return false
    }
    // A `select` record cannot be decided that way: it carries NO id, and
    // its `ids` are the CURRENT selection rather than an identity, so
    // testing them against touched() would drop the user's selection of the
    // very nodes the agent just built — the most likely thing a user selects
    // and exactly what the slot exists to report. The agent's own selection
    // changes therefore surface as the user's whenever they arrive after
    // their command; the cost is a wrong hint, never a wrong count.
    return true
  },
})
