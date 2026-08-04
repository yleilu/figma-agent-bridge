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
 */
export const toStub = (n: NodeSpec): IdStub => ({
  id: n.id ?? '',
  name: n.name ?? '',
  type: n.type,
  size: n.size ?? [0, 0],
  childCount: n.children?.length ?? 0,
})

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
            if (isStub(child)) {
              // Already a stub — keep, do NOT re-add to receipt
              return child
            }
            // child is NodeSpec after isStub narrows the union
            const stub = toStub(child)
            truncated.push({
              id: stub.id,
              childCount: stub.childCount,
            })
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
          // Already a stub — keep as is, do not re-add to receipt
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
