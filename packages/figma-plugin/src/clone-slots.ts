// clone-slots.ts — what a clone of a slot-filled INSTANCE does not get (B88).
//
// `instance.clone()` copies the instance. It does NOT copy what was appended
// into the instance's SLOTs, so the clone renders an empty card where the
// source renders a filled one. Live, 2026-09-02:
//
//   create_component  → a component with a `Body` SLOT
//   create_node       → an INSTANCE of it
//   create_tree       → a frame INTO the slot
//   clone_node        → the clone shows NO slot content
//   get_node depth:2  → PLUGIN_ERROR: cannot read property 'indexOf' of
//                       undefined
//
// Two aspects, and the row already suspected one cause: a clone whose slot
// half is missing is a node the read then has to describe, and the read died
// on it. Filling the slot removes the state the read tripped on. The read face
// is hardened on its own besides — an enrichment that throws must not cost a
// document the export already produced.
//
// THE PLAN IS A DIFFERENCE, never a copy. Where Figma DID carry the content
// over there is nothing missing and nothing is appended, so this is a no-op on
// a runtime that behaves — which is the only safe shape for a repair whose
// trigger is a runtime behaviour nobody can pin from a typing.
//
// PAIRED BY POSITION, not by id. A clone's ids are all new, and the ids inside
// a slot are exactly the ones that disagree between the live tree and the file
// (canonical-ids.ts). Position is the one correspondence a clone preserves.
//
// Structural (`Record<string, unknown>`), so it is testable without a Figma
// runtime — `code.ts` cannot be imported outside Figma.

import { liveChildren } from './canonical-ids'
import type { LiveNode } from './canonical-ids'

/** One slot in the CLONE, and the source children it did not receive. */
export type SlotFill = {
  /** Child indices from the clone root down to the slot. */
  path: number[]
  /** The SOURCE nodes to copy in, in order. */
  missing: LiveNode[]
}

/** The node at `path`, or undefined when the walk falls off the tree. */
export const nodeAt = (
  root: LiveNode,
  path: readonly number[],
): LiveNode | undefined => {
  let current: LiveNode | undefined = root
  for (const index of path) {
    if (current === undefined) return undefined
    current = liveChildren(current)[index]
  }
  return current
}

/**
 * Whether a node says it is a SLOT, guarded.
 *
 * A handle that will not say what it is cannot be judged, and a clone repair
 * must never be the thing that fails a clone.
 */
const isSlot = (node: LiveNode): boolean => {
  try {
    return (node as { type?: unknown }).type === 'SLOT'
  } catch {
    return false
  }
}

/**
 * Every slot the clone is short, against the source it was cloned from.
 *
 * The walk stops descending at a SLOT: content nested deeper is carried by its
 * own outermost ancestor, exactly as `slotContentIn` (slot-content.ts) reasons
 * about the delete side of the same fact.
 *
 * A slot that already holds as many children as the source is skipped. So is
 * one that holds MORE — that is the master's own default content plus
 * something, and guessing which entries are which would put a node in the
 * wrong place.
 */
export const slotFillPlan = (
  source: LiveNode,
  clone: LiveNode,
): SlotFill[] => {
  const out: SlotFill[] = []
  const walk = (
    src: LiveNode,
    dst: LiveNode,
    path: number[],
  ): void => {
    if (isSlot(src) && isSlot(dst)) {
      const srcKids = liveChildren(src)
      const dstKids = liveChildren(dst)
      if (srcKids.length > dstKids.length) {
        out.push({
          path: [...path],
          missing: srcKids.slice(dstKids.length),
        })
      }
      return
    }
    const srcKids = liveChildren(src)
    const dstKids = liveChildren(dst)
    // A shape disagreement outside a slot is not this pass's business: pairing
    // past it would compare unrelated nodes, and appending on that comparison
    // is how a repair becomes a corruption.
    if (srcKids.length !== dstKids.length) return
    for (let i = 0; i < srcKids.length; i += 1) {
      walk(srcKids[i], dstKids[i], [...path, i])
    }
  }
  walk(source, clone, [])
  return out
}

/**
 * What the reply says about the slot content a clone had to be given.
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule
 * (resolve-node.ts). It is a `warnings[]` line rather than silence because a
 * clone that needed repairing is a fact about the runtime the caller is
 * building on, and the next tool release may not need to do it.
 */
export const slotContentClonedMessage = (
  count: number,
): string =>
  'clone_node: Figma did not carry ' +
  count +
  ' node(s) of slot content onto the clone, so they were copied in. The ' +
  'clone now matches the source; its slot content has NEW ids, which the ' +
  'clone’s own read emits.'

/**
 * …and what it says when the copy itself could not be made.
 *
 * Naming the shortfall matters more than the count: a clone that silently
 * renders an empty card is the defect, and a clone that says it is short is a
 * caller's decision to make.
 */
export const slotContentNotClonedMessage = (
  count: number,
): string =>
  'clone_node: ' +
  count +
  ' node(s) of slot content could not be copied onto the clone, so the clone ' +
  'renders an EMPTY slot where the source renders content. Build the content ' +
  'into the clone’s slot directly (create_tree with the slot as parentId).'
