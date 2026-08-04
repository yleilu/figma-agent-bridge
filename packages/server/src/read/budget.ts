// budget.ts — token-budget estimation and BFS fill algorithm.
//
// estimateTokens counts the WHOLE subtree of a node (children included)
// because JSON.stringify is recursive — this is intentional for budget-fill
// decisions where you need to know the total cost of including a subtree.
//
// For shallow-cost decisions (should we include THIS node without its
// children?), callers should serialize a shallow copy (children removed)
// before calling estimateTokens.

import type {
  NodeSpec,
  NodeSpecOrStub,
  IdStub,
} from '@figma-agent-bridge/shared/node-spec'
import type {
  TreeResult,
  TruncationReceipt,
} from '@figma-agent-bridge/shared/read-model'

/** Heuristic: estimate the token cost of a node (whole subtree). */
export const estimateTokens = (n: NodeSpecOrStub): number =>
  Math.ceil(JSON.stringify(n).length / 4)

/** Convert a full NodeSpec to an IdStub (depth/budget collapse). */
const toStub = (n: NodeSpec): IdStub => ({
  id: n.id ?? '',
  name: n.name ?? '',
  type: n.type,
  size: n.size ?? [0, 0],
  childCount: n.children?.length ?? 0,
})

/** Type guard: a NodeSpecOrStub is an IdStub if it has a numeric childCount. */
const isStub = (n: NodeSpecOrStub): n is IdStub =>
  typeof (n as IdStub).childCount === 'number'

/**
 * BFS fill: include nodes level-by-level until the budget cap is reached.
 * Nodes that cannot fit (adding their shallow cost would exceed the budget)
 * are collapsed to IdStub and recorded in the TruncationReceipt.
 *
 * The returned view is HARD-bounded by `budget`: every emitted node — whether
 * a full NodeSpec or a collapsed IdStub — is charged against `remaining`
 * (`estimateTokens` of its serialized shallow form). A stub still costs tokens
 * once serialized into the view, so it is charged just like a full node. When
 * even the cheapest stub no longer fits, individual stubs stop being emitted;
 * such overflow nodes are dropped from the view but still recorded in the
 * receipt so the agent knows what it didn't get. This guarantees
 * `estimateTokens(view) <= budget` even for very wide levels.
 *
 * Omitted slots are marked with an OMIT sentinel and compacted out of each
 * children array before the view is returned (indices used by queued siblings
 * stay stable until compaction).
 */
const OMIT = Symbol('omit')

export const fillToBudget = (
  root: NodeSpec,
  budget: number,
): TreeResult => {
  const truncated: TruncationReceipt = []

  // Shallow cost of root (without children): clone and remove children
  const rootNoChildren: NodeSpecOrStub = Object.fromEntries(
    Object.entries(root).filter(([k]) => k !== 'children'),
  ) as NodeSpecOrStub
  const rootCost = estimateTokens(rootNoChildren)

  if (rootCost > budget) {
    // Even root alone exceeds budget — return stub for root. Only record a
    // receipt entry when the stub has a real id: the synthetic SELECTION
    // forest root carries no id, and a `{id:''}` entry is non-drillable,
    // contradicting the "every receipt id is real" invariant.
    const stub = toStub(root)
    if (stub.id) {
      truncated.push({
        id: stub.id,
        childCount: stub.childCount,
      })
    }
    return { view: stub, truncated }
  }

  // Track remaining budget as we include nodes
  let remaining = budget - rootCost

  // Serialization framing is NOT free: each emitted child also costs the
  // `,"children":[…]` wrapper on its parent plus the `,` separators between
  // siblings, none of which appear in the bare node/stub objects we charge
  // below. We fold this into a small, conservative per-emission overhead so
  // `estimateTokens(view)` stays within budget rather than just the sum of
  // the bare objects.
  const FRAMING_TOKENS = 4 // amortizes `,"children":[]` + element separator

  // BFS queue: pairs of (nodeSpec, mutableParentChildren array to fill)
  type QueueItem = {
    node: NodeSpec
    parentChildrenSlot: NodeSpecOrStub[]
    slotIndex: number
  }

  // Build a mutable shallow copy of root
  const rootClone: NodeSpec = { ...root, children: [] }
  const view: NodeSpec = rootClone

  const queue: QueueItem[] = []

  // A stub that arrived already-stubbed (an earlier depth pass made it) is
  // still bytes in the response, so it must be charged like anything else —
  // otherwise a pre-stubbed tree escapes the cap entirely. It is NOT re-added
  // to the receipt: whichever pass stubbed it already recorded it. When it
  // does not fit it is dropped, exactly like a stub we create ourselves.
  const admitExistingStub = (
    stub: NodeSpecOrStub,
    into: NodeSpecOrStub[],
  ): void => {
    const cost = estimateTokens(stub) + FRAMING_TOKENS
    if (cost <= remaining) {
      remaining -= cost
      into.push(stub)
    }
  }

  // Enqueue root's children
  if (root.children && root.children.length > 0) {
    for (const child of root.children) {
      if (isStub(child)) {
        admitExistingStub(child, rootClone.children!)
      } else {
        // child is NodeSpec after isStub check narrows the union
        rootClone.children!.push(child)
        queue.push({
          node: child,
          parentChildrenSlot: rootClone.children!,
          slotIndex: rootClone.children!.length - 1,
        })
      }
    }
  }

  while (queue.length > 0) {
    const { node, parentChildrenSlot, slotIndex } =
      queue.shift()!

    // Calculate shallow cost of this node (without its children)
    const nodeNoChildren: NodeSpecOrStub =
      Object.fromEntries(
        Object.entries(node).filter(
          ([k]) => k !== 'children',
        ),
      ) as NodeSpecOrStub
    const nodeCost = estimateTokens(nodeNoChildren)

    // Emission is charged atomically as (object cost + framing). Prefer the
    // full node; if it won't fit, fall back to a stub (which is also charged
    // — a stub still costs tokens once serialized into the view); if even the
    // stub won't fit, omit the slot entirely (dropped from the view but still
    // recorded in the receipt). This keeps `estimateTokens(view) <= budget`.
    const fullEmissionCost = nodeCost + FRAMING_TOKENS

    if (fullEmissionCost > remaining) {
      // Cannot afford the full node — try a stub.
      const stub = toStub(node)
      const stubEmissionCost =
        estimateTokens(stub) + FRAMING_TOKENS
      if (stubEmissionCost <= remaining) {
        remaining -= stubEmissionCost
        parentChildrenSlot[slotIndex] = stub
      } else {
        // Mark for compaction; the slot is dropped from the final view.
        ;(parentChildrenSlot as unknown[])[slotIndex] = OMIT
      }
      truncated.push({
        id: stub.id,
        childCount: stub.childCount,
      })
    } else {
      // Include this node (object + framing both fit).
      remaining -= fullEmissionCost
      const nodeClone: NodeSpec = { ...node, children: [] }
      parentChildrenSlot[slotIndex] = nodeClone

      // Enqueue children
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          if (isStub(child)) {
            admitExistingStub(child, nodeClone.children!)
          } else {
            // child is NodeSpec after isStub check narrows the union
            nodeClone.children!.push(child)
            queue.push({
              node: child,
              parentChildrenSlot: nodeClone.children!,
              slotIndex: nodeClone.children!.length - 1,
            })
          }
        }
      }

      // If node has no children, remove the empty array
      if (nodeClone.children!.length === 0) {
        delete nodeClone.children
      }
    }
  }

  // Compact OMIT sentinels out of every children array, then drop any
  // now-empty children arrays. Done as a final pass because a node's slot
  // may be omitted only after that node's parent was already processed.
  const compact = (n: NodeSpecOrStub): void => {
    const kids = (n as NodeSpec).children
    if (!kids) {
      return
    }
    const kept = kids.filter(c => (c as unknown) !== OMIT)
    if (kept.length === 0) {
      delete (n as NodeSpec).children
      return
    }
    ;(n as NodeSpec).children = kept
    for (const c of kept) {
      compact(c)
    }
  }
  compact(view)

  return { view, truncated }
}
