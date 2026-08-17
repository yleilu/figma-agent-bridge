// resolve-node.ts — one caller-supplied node id → one live handle.
//
// A read emits the id the EXPORT gives a node (canonical-ids.ts). A resolve
// therefore has to accept that id, because it is the only one the agent holds.
// Two id families reach here, and they behave differently:
//
//   MASTER-DERIVED  `I<inst>;<local>` — a sublayer Figma itself composes. The
//                   live handle answers exactly this id, so a walk finds it.
//   SLOT-OVERRIDE   `I<inst>;<slot>;<local>` and deeper — content written into
//                   a component SLOT. Figma does not re-home it, so the live
//                   handle answers a PLAIN alias id and the walk finds nothing.
//
// Segment count is a symptom of that split, not the rule. A 2-segment id
// resolved and a 3-segment id did not, because everything under a slot is
// override content (B53). The alias is not arithmetic on the canonical id
// either: live `305:8898` is exported as `…;305:8902`, and the offset differs
// per node.
//
// So the walk cannot be the whole answer, and the EXPORT is the only oracle
// both sides share. On a miss this module exports the leading INSTANCE once and
// pairs it with its live subtree — the same pairing the read face and search
// already run — then answers from that pairing.
//
// The export is cached per INSTANCE for the length of one dispatch. A 20-id
// `get_nodes` over one card therefore pays for one export, not twenty. The
// cache is deliberately NOT longer-lived: a write in a later command may add or
// remove nodes, and a resolver that answers from a stale export would hand back
// a handle the file no longer holds.
//
// Structural on both sides (`Record<string, unknown>`), so it is testable
// without a Figma runtime.

import {
  idOf,
  indexByCanonicalId,
  liveChildren,
  type IdentityIndex,
  type LiveNode,
  type RawNode,
} from './canonical-ids'

/**
 * The instance id a COMPOUND id leads with, or undefined for a plain id.
 *
 * `I<instanceId>;<...>` — the instance id sits between the `I` and the first
 * `;`. A lone `I` prefix with nothing before the separator is not one.
 */
export const leadingInstanceId = (
  nodeId: string,
): string | undefined => {
  const sep = nodeId.indexOf(';')
  return nodeId.startsWith('I') && sep > 1
    ? nodeId.slice(1, sep)
    : undefined
}

/**
 * The node in `root`'s subtree whose LIVE id is `id`, or undefined.
 *
 * Every read is guarded (`idOf`, `liveChildren`): one stale handle inside the
 * subtree must not cost the search for a healthy node beside it.
 */
export const findLiveById = (
  root: LiveNode,
  id: string,
): LiveNode | undefined => {
  const stack: LiveNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as LiveNode
    if (idOf(node) === id) return node
    for (const child of liveChildren(node)) {
      stack.push(child)
    }
  }
  return undefined
}

export type ResolveDeps = {
  /** `figma.getNodeByIdAsync`, which only ever answers a PLAIN id reliably. */
  getNodeById: (id: string) => Promise<LiveNode | null>
  /** The JSON_REST_V1 document for a node, or undefined when it refuses. */
  exportOf: (node: LiveNode) => Promise<RawNode | undefined>
}

export type NodeResolver = {
  /** Drop every cached export. Called once per dispatch. */
  reset: () => void
  /** The live handle `nodeId` names, or null. */
  resolve: (nodeId: string) => Promise<LiveNode | null>
  /**
   * What the export says about `nodeId`, for a node whose live handle cannot
   * describe itself. Undefined for a plain id — that node answers its own read.
   */
  exportedNode: (nodeId: string) => Promise<RawNode | undefined>
}

export const createNodeResolver = (
  deps: ResolveDeps,
): NodeResolver => {
  // instance id → its paired index. The PROMISE is cached, not the result, so
  // concurrent entries of one `get_nodes` share a single export.
  const indexes = new Map<
    string,
    Promise<IdentityIndex | undefined>
  >()

  const indexFor = (
    instanceId: string,
    known?: LiveNode,
  ): Promise<IdentityIndex | undefined> => {
    const cached = indexes.get(instanceId)
    if (cached !== undefined) return cached
    const built = (async (): Promise<
      IdentityIndex | undefined
    > => {
      const instance =
        known ?? (await deps.getNodeById(instanceId))
      if (instance === null || instance === undefined) {
        return undefined
      }
      let exported: RawNode | undefined
      try {
        exported = await deps.exportOf(instance)
      } catch {
        // An instance that cannot export itself is not an error here — it just
        // has no oracle, so the resolve falls back to "not found".
        return undefined
      }
      if (exported === undefined) return undefined
      return indexByCanonicalId(instance, exported, -1)
    })()
    indexes.set(instanceId, built)
    return built
  }

  return {
    reset: () => {
      indexes.clear()
    },
    resolve: async (nodeId: string) => {
      const instanceId = leadingInstanceId(nodeId)
      if (instanceId === undefined) {
        return deps.getNodeById(nodeId)
      }
      const instance = await deps.getNodeById(instanceId)
      if (instance === null) return null
      // The cheap half first: a master-derived sublayer answers its own
      // compound id, so one guarded walk finds it and nothing is exported.
      const direct = findLiveById(instance, nodeId)
      if (direct !== undefined) return direct
      const index = await indexFor(instanceId, instance)
      return index?.live.get(nodeId) ?? null
    },
    exportedNode: async (nodeId: string) => {
      const instanceId = leadingInstanceId(nodeId)
      if (instanceId === undefined) return undefined
      const index = await indexFor(instanceId)
      return index?.exported.get(nodeId)
    },
  }
}
