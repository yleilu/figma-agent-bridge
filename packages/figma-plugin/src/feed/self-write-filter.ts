// The drop rule (change-feed.md, Plugin-side pipeline §2). Source-side, because
// DocumentChange.origin === 'LOCAL' includes the plugin's OWN edits.
import type { WriteScope } from './write-scope'

// ── TEMPORARY — verbatim copies of the declarations that land in
// packages/shared/src/change-feed.ts in Task 3. DELETE these two blocks in
// Task 3 and import them from '@figma-agent-bridge/shared/change-feed' instead.
// They are duplicated (not imported) because the shared module does not exist
// yet and its SETTLE_MS value is the POC's output, so it cannot land first.
type MutationOp =
  | 'create'
  | 'update'
  | 'delete'
  | 'style_create'
  | 'style_update'
  | 'style_delete'

export type ChangeOp = MutationOp | 'page' | 'select'

export type ChangeRecord = {
  op: ChangeOp
  id?: string
  type?: string
  name?: string
  props?: string[]
  ids?: string[]
  count?: number
}
// ── end TEMPORARY ───────────────────────────────────────────────────────────

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
  } | null
  properties?: string[]
}

export type SelfWriteFilter = {
  admit(change: unknown): ChangeRecord | null
  admitContext(): boolean
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

    const open = scope.isOpen()
    if (open && scope.touched().has(id)) return null

    const rec: ChangeRecord = { op, id }
    if (typeof target?.type === 'string') {
      rec.type = target.type
    }
    const isDelete =
      op === 'delete' || op === 'style_delete'
    if (!isDelete && typeof target?.name === 'string') {
      rec.name = target.name
    }

    if (op === 'update' || op === 'style_update') {
      let props = [...new Set(c.properties ?? [])].sort()
      if (
        op === 'update' &&
        open &&
        scope.reflow().has(id)
      ) {
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
  // harmless (it never counts toward pending_edits).
  admitContext: () => !scope.isOpen(),
})
