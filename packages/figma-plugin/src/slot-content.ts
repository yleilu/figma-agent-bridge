// slot-content.ts — what a delete takes with it (B84).
//
// Deleting an INSTANCE whose SLOT holds content did not delete the content.
// Figma re-parented it UP into the instance's own container, where it kept
// rendering — and where nothing could touch it. Live, 2026-09-01:
//
//   clone_node       → INSTANCE `570:21813`, its `Body` slot holding a table
//   delete_node      → ok, warnings: []
//   the file         → the table is now a child of the Content column, id
//                      `570:21831`, and it RENDERS (a duplicate six-row table
//                      loose on the screen)
//   every write      → "in get_parent: The node … `I570:21813;570:20826;
//                      570:21817` does not exist" — the handle still answers
//                      the address it had INSIDE the instance, and that
//                      instance is gone
//
// So the file names the node one way and every live handle names it another,
// and there is no id that works. The round paid nine calls and a re-layout to
// get rid of one node it could not address.
//
// The content is reachable while the instance is still there. So it is removed
// FIRST, and the reply says what went — a delete that quietly destroys content
// would be the other half of the same defect.
//
// WHICH DESCENDANTS. A read of a live artifact answers `type: 'SLOT'` for the
// slot inside an INSTANCE and lists the content as its children
// (2026-09-01 readback, 12 SLOT nodes across one screen), so the slot is what
// this looks for, never an id shape. Two kinds of node hang under one:
//
//   the master's own default content — a MIRROR of a node in the component.
//                                      Figma refuses to remove it on its own,
//                                      and the instance's removal takes it.
//   content appended per instance    — the node B84 is about. It removes
//                                      cleanly while the instance stands.
//
// The removal itself is the discriminator, which is why this asks Figma rather
// than guessing: a refusal costs nothing (the node dies with the instance a
// moment later), and a success is exactly the node that would have been
// orphaned.
//
// Structural (`Record<string, unknown>`), so it is testable without a Figma
// runtime — `code.ts` cannot be imported outside Figma.

import { idOf, liveChildren } from './canonical-ids'
import type { LiveNode } from './canonical-ids'

/** As much of a node as this pass needs to name it afterwards. */
export type RemovedNode = {
  id: string
  name: string
  type: string
}

/** How many removed nodes a warning names before it counts the rest (T4). */
const NAMED_IN_WARNING = 5

/**
 * Every node hanging inside a SLOT within `root`'s subtree, outermost first.
 *
 * `root` itself counts as a slot when it is one — deleting a SLOT should take
 * what is in it for the same reason.
 *
 * Every read is guarded: this walks a subtree that may already hold handles
 * Figma composed from a pre-append id, and one of those refusing must not cost
 * the delete.
 */
export const slotContentIn = (
  root: LiveNode,
): LiveNode[] => {
  const out: LiveNode[] = []
  const walk = (node: LiveNode, inSlot: boolean): void => {
    if (inSlot) {
      out.push(node)
    }
    let type: unknown
    try {
      type = (node as { type?: unknown }).type
    } catch {
      // A handle that will not say what it is cannot be judged, and its
      // children cannot be reached either. It dies with the root.
      return
    }
    // Content nested deeper than one level inside the slot is already covered
    // by its own outermost ancestor, so the walk does not re-enter it.
    if (inSlot) return
    for (const child of liveChildren(node)) {
      walk(child, type === 'SLOT')
    }
  }
  walk(root, false)
  return out
}

/**
 * Remove everything `slotContentIn` found, and answer what actually went.
 *
 * A refusal is expected and is NOT an error: the master's own slot content is
 * a mirror Figma will not let anyone remove on its own, and the instance's
 * removal a moment later takes it. Only what really left is reported, so the
 * reply never claims a deletion that did not happen (T7).
 */
export const removeSlotContent = (
  root: LiveNode,
): RemovedNode[] => {
  const removed: RemovedNode[] = []
  for (const node of slotContentIn(root)) {
    // Read the identity BEFORE the removal: a removed node answers nothing.
    let named: RemovedNode | undefined
    try {
      named = {
        id: idOf(node) ?? '(unreadable node)',
        name: String((node as { name?: unknown }).name),
        type: String((node as { type?: unknown }).type),
      }
    } catch {
      named = undefined
    }
    try {
      const remove = (node as { remove?: unknown }).remove
      if (typeof remove !== 'function') continue
      ;(remove as () => void).call(node)
    } catch {
      // Figma refused: a master mirror, or a handle that answers nothing.
      continue
    }
    if (named !== undefined) {
      removed.push(named)
    }
  }
  return removed
}

/**
 * What the reply says about the content a delete took with it.
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule
 * (resolve-node.ts).
 */
export const slotContentRemovedMessage = (
  removed: readonly RemovedNode[],
): string => {
  const named = removed
    .slice(0, NAMED_IN_WARNING)
    .map(n => n.name + ' (' + n.id + ')')
    .join(', ')
  const rest = removed.length - NAMED_IN_WARNING
  return (
    'delete_node: removed ' +
    removed.length +
    ' node(s) held in this node’s slot(s) — ' +
    named +
    (rest > 0 ? ' and ' + rest + ' more' : '') +
    '. Figma leaves slot content behind when its instance goes, re-homed ' +
    'into the parent under an address that no longer resolves, so it renders ' +
    'and no tool can reach it. Reparent content out of the slot before ' +
    'deleting if you meant to keep it.'
  )
}
