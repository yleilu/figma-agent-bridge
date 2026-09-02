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
 * Every node in `root`'s subtree whose LIVE id is `id`, SHALLOWEST FIRST.
 *
 * BREADTH-FIRST, and that is the whole point (B93). The walk used to run off a
 * stack, which descends the LAST child's subtree before the first child — so on
 * a repeated id it answered with a node at an arbitrary depth. An instance of X
 * placed inside a SLOT of another instance of X shares every local id with its
 * host, so the repeat is not hypothetical: the page enumerated the nested
 * copy's chain in the host's place, and `clone_node` on the host answered with
 * the nested copy's clone. With two DIFFERENT components none of it happens,
 * which is what made it invisible until a two-arm discriminator ran.
 *
 * `limit` stops the walk early: a caller that only needs to know whether the id
 * is AMBIGUOUS asks for two.
 *
 * Every read is guarded (`idOf`, `liveChildren`): one stale handle inside the
 * subtree must not cost the search for a healthy node beside it.
 */
export const findLiveMatches = (
  root: LiveNode,
  id: string,
  limit = Number.POSITIVE_INFINITY,
): LiveNode[] => {
  const found: LiveNode[] = []
  const queue: LiveNode[] = [root]
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]
    if (idOf(node) === id) {
      found.push(node)
      if (found.length >= limit) return found
    }
    for (const child of liveChildren(node)) {
      queue.push(child)
    }
  }
  return found
}

/**
 * The node in `root`'s subtree whose LIVE id is `id`, or undefined.
 *
 * The SHALLOWEST one when more than one answers — the same rule
 * `indexByCanonicalId` states, and the one a caller means. A caller that has to
 * KNOW there were two asks `findLiveMatches`.
 */
export const findLiveById = (
  root: LiveNode,
  id: string,
): LiveNode | undefined => findLiveMatches(root, id, 1)[0]

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

/**
 * What a row says when only the export could describe it.
 *
 * Two callers, one loss, one wording. `readNodeDocument` slices a WHOLE read
 * out of an ancestor export; `collectOne` (enrich-nodes.ts) reaches one node
 * the live walk stopped short of, inside an otherwise live read (B41). The
 * node is served the same way in both, so it says the same thing — the id
 * names which node, and the reader never has to learn two spellings of one
 * fact.
 */
export const slicedReadMessage = (nodeId: string): string =>
  'no live handle answered ' +
  nodeId +
  '; this node is served from an ancestor’s export, without the ' +
  'fields only a live read can supply — style() names, context, text runs, ' +
  'vector geometry and the unrotated size'

/**
 * What a row says when its live handle answered SOME reads and refused others
 * (B65).
 *
 * The third wording of one loss, and it exists because the loss is genuinely
 * a third shape: `slicedReadMessage` is "no handle at all", the enrichment's
 * `walkError` is "this node would not list its children", and this one is a
 * handle that answers its identity and refuses particular reads. Figma
 * composes such a handle's address off a pre-append id, and its own refusal
 * QUOTES that address — `I570:22243;570:20740`, two segments, naming no node
 * — so passing the raw message through hands the caller an id that resolves
 * to nothing. 580 rows carried one on the 2026-09-01 artifact.
 *
 * So the id here is the one the read EMITS for this node, which is the one a
 * caller can hand back, and the fields are named so the absence is a fact
 * about the read rather than a fact about the design.
 */
export const partialLiveReadMessage = (
  nodeId: string,
  fields: readonly string[],
): string =>
  'the live handle for ' +
  nodeId +
  ' refused ' +
  fields.join(', ') +
  ' — Figma composed its address from a pre-append id. Those fields are ' +
  'missing from this row; everything else on it is the file’s own. Read the ' +
  'enclosing INSTANCE (get_node, depth:-1) to see this node through a handle ' +
  'that answers.'

/**
 * What a row says when its live handle would not LIST ITS CHILDREN (B65).
 *
 * The fourth wording of one loss, and the last read path that was still
 * handing Figma's own sentence through. That sentence quotes the address
 * Figma composed off a pre-append id — `I571:32063;571:32007`, two segments —
 * and the address names no node: `get_node` on it answers *"does not exist"*.
 * 69 of the 300 readErrors on the 2026-09-02 artifact were this throw,
 * verbatim, while the row's own canonical id (four segments) resolved fine.
 *
 * So the id here is the one the read EMITS for this node, and what the row
 * lost is named rather than quoted. The children below it are not lost: the
 * pairing keeps walking the EXPORT, so each one arrives served from the
 * ancestor's export and says so in its own words.
 *
 * `fields` carries the property groups the same handle also refused, when it
 * refused any — one node, one sentence, rather than a refusal that hides
 * another.
 */
export const refusedChildrenMessage = (
  nodeId: string,
  fields: readonly string[] = [],
): string =>
  'the live handle for ' +
  nodeId +
  ' refused to list its children' +
  (fields.length > 0
    ? ', and refused ' + fields.join(', ')
    : '') +
  ' — Figma composed its address from a pre-append id. The children on this ' +
  'row come from the file’s own export, without the fields only a live read ' +
  'can supply. Read the enclosing INSTANCE (get_node, depth:-1) to see this ' +
  'subtree through a handle that answers.'

/**
 * How many ancestors an id walk will climb before it gives up.
 *
 * A Figma tree is a few dozen levels at worst. The bound is here so a cyclic or
 * self-referential fake cannot hang a dispatch — never as a real limit.
 */
const MAX_ANCESTOR_HOPS = 64

/**
 * The OUTERMOST INSTANCE a handle sits inside, or undefined for a node with no
 * instance above it.
 *
 * Guarded at every hop: reading `.parent` is a read of a live node, and the
 * handles this module exists for refuse exactly that. A refusal ends the walk
 * with what it has — "unknown" and "no instance" answer the same way here, and
 * the caller treats both as "do not claim an alias" (see `isAliasHandle`).
 */
export const outerInstanceOf = (
  node: LiveNode,
): string | undefined => {
  let outer: string | undefined
  let current: LiveNode = node
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    let parent: unknown
    try {
      parent = (current as { parent?: unknown }).parent
    } catch {
      return outer
    }
    if (typeof parent !== 'object' || parent === null) {
      return outer
    }
    const p = parent as LiveNode
    try {
      if (p.type === 'INSTANCE') {
        outer = idOf(p) ?? outer
      }
    } catch {
      return outer
    }
    current = p
  }
  return outer
}

/**
 * Whether a handle answers a PRE-APPEND id while living inside an INSTANCE —
 * the alias state canonical-ids.ts describes, seen from the live side.
 *
 * Figma composes an instance sublayer's id as `I<parent.id>;<local>`, so a node
 * under an INSTANCE answers a COMPOUND id. One that answers a plain `<n>:<m>`
 * there is content the append never re-homed, and every address Figma then
 * mints off it (`I<alias>;<leaf>`) names a node the file does not render.
 *
 * That is B74: a write to such an address returned `{ok:true, warnings:[]}`,
 * read back changed, and never reached the rendered node — ~60 lost writes.
 *
 * A handle that refuses its own reads is NOT called an alias. Its ancestry is
 * unknowable, and an unknown must not be reported as a finding.
 */
export const isAliasHandle = (node: LiveNode): boolean => {
  const id = idOf(node)
  if (id === undefined) return false
  if (leadingInstanceId(id) !== undefined) return false
  const outer = outerInstanceOf(node)
  if (outer === undefined) return false
  // B93 — an ancestor answering THIS NODE'S OWN id is an id collision, not an
  // alias. Same-component nesting produces one: an instance of X inside a slot
  // of another instance of X shares every local id with its host, and the gate
  // then refused a write with "its leading instance 581:100 is content inside
  // INSTANCE 581:100" — an accusation about a node against itself. An unknown
  // must never be reported as a finding, which is this predicate's own stated
  // law; the ambiguity is refused on its own terms by `shadowedByAncestor`.
  return outer !== id
}

/**
 * Whether some ANCESTOR of `node` answers the same id `node` does (B93).
 *
 * Two nodes answering one plain id is not a shape this surface can address its
 * way out of: `figma.getNodeByIdAsync` returns one of them and there is no
 * parameter that says which. It IS a shape this surface can SEE, from either
 * node, by walking up — and seeing it is enough, because a write that cannot
 * say which of two nodes it lands on must not be made.
 *
 * Live: `clone_node` on the host answered with the nested copy's clone.
 *
 * Guarded and bounded at every hop, like every other ancestor walk here.
 */
export const shadowedByAncestor = (
  node: LiveNode,
): boolean => {
  const id = idOf(node)
  if (id === undefined) return false
  let current: LiveNode = node
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    let parent: unknown
    try {
      parent = (current as { parent?: unknown }).parent
    } catch {
      return false
    }
    if (typeof parent !== 'object' || parent === null) {
      return false
    }
    const p = parent as LiveNode
    if (idOf(p) === id) return true
    current = p
  }
  return false
}

/**
 * Whether a handle is no longer part of the document (B94).
 *
 * Not a shape test and not an ancestry test — a direct question, and the only
 * one this class answers honestly. Figma RE-MINTS a node on the way into an
 * instance slot: a new node appears under the instance's chain and the handle
 * that went in is DROPPED. That handle keeps answering `id`, `name` and `type`,
 * so `update_node` on the id a staged create had just answered came back
 * `{id, name, warnings:[]}` and reached nothing. A phantom write, law 2.
 *
 * Two signals, either of which is conclusive:
 *
 *   `removed === true`   Figma's own answer for a node that is gone.
 *   `parent === null`    a scene node with no parent is not in any page. NULL,
 *                        never a THROW — a `.parent` that throws is the B81
 *                        class, which must NOT be refused up front (it cost 48
 *                        refused writes and bent a build's topology), and this
 *                        deliberately does not look at it.
 *
 * A PAGE and the DOCUMENT legitimately have no parent, so they are exempt.
 */
export const detachedFromDocument = (
  node: LiveNode,
): boolean => {
  try {
    if ((node as { removed?: unknown }).removed === true) {
      return true
    }
  } catch {
    return false
  }
  let type: unknown
  try {
    type = (node as { type?: unknown }).type
  } catch {
    return false
  }
  if (type === 'PAGE' || type === 'DOCUMENT') return false
  try {
    return (
      (node as { parent?: unknown }).parent === null &&
      'parent' in node
    )
  } catch {
    // The B81 class. Unknown is not a finding.
    return false
  }
}

/**
 * What a WRITE is told when its handle is no longer in the document (B94).
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule.
 */
export const droppedHandleMessage = (
  nodeId: string,
): string =>
  'Refusing to write to ' +
  nodeId +
  ': that id names a node Figma no longer holds. A node MOVED INTO an instance ' +
  'slot is re-minted — a new node appears under the instance’s own chain and ' +
  'the original handle is dropped — so an id read before such a move addresses ' +
  'nothing, and a write to it would be accepted and change nothing anyone can ' +
  'see. Read the enclosing INSTANCE (get_node, depth:-1) and address the node ' +
  'by the id that read emits.'

/**
 * What a WRITE is told when two live nodes answer one id (B93).
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule.
 */
export const ambiguousHandleMessage = (
  nodeId: string,
): string =>
  'Refusing to write to ' +
  nodeId +
  ': two nodes in this file answer that id, so no write can say which one it ' +
  'lands on. This happens when a component is nested inside ITSELF — an ' +
  'instance placed in a slot of another instance of the same component shares ' +
  'every local id with its host. Read the enclosing INSTANCE (get_node, ' +
  'depth:-1) and address the node by the id that read emits, which names its ' +
  'position in the chain; or make the nested one a different component.'

/**
 * Whether a live handle answers ANYTHING — the only thing a write may be
 * refused on BEFORE it is tried (B81).
 *
 * This probe used to read `parent` as well, and that over-rejected. `parent`
 * is a fact about the chain ABOVE a node: Figma composes an instance
 * sublayer's address from its parent's id, so a stale link anywhere up the
 * chain makes `.parent` throw on a node that is itself perfectly addressable.
 * A write touches the node, not its ancestry.
 *
 * The cost of asking the wrong question was measured. 48 live `PLUGIN_ERROR`
 * refusals in one 2026-09-02 build, none of which had tried a write; the
 * operator answered them by ordering every slot build-then-reparent and
 * FLATTENING the app shell so no slot nested more than one instance level
 * deep. A probe was dictating the component topology of builds.
 *
 * So the gate now asks only whether there is a handle here at all. A node that
 * refuses its own `type` answers nothing and can be refused for free; anything
 * else is PROVISIONAL — the write is attempted, and the refusal, if there is
 * one, is earned by a write that did not land (see `restatedRefusal`).
 */
export const handleAnswers = (node: LiveNode): boolean => {
  try {
    void (node as { type?: unknown }).type
    return true
  } catch {
    return false
  }
}

/**
 * Whether a handle will read its own `parent` — ADVISORY, never a write gate.
 *
 * It still discriminates: the B74 signature refuses it (*"in get_parent: The
 * node … does not exist"*, live 2026-08-30), and so does the 2026-09-02
 * read-back class that answers `id` and `type` and throws on `width`,
 * `getSharedPluginData` and `parent`. What it does NOT tell anyone is whether
 * a write lands, which is why its answer MARKS a handle rather than refusing
 * it.
 */
export const parentAnswers = (node: LiveNode): boolean => {
  try {
    void (node as { parent?: unknown }).parent
    return true
  } catch {
    return false
  }
}

/**
 * What a WRITE is told when its id was composed off an alias (B74).
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule.
 */
export const aliasAddressMessage = (
  nodeId: string,
  aliasId: string,
  outerInstanceId: string,
): string =>
  'Refusing to write to ' +
  nodeId +
  ': its leading instance ' +
  aliasId +
  ' is content inside INSTANCE ' +
  outerInstanceId +
  ' that still answers its pre-append id, so ' +
  nodeId +
  ' addresses a node the file does not render. A write here reports success ' +
  'and changes nothing anyone can see. Read ' +
  outerInstanceId +
  ' (get_node, depth:-1) and address the node by the id that read emits.'

/**
 * What a WRITE is told when the node exists in the file and no handle serves it.
 *
 * The read face answers such an id from the ancestor's export and says the row
 * is degraded. A write has no such half: Figma rejects the handle, or worse
 * accepts it onto a different node. Refusing is the only honest answer, so the
 * message carries the way out the QA build itself found.
 */
export const deadHandleMessage = (nodeId: string): string =>
  'Refusing to write to ' +
  nodeId +
  ': the file describes this node, but no live handle answers it — Figma ' +
  'composed its address from a pre-append id, so every write to it is ' +
  'rejected or lands on a different node. Reads of this id still work, from ' +
  'the ancestor export. To change it: reparent_node the subtree out of the ' +
  'slot, write there, and reparent it back — or set the value through the ' +
  'instance override / component property on the instance above it.'

/**
 * Whether a throw is Figma refusing an address it composed off a pre-append id.
 *
 * The signature is Figma's own and it is stable across verbs — `get_parent`,
 * `get_children`, `appendChild` and `set_*` all word it the same way:
 *
 *   in get_children: The node (instance sublayer or table cell) with id
 *   "I571:32063;571:32007" does not exist
 *
 * The parenthetical is the load-bearing half. A plain "does not exist" is also
 * what Figma says about an id a caller simply got wrong, and restating THAT as
 * a slot-address refusal would send someone hunting a mechanism that is not
 * there.
 */
export const staleHandleThrow = (err: unknown): boolean => {
  const text =
    err instanceof Error ? err.message : String(err)
  return (
    text.includes('instance sublayer or table cell') &&
    text.includes('does not exist')
  )
}

/**
 * Our sentence for a write Figma refused through a PROVISIONAL handle, or
 * undefined when the throw is not ours to restate (B81).
 *
 * Figma's own message quotes the address it composed — two segments, naming no
 * node (69 such ids on the 2026-09-02 artifact, every one of which `get_node`
 * answers "does not exist" for). Handing that through gives a caller an id it
 * cannot act on. This restates the same refusal against the id the caller
 * SENT, with the way out on it.
 *
 * Only for an id this dispatch resolved through a handle whose ancestry would
 * not read. Everything else keeps Figma's words: a message we did not earn the
 * right to replace is a message we must not replace.
 */
export const restatedRefusal = (
  err: unknown,
  provisional: readonly string[],
): string | undefined => {
  if (provisional.length === 0) return undefined
  if (!staleHandleThrow(err)) return undefined
  return deadHandleMessage(provisional[0])
}

/**
 * Whether `nodeId` must be described by its ANCESTOR's export rather than by
 * the handle's own (B78).
 *
 * ONE NODE, ONE ORACLE. A read emits the id the export gives each node. When
 * the handle that id resolves to answers a DIFFERENT id — slot content keeps
 * its pre-append one — then `handle.exportAsync()` is a different document,
 * rooted at a different id, and its children need not agree with what the
 * ancestor's export said. Both halves of that were live:
 *
 *   the ROOT disagrees      — a read of `I549:17448;549:17078;549:17515` came
 *                             back under `549:17514`, so every id-join between
 *                             a read and a search broke on those rows.
 *   the CHILDREN disagree   — `get_node depth:1` on Plot listed the gridlines,
 *                             the fill, the axes and the ticks and SKIPPED
 *                             `Treasury line`, while a direct read of that
 *                             child's id answered it in full (B78). An
 *                             enumeration that drops what addressing finds is
 *                             two oracles disagreeing, not a missing node.
 *
 * The ancestor's export named the node, so the ancestor's export describes it.
 * The handle is still used for everything only a live read can add — the
 * enrichment pairs it against that document exactly as a parent read does — so
 * this costs no fidelity and is NOT a degrade.
 *
 * A plain id is always its own oracle: nothing above it renamed it.
 */
export const servedByAncestorExport = (
  nodeId: string,
  handle: LiveNode | null,
): boolean =>
  handle !== null &&
  leadingInstanceId(nodeId) !== undefined &&
  idOf(handle) !== nodeId

export type ResolveDeps = {
  /** `figma.getNodeByIdAsync`, which only ever answers a PLAIN id reliably. */
  getNodeById: (id: string) => Promise<LiveNode | null>
  /** The JSON_REST_V1 document for a node, or undefined when it refuses. */
  exportOf: (node: LiveNode) => Promise<RawNode | undefined>
  /** Override the export budget. Tests set it low; the plugin takes the default. */
  maxExports?: number
}

export type NodeResolver = {
  /** Drop every cached export, and return to READ mode. Once per dispatch. */
  reset: () => void
  /**
   * Whether this dispatch MUTATES (B73/B74).
   *
   * A read and a write want different things from the same id. A read wants the
   * best handle available and declares whatever the handle could not say; a
   * write wants a handle it can hand to Figma, and there is no such thing as a
   * partial write that says so afterwards. So the resolver serves one contract
   * per dispatch, set once from the command, and no entry point has to remember
   * which family it belongs to.
   *
   * In write mode `resolve` THROWS rather than returning a handle that cannot
   * take the write. It still returns null for an id nothing names — a refusal
   * is not a miss (B39).
   */
  setStrict: (strict: boolean) => void
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
   * The ids this dispatch resolved through a handle it could not vouch for
   * (B81), in resolve order.
   *
   * A write through one of these is ATTEMPTED, not refused — and if Figma
   * throws, `restatedRefusal` uses this list to word the refusal against an id
   * the caller can act on. Empty for every ordinary dispatch.
   */
  provisionalIds: () => string[]
  /**
   * What the export says about `nodeId`, for a node whose live handle cannot
   * describe itself. Undefined for a plain id — that node answers its own read.
   *
   * Throws on the budget, for the same reason `resolve` does.
   */
  exportedNode: (
    nodeId: string,
  ) => Promise<RawNode | undefined>
  /**
   * The CANONICAL id the export gives this live handle, or undefined (B89).
   *
   * The inverse of `resolve`, and it exists because `search` had the opposite
   * problem to every other read: it holds the HANDLE and emits whatever id the
   * handle answers. For slot content that is a pre-append id the rest of the
   * surface rejects — one reply carried 129 of them, 55 screen nodes came back
   * unaddressable, and 12 writes were refused against ids `search` had just
   * handed out. The export is the same oracle the read face uses, and this
   * resolver already pays for it, so the answer costs one export per INSTANCE
   * and nothing at all for a second handle under the same one.
   *
   * `instanceId` is the OUTERMOST instance the handle sits inside — the caller
   * already walked for it (`outerInstanceOf`) to know the row was an alias at
   * all, so it is passed rather than re-derived.
   *
   * DEGRADES rather than throws, unlike `resolve`. A budget refusal here means
   * the row keeps the id it already had and the reply says so; killing a
   * document-wide scan over an id SHAPE would be a far worse answer than the
   * shape.
   */
  canonicalIdFor: (
    node: LiveNode,
    instanceId: string,
  ) => Promise<string | undefined>
}

export const createNodeResolver = (
  deps: ResolveDeps,
): NodeResolver => {
  const maxExports = deps.maxExports ?? MAX_INSTANCE_EXPORTS
  // instance id → its paired index. The PROMISE is cached, not the result, so
  // concurrent entries of one `get_nodes` share a single export.
  const indexes = new Map<
    string,
    Promise<IdentityIndex | undefined>
  >()
  let strict = false
  /** Ids handed back through a handle whose ancestry would not read (B81). */
  const provisional: string[] = []
  /**
   * instance id → live handle → the canonical id the export gives it (B89).
   *
   * Built once per instance from the SAME index `resolve` uses, so the two
   * directions can never disagree, and memoised because a document scan asks
   * about hundreds of handles under one instance.
   */
  const inverses = new Map<string, Map<LiveNode, string>>()

  /**
   * The handle, or a refusal — the write-mode gate (B73/B74/B81).
   *
   * Read mode is unchanged: it takes whatever came back, and the read face
   * declares what the handle could not answer.
   *
   * Write mode refuses ONE thing up front: a handle that answers nothing at
   * all, which cannot take a write by any road. A handle that answers itself
   * and refuses its ancestry is handed back and REMEMBERED — the write is
   * tried, and the refusal, if Figma issues one, is restated against the
   * caller's own id. Refusing that class before the attempt is what B81 cost:
   * 48 writes refused in one build, and a component topology bent around a
   * probe.
   */
  const vouch = (
    node: LiveNode | null,
    nodeId: string,
  ): LiveNode | null => {
    if (!strict || node === null) return node
    if (!handleAnswers(node)) {
      throw new Error(deadHandleMessage(nodeId))
    }
    // NO DROPPED-HANDLE PROBE HERE. It was tried and it was wrong, twice over
    // (live 2026-09-03): it fired on `I586:73508;586:73503;586:73515;586:73507`
    // — the id `get_node` EMITS for a live Cell after a staged move, i.e. the
    // id this surface tells the caller to use — and it fired before the create
    // door's downward walk could run, so not one probe arm reached Figma. What
    // it was naming is the B81 zombie class (answers id/name/type, refuses
    // `parent` and `children`), and B81's ruling is that such a handle is
    // PROVISIONAL, never refused up front: the refusal has to be earned by a
    // write that did not land. A dropped target is checked where the check can
    // be earned instead — on the WALKED handle, at the append (slot-landing.ts).
    if (
      !parentAnswers(node) &&
      !provisional.includes(nodeId)
    ) {
      provisional.push(nodeId)
    }
    return node
  }

  /**
   * Would resolving inside this instance need a NEW export we cannot afford?
   *
   * An instance already in the map costs nothing more, however many ids name
   * it — which is the whole point of the cache, and why the budget counts
   * INSTANCES rather than ids.
   */
  const overBudget = (instanceId: string): boolean =>
    !indexes.has(instanceId) && indexes.size >= maxExports

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
      inverses.clear()
      provisional.length = 0
      strict = false
    },
    provisionalIds: () => [...provisional],
    setStrict: (on: boolean) => {
      strict = on
    },
    resolve: async (nodeId: string) => {
      const instanceId = leadingInstanceId(nodeId)
      if (instanceId === undefined) {
        // A PLAIN id is left alone in both modes. It may still be an alias —
        // slot content answers one — but the alias IS the node often enough
        // that refusing every such write would break the one route into a slot
        // subtree that works (the reparent-out / write / reparent-back
        // workaround the 2026-08-30 build had to adopt).
        const plain = await deps.getNodeById(nodeId)
        // B93 — with ONE exception, and it is not about the id's shape: an
        // ANCESTOR answering the same id means two nodes answer it, Figma
        // picked one, and no write can say which. A read still takes what came
        // back — the wrong one of two identical nodes still describes the
        // design — but a write that cannot name its target is not made.
        if (
          strict &&
          plain !== null &&
          shadowedByAncestor(plain)
        ) {
          throw new Error(ambiguousHandleMessage(nodeId))
        }
        // And no dropped-handle probe here either. The plain id a staged fill
        // answers is a working ALIAS — live: `update_node(586:73517, name)`
        // landed on the rendered node and read back — so refusing it would
        // break the one route into a slot subtree that works, which is the
        // paragraph above.
        return plain
      }
      const instance = await deps.getNodeById(instanceId)
      if (instance === null) return null
      // B74 — the address itself, before anything is resolved through it. An
      // `I<alias>;<leaf>` names a node that reads, writes, reads back changed
      // and never renders; nothing downstream can tell it from a real one,
      // because as far as Figma is concerned it IS a node.
      if (strict && isAliasHandle(instance)) {
        throw new Error(
          aliasAddressMessage(
            nodeId,
            instanceId,
            outerInstanceOf(instance) ?? instanceId,
          ),
        )
      }
      // The cheap half first: a master-derived sublayer answers its own
      // compound id, so one guarded walk finds it and nothing is exported.
      // Nothing here is budgeted — the walk is free, so a call naming a
      // thousand ordinary sublayers is unaffected by the cap below.
      //
      // B93 — but only when the walk found ONE. Same-component nesting puts two
      // handles under one id, and the cheap walk has no way to tell them apart:
      // it knows ids, and the thing that separates these two nodes is their
      // POSITION IN THE CHAIN. So an ambiguous id falls through to the export,
      // which is the only oracle that knows chain position.
      const direct = findLiveMatches(instance, nodeId, 2)
      if (direct.length === 1) return vouch(direct[0], nodeId)
      if (overBudget(instanceId)) {
        if (direct.length > 1) {
          // Nothing can disambiguate this. A read takes the shallowest, which
          // is the one a caller means; a write is refused rather than aimed.
          if (strict) {
            throw new Error(
              ambiguousHandleMessage(nodeId),
            )
          }
          return vouch(direct[0], nodeId)
        }
        throw new Error(
          exportBudgetMessage(nodeId, maxExports),
        )
      }
      const index = await indexFor(instanceId, instance)
      const paired = index?.live.get(nodeId)
      if (paired !== undefined) return vouch(paired, nodeId)
      if (direct.length > 1) {
        if (strict) {
          throw new Error(ambiguousHandleMessage(nodeId))
        }
        return vouch(direct[0], nodeId)
      }
      return vouch(null, nodeId)
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
    canonicalIdFor: async (
      node: LiveNode,
      instanceId: string,
    ) => {
      const cached = inverses.get(instanceId)
      if (cached !== undefined) return cached.get(node)
      // No throw. A scan holds the row already; the honest degrade is to keep
      // the id the handle answers and let the reply name the disagreement.
      if (overBudget(instanceId)) return undefined
      const index = await indexFor(instanceId)
      if (index === undefined) return undefined
      const inverse = new Map<LiveNode, string>()
      // FIRST wins, the same rule `indexByCanonicalId` states: the map is built
      // pre-order, so the first id a handle appears under is the shallowest,
      // which is the one a caller means.
      for (const [id, live] of index.live) {
        if (!inverse.has(live)) inverse.set(live, id)
      }
      inverses.set(instanceId, inverse)
      return inverse.get(node)
    },
  }
}
