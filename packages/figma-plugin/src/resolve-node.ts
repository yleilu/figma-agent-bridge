// resolve-node.ts — one caller-supplied node id → one live handle.
//
// A read emits the id the EXPORT gives a node (canonical-ids.ts). A resolve
// therefore has to accept that id, because it is the only one the agent holds.
//
// WHETHER A LIVE HANDLE ANSWERS ITS CANONICAL ID IS A PROPERTY OF SESSION
// STATE, NOT OF THE ID'S SHAPE. Content written into a component SLOT can
// answer a PLAIN pre-append id instead — live `305:8898` where the export says
// `…;305:8902`, and the offset differs per node, so the alias is not arithmetic
// on the canonical id. The same node, at the same depth, answered its canonical
// id after a reload. Both states are real and this module must serve both:
//
//   the handle ANSWERS  — a walk finds it, and the read is complete. This is
//                         every plain and master-derived id, and slot content
//                         whose ids the session has re-homed.
//   the handle REFUSES  — nothing in the live tree carries that id, so the walk
//                         returns nothing however long it looks.
//
// Segment count does not predict which state a node is in. It only correlates:
// the B53 transcript's failures were all slot-override ids, and a slot-hosted
// chip on the same build resolved fine. A resolver keyed on live ids is
// therefore unreliable BY CONSTRUCTION — it works on some slot content and not
// other slot content, with no rule a caller can hold.
//
// The EXPORT is stable, and it is the oracle both sides share. So the walk
// stays as the cheap first half, and on a miss this module exports the leading
// INSTANCE once and pairs it with its live subtree — the same pairing the read
// face and search already run — then answers from that pairing.
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

/**
 * How many INSTANCES one dispatch may export.
 *
 * The per-instance bound was never the open one. One dispatch can name ids
 * under any number of DIFFERENT instances — `nodeIds` carries no cap, and
 * `search` hydrates a result page with a `get_nodes` over up to `limit` ids
 * (50 by default) — so an uncapped resolver could spend N whole-subtree exports
 * on one command and hit the dispatch timeout. That is the B34 failure this
 * batch exists to remove, arriving by a new road.
 *
 * 25 is deliberately generous rather than tight. The budget exists to bound a
 * pathological shape, not to ration a real one: the QA run's worst case was 12
 * broken rows across 3 cards, and only a SLOT-override id costs an export at
 * all — the walk answers a plain or master-derived id for free, however many
 * of them a call names.
 */
export const MAX_INSTANCE_EXPORTS = 25

/**
 * What a caller is told when the budget stops a resolve.
 *
 * Exported so the message has ONE author: a test asserting the degrade and the
 * code producing it cannot drift apart.
 */
export const exportBudgetMessage = (
  nodeId: string,
  cap: number,
): string =>
  'Cannot resolve ' +
  nodeId +
  ': it lives inside an instance this command has not read yet, and the ' +
  'command has already exported ' +
  cap +
  ' instances (the per-command budget). Ask for fewer ids at a time, or group ' +
  'the ids that share an instance into one call.'

/**
 * Make a DEGRADED read declare itself.
 *
 * A node served from its ancestor's export carries what the file holds and not
 * what only a live read adds — `style()` names, the unrotated size, text runs,
 * vector point detail, `component.key`. The enrichment names the failure itself
 * when a handle is what broke. When there is no handle to fail, nothing else
 * does, and the row comes back looking complete while quietly missing those
 * fields.
 *
 * That is the defect B53 IS — a reply that reports success and returns less than
 * it claims — so a fix for it must not introduce one. Loud incompleteness beats
 * quiet incompleteness, and a pre-existing failure is never overwritten: the
 * enrichment's own message is more specific than this one.
 */
export const declareDegradedRead = (
  doc: Record<string, unknown>,
  reason: string,
): void => {
  if (
    doc.readError === undefined &&
    doc.readErrors === undefined
  ) {
    doc.readError = reason
  }
}

/** What a row says when only the export could describe it. */
export const slicedReadMessage = (
  nodeId: string,
): string =>
  'no live handle answered ' +
  nodeId +
  '; this node is served from its ancestor instance’s export, without the ' +
  'fields only a live read can supply'

export type ResolveDeps = {
  /** `figma.getNodeByIdAsync`, which only ever answers a PLAIN id reliably. */
  getNodeById: (id: string) => Promise<LiveNode | null>
  /** The JSON_REST_V1 document for a node, or undefined when it refuses. */
  exportOf: (node: LiveNode) => Promise<RawNode | undefined>
  /** Override the export budget. Tests set it low; the plugin takes the default. */
  maxExports?: number
}

export type NodeResolver = {
  /** Drop every cached export. Called once per dispatch. */
  reset: () => void
  /**
   * The live handle `nodeId` names, or null.
   *
   * THROWS when the export budget stops it — never returns null for that. A
   * budget refusal is not "no such node", and a caller that cannot tell the two
   * apart would report a node as missing because the command was busy. Every
   * entry runs inside the dispatch guard, and `get_nodes` catches per id, so the
   * throw lands as that id's own error (B39).
   */
  resolve: (nodeId: string) => Promise<LiveNode | null>
  /**
   * What the export says about `nodeId`, for a node whose live handle cannot
   * describe itself. Undefined for a plain id — that node answers its own read.
   *
   * Throws on the budget, for the same reason `resolve` does.
   */
  exportedNode: (nodeId: string) => Promise<RawNode | undefined>
}

export const createNodeResolver = (
  deps: ResolveDeps,
): NodeResolver => {
  const maxExports =
    deps.maxExports ?? MAX_INSTANCE_EXPORTS
  // instance id → its paired index. The PROMISE is cached, not the result, so
  // concurrent entries of one `get_nodes` share a single export.
  const indexes = new Map<
    string,
    Promise<IdentityIndex | undefined>
  >()

  /**
   * Would resolving inside this instance need a NEW export we cannot afford?
   *
   * An instance already in the map costs nothing more, however many ids name
   * it — which is the whole point of the cache, and why the budget counts
   * INSTANCES rather than ids.
   */
  const overBudget = (instanceId: string): boolean =>
    !indexes.has(instanceId) &&
    indexes.size >= maxExports

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
      // Nothing here is budgeted — the walk is free, so a call naming a
      // thousand ordinary sublayers is unaffected by the cap below.
      const direct = findLiveById(instance, nodeId)
      if (direct !== undefined) return direct
      if (overBudget(instanceId)) {
        throw new Error(
          exportBudgetMessage(nodeId, maxExports),
        )
      }
      const index = await indexFor(instanceId, instance)
      return index?.live.get(nodeId) ?? null
    },
    exportedNode: async (nodeId: string) => {
      const instanceId = leadingInstanceId(nodeId)
      if (instanceId === undefined) return undefined
      if (overBudget(instanceId)) {
        throw new Error(
          exportBudgetMessage(nodeId, maxExports),
        )
      }
      const index = await indexFor(instanceId)
      return index?.exported.get(nodeId)
    },
  }
}
