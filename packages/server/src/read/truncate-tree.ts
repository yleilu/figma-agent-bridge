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
 * Truncate a NodeSpec tree according to depth and/or budget options.
 *
 * Semantics:
 *   - budget given → level-fill BFS (delegates to fillToBudget)
 *   - no budget AND no depth → depth = 0 (root only, children stubbed)
 *   - depth = -1 → complete tree returned, empty receipt
 *   - depth = N >= 0 → N full levels below root; excess stubbed + receipted
 */
export const truncateTree = (
  root: NodeSpec,
  opts: { depth?: number; budget?: number },
): TreeResult => {
  if (opts.budget !== undefined) {
    return fillToBudget(root, opts.budget)
  }

  const depth = opts.depth ?? 0
  return truncateByDepth(root, depth)
}
