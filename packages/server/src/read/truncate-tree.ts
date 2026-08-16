// truncate-tree.ts — depth-based tree truncation with TruncationReceipt.
//
// Implements D4 default semantics:
//   budget given → delegates to fillToBudget
//   no budget AND no depth → depth = 0
//   depth = -1 → return all (complete tree, empty receipt)
//   depth = N >= 0 → keep N full levels below root (root is level 0)

import type {
  NodeSpec,
  NodeSpecOrStub,
  IdStub,
} from '@figma-agent-bridge/shared/node-spec'
import type {
  TreeResult,
  TruncationReceipt,
} from '@figma-agent-bridge/shared/read-model'
import { fillToBudget } from './budget'

/**
 * Type guard: a NodeSpecOrStub is an IdStub if it has a numeric childCount.
 * NodeSpec has no `childCount` field, so this is a reliable discriminator.
 */
export const isStub = (n: NodeSpecOrStub): n is IdStub =>
  typeof (n as IdStub).childCount === 'number'

/**
 * Convert a full NodeSpec to an IdStub for collapse at a depth boundary.
 * Records the direct child count so the agent knows how many nodes are hidden.
 *
 * `size` is carried, never invented: a node with none (a PAGE) keeps none, and
 * the `[0, 0]` this used to pad with was a dimension the file does not hold
 * (B26/B51).
 */
export const toStub = (n: NodeSpec): IdStub => ({
  id: n.id ?? '',
  name: n.name ?? '',
  type: n.type,
  ...(n.size !== undefined ? { size: n.size } : {}),
  childCount: n.children?.length ?? 0,
})

/**
 * Record a node this pass COLLAPSED to a stub.
 *
 * The receipt names what was CUT and never what was RETURNED (tool-surface.md —
 * "names exactly which subtrees were cut and how big, so 'continue' = 'drill
 * into id X'"). A collapse returns the node and cuts its SUBTREE, so a
 * collapsed leaf cut nothing: the stub is in the view, drilling into it yields
 * no further level, and an entry for it is loss that did not happen. A depth-1
 * frame read used to list every instance sublayer it had already inlined, each
 * with `childCount: 0`.
 *
 * `childCount` is the discriminator HERE only because a collapse is the one
 * case where the node comes back and its subtree does not. A node that is
 * DROPPED from the view is cut outright, and the budget pass names that one
 * whatever its childCount (read/budget.ts).
 */
const recordCut = (
  truncated: TruncationReceipt,
  stub: IdStub,
): void => {
  if (stub.childCount > 0) {
    truncated.push({
      id: stub.id,
      childCount: stub.childCount,
    })
  }
}

/**
 * Truncate a tree by depth.
 * depth = N means: keep root + N levels of full children below it.
 * Children at exactly level N+1 are collapsed to IdStub.
 */
const truncateByDepth = (
  root: NodeSpec,
  depth: number,
): TreeResult => {
  if (depth === -1) {
    // Return complete tree untouched
    return { view: root, truncated: [] }
  }

  const truncated: TruncationReceipt = []

  const truncateNode = (
    node: NodeSpec,
    remainingDepth: number,
  ): NodeSpec => {
    if (
      remainingDepth === 0 ||
      !node.children ||
      node.children.length === 0
    ) {
      // Collapse children to stubs at this boundary
      if (node.children && node.children.length > 0) {
        const stubbedChildren: NodeSpecOrStub[] =
          node.children.map(child => {
            // Already a stub — the PLUGIN drew this boundary (a page read at
            // depth 0 does not serialize its children's subtrees). Nothing has
            // recorded it yet: this is the FIRST pass over the tree, and the
            // budget pass after it never records a stub it was handed. So the
            // cut is recorded here, or `truncated: []` claims a completeness
            // the read does not have (B51).
            const stub = isStub(child)
              ? child
              : toStub(child)
            recordCut(truncated, stub)
            return stub
          })
        return { ...node, children: stubbedChildren }
      }
      return node
    }

    // Recurse into children with reduced depth
    const processedChildren: NodeSpecOrStub[] =
      node.children.map(child => {
        if (isStub(child)) {
          // A plugin-drawn boundary INSIDE the requested depth: the level was
          // asked for and not delivered, so it is a cut like any other.
          recordCut(truncated, child)
          return child
        }
        // child is NodeSpec after isStub narrows the union
        return truncateNode(child, remainingDepth - 1)
      })

    return { ...node, children: processedChildren }
  }

  const view = truncateNode(root, depth)
  return { view, truncated }
}

/**
 * The always-on response cap (tool-surface.md:155, D4). Omitting `budget`
 * SELECTS this — it is never a request for an unbounded read.
 */
export const DEFAULT_BUDGET = 20_000

/**
 * Truncate a NodeSpec tree by depth, then cap it at the budget.
 *
 * Depth chooses WHERE truncation lands; the budget decides WHETHER it
 * happens. The two compose rather than replace each other, so no combination
 * of arguments returns an unbounded tree (T10).
 *
 * Semantics:
 *   - neither → depth 0 (root only, children stubbed), capped
 *   - depth = N >= 0 → N full levels below root, then capped
 *   - depth = -1 → every level, then capped
 *   - budget only → as deep as fits that budget (depth -1 + explicit cap)
 */
export const truncateTree = (
  root: NodeSpec,
  opts: { depth?: number; budget?: number },
): TreeResult => {
  // A budget with no depth means "as deep as fits", so it cannot fall back
  // to the bare depth-0 default the no-argument case uses.
  const depth =
    opts.depth ?? (opts.budget !== undefined ? -1 : 0)
  const budget = opts.budget ?? DEFAULT_BUDGET

  const byDepth = truncateByDepth(root, depth)
  const capped = fillToBudget(byDepth.view, budget)
  return {
    view: capped.view,
    truncated: [...byDepth.truncated, ...capped.truncated],
  }
}
