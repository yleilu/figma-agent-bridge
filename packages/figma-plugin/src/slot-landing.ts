// slot-landing.ts — how a create LANDS inside a component SLOT, the seam a live
// probe flips to decide which route Figma really honours, and the id the reply
// is allowed to answer (B81, B94).
//
// WHAT IS KNOWN, LIVE, AND NOT IN DOUBT (2026-09-03):
//
//   PROPERTY writes through a canonical handle LAND. Opacity written on a
//   nested instance's sublayer read back 0.5.
//
//   STRUCTURAL writes into a nested instance's slot are refused BY FIGMA. The
//   throw is Figma's own and it quotes an address Figma composed off the inner
//   instance's PRE-APPEND id — two segments, naming no node.
//
//   APPENDING INTO AN INSTANCE SLOT RE-MINTS THE NODE. The node that arrives in
//   the slot is a NEW one under the instance's own chain, and the handle that
//   went in is dropped. The one-level fill answered `585:73437` while the live
//   id was `I585:73434;585:73430;585:73440` — the local segment changed
//   73437 → 73440. Re-checked: answered `585:73446`, live `…;585:73447`. And
//   `update_node` on the answered id ACKED `{id, name, warnings:[]}`. A create
//   that answers the staged id is therefore handing out a phantom (B94).
//
//   THE HANDLES REFUSE `.parent`. This is the signature the whole item is about,
//   and the first version of this module walked straight into it: every route
//   was chosen off `sealedInstanceHost`, an UPWARD `.parent` walk, which
//   answered "no instance" — so staging was skipped, the candidate arms threw
//   "not available here", and all five configurations fell through to one
//   `direct` append and one refusal. Not a single arm made a meaningful Figma
//   call. A probe that cannot run is worse than no probe.
//
// SO THE TARGET IS REACHED DOWNWARD. The leading instance of the caller's id —
// `585:73434`, the outer instance A — answers `getNodeByIdAsync`. From there the
// stated id IS a path: Body → B → Cell. Walking it touches only `children`,
// which these handles answer, and it yields a handle Figma's own tree holds
// right now. Every arm operates on that handle and on the CHAIN that reached
// it, so an enclosing INSTANCE is found by looking back along the chain rather
// than by reading `.parent`.
//
// WHAT THAT COST WHILE IT WAS UNFIXED. The 2026-09-03 build spent 152 of 1043
// calls on `reparent_node`, the single largest expense of the build — "it
// roughly doubled the call count for every composition" — and the round cost
// $322 against $76 for the previous one. The dance is not hard, it is just paid
// once per placed instance, by hand, forever:
//
//   create_node(at page level) → update_node(the overrides) → reparent_node(in)
//
// THE DEFAULT ROUTE ABSORBS IT: build at page level through the create path that
// already works, then move in, then read the landed id back off the parent.
//
// AND THE QUESTION STAYS OPEN. Whether some route lands a create straight into
// a nested slot is a fact about Figma's runtime that this process cannot reach.
// So the three candidates sit beside the default, SELECTABLE, and a live probe
// decides:
//
//   'direct'         target.appendChild(child) — the control arm.
//   'insert-child'   target.insertChild(0, child). Figma documents no
//                    difference, so this arm tests whether the index form takes
//                    a different path through the same ceiling.
//   'inner-handle'   find the nearest INSTANCE on the chain and re-read ITS
//                    children at append time, then append through the handle
//                    that read yields — rather than through a handle resolved
//                    earlier in the dispatch, which may be the paired one from
//                    an export rather than the one the tree holds.
//   'slot-property'  drive the content through the INSTANCE's own override
//                    surface, `setProperties({<slot>: <id>})` — an override is
//                    the one write Figma does sanction inside a sealed instance.
//
// A candidate route Figma refuses FALLS BACK to the default, and the warning
// carries Figma's own words for what it refused. A probe never bricks a build.
//
// Structural on every side (`Record<string, unknown>`), so all four routes and
// the walk are testable without a Figma runtime — which is the point, since
// `code.ts` cannot be imported outside Figma.

import { idOf, liveChildren } from './canonical-ids'
import type { LiveNode } from './canonical-ids'
import { sealedInstanceHost } from './instance-ceiling'
import { leadingInstanceId } from './resolve-node'

/** A live node, seen structurally so a test can stand one up. */
export type LandingNode = LiveNode

/** The routes a create may take into a slot. */
export type SlotRoute =
  | 'stage-then-move'
  | 'direct'
  | 'insert-child'
  | 'inner-handle'
  | 'slot-property'

/**
 * Every route, in the order a live probe should try them.
 *
 * The three candidates first, because a route that LANDS retires the default;
 * the default last, because it is the answer when none of them does.
 */
export const SLOT_ROUTES: readonly SlotRoute[] = [
  'direct',
  'insert-child',
  'inner-handle',
  'slot-property',
  'stage-then-move',
]

/**
 * The route a build takes when nothing selects another.
 *
 * Not a guess about Figma: it is the route the operator already runs by hand
 * 152 times a build, and it is proven by every one of them.
 */
export const DEFAULT_SLOT_ROUTE: SlotRoute =
  'stage-then-move'

/**
 * The plugin-data key that selects a route.
 *
 * INTERNAL, deliberately. It is not a tool parameter and must not become one:
 * a caller has no way to know which route Figma honours, so offering the choice
 * would export this bug into the tool surface. The dispatcher's live probe sets
 * it on the DOCUMENT (or on the current PAGE) with the plugin-data door that
 * already exists, runs its arm, and clears it again.
 */
export const SLOT_ROUTE_KEY = 'figma-bridge:slotRoute'

/**
 * The route a stored override names, or the default.
 *
 * Anything unrecognised is the default, silently: this reads a value a human
 * typed into plugin data, and a typo there must degrade to the working route
 * rather than to a refusal nobody can explain.
 */
export const readSlotRoute = (raw: unknown): SlotRoute => {
  const named = SLOT_ROUTES.find(r => r === raw)
  return named ?? DEFAULT_SLOT_ROUTE
}

/** The handle a walk reached, and every node it passed through. */
export type LandingChain = {
  /** The append target. */
  target: LandingNode
  /** The nodes from the live ancestor down to `target`, inclusive. */
  chain: LandingNode[]
}

/** A guarded `name` read. */
const nameOf = (node: LandingNode): string => {
  try {
    const name = node.name
    return typeof name === 'string'
      ? name
      : '(unnamed node)'
  } catch {
    return '(unnamed node)'
  }
}

/** A guarded `type` read. */
const typeOf = (node: LandingNode): string | undefined => {
  try {
    const type = node.type
    return typeof type === 'string' ? type : undefined
  } catch {
    return undefined
  }
}

/** The last `;`-separated segment of an id. */
const localSegment = (id: string): string =>
  id.slice(id.lastIndexOf(';') + 1)

/**
 * Walk DOWN from a live ancestor to the node a compound id names.
 *
 * `I<lead>;<s1>;<s2>;…` is a PATH, one segment per level, so the walk descends
 * one level per segment and never reads `.parent` — which is exactly what these
 * handles refuse, and exactly what the first version of this module died on.
 *
 * Three ways to match a level, in this order and never out of it:
 *
 *   the child whose id IS the prefix        — the ordinary case.
 *   the child whose own LOCAL segment       — Figma RE-MINTS a node's local
 *   equals this level's segment               segment when it enters an
 *                                             instance slot, so an id read
 *                                             before a move can name a segment
 *                                             the tree has since changed.
 *   the ONLY child there is                 — when a whole middle segment was
 *                                             re-minted (73437 → 73440, live)
 *                                             neither id matches, and a level
 *                                             holding exactly one node has
 *                                             exactly one way down. A level
 *                                             holding several is ambiguous and
 *                                             answers nothing.
 *
 * `undefined` for a plain id (no chain to walk) and for a path that does not
 * lead anywhere: a walk that found nothing has learned nothing, and substituting
 * some other node on a guess would move the write.
 */
export const descendToTarget = (
  host: LandingNode,
  statedId: string,
): LandingChain | undefined => {
  const lead = leadingInstanceId(statedId)
  if (lead === undefined) return undefined
  const segments = statedId.slice(1).split(';').slice(1)
  if (segments.length === 0) return undefined
  const chain: LandingNode[] = [host]
  let current = host
  let prefix = 'I' + lead
  /** Has some level matched by ID yet? The only-child arm needs an anchor. */
  let anchored = false
  for (const segment of segments) {
    prefix += ';' + segment
    const children = liveChildren(current)
    const byId =
      children.find(c => idOf(c) === prefix) ??
      children.find(c => {
        const id = idOf(c)
        return (
          id !== undefined && localSegment(id) === segment
        )
      })
    // The only-child arm runs only on a path an id has already anchored. A
    // master-derived sublayer's id is composed off the instance and is never
    // re-minted, so the FIRST level always matches by id on a real path —
    // which means an unanchored walk down a single-child spine is a wrong id,
    // not a re-mint, and must answer nothing rather than some node.
    const found =
      byId ??
      (anchored && children.length === 1
        ? children[0]
        : undefined)
    if (byId !== undefined) anchored = true
    if (found === undefined) return undefined
    const byLocal = found
    // Follow the id the tree actually uses, so the next level's prefix is built
    // from what is there rather than from what the caller remembered.
    prefix = idOf(byLocal) ?? prefix
    current = byLocal
    chain.push(current)
  }
  return { target: current, chain }
}

/**
 * The ids of a node's children, or undefined when it will not list them.
 *
 * UNDEFINED IS NOT EMPTY. A parent that refuses `get_children` and a parent with
 * no children are the same shape to a naive read, and treating the first as the
 * second would let a landed node be reported as "nothing appeared" — or worse,
 * let the diff below name a node that was already there.
 */
export const childIdsOf = (
  node: LandingNode,
): string[] | undefined => {
  try {
    if (!('children' in node)) return undefined
    const kids = node.children
    if (kids === null || kids === undefined) return undefined
    return Array.from(kids as ArrayLike<LandingNode>).map(
      c => idOf(c) ?? '',
    )
  } catch {
    return undefined
  }
}

/**
 * The id of the ONE child that appeared, or undefined (B94).
 *
 * Undefined when nothing appeared, when more than one did, or when either
 * reading failed. Every one of those is an outcome this call cannot verify, and
 * an unverifiable outcome is reported as unverifiable — never as success. The
 * defect this exists for is precisely the other behaviour: a create that
 * answered the id of the handle it staged, which Figma had already dropped, and
 * an `update_node` to that id that ACKED with empty warnings.
 */
export const landedChildId = (
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): string | undefined => {
  if (before === undefined || after === undefined) {
    return undefined
  }
  const had = new Map<string, number>()
  for (const id of before) {
    had.set(id, (had.get(id) ?? 0) + 1)
  }
  const fresh: string[] = []
  for (const id of after) {
    const left = had.get(id) ?? 0
    if (left > 0) {
      had.set(id, left - 1)
    } else {
      fresh.push(id)
    }
  }
  return fresh.length === 1 && fresh[0].length > 0
    ? fresh[0]
    : undefined
}

/**
 * What a route says when it cannot even be ATTEMPTED on this runtime.
 *
 * A probe arm that quietly did nothing would read as "the route landed", which
 * is the one answer that must never be inferred. Exported so the message has
 * ONE author — the `exportBudgetMessage` rule (resolve-node.ts).
 */
export const routeUnavailableMessage = (
  route: SlotRoute,
  reason: string,
): string =>
  'slot route "' +
  route +
  '" is not available here: ' +
  reason

/** The nearest INSTANCE at or above the target, looking back along the chain. */
const instanceOnChain = (
  chain: readonly LandingNode[],
): LandingNode | undefined => {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (typeOf(chain[i]) === 'INSTANCE') return chain[i]
  }
  return undefined
}

/**
 * Append `child` under a walked target through `route`.
 *
 * Throws whatever the route throws — Figma's own refusal for the three
 * candidates, and this module's own sentence for a route the runtime cannot
 * offer. The caller decides what a throw means; nothing is swallowed here.
 *
 * `stage-then-move` is not a case: it is not an append at all, it is a build
 * somewhere else followed by a move, and the move itself goes through
 * `'direct'`.
 */
export const appendVia = (
  route: SlotRoute,
  where: LandingChain,
  child: LandingNode,
): void => {
  const { target, chain } = where
  if (route === 'insert-child') {
    const insertChild = target.insertChild
    if (typeof insertChild !== 'function') {
      throw new Error(
        routeUnavailableMessage(
          route,
          'the target exposes no insertChild',
        ),
      )
    }
    ;(
      insertChild as (i: number, c: LandingNode) => void
    ).call(target, 0, child)
    return
  }
  if (route === 'inner-handle') {
    const host = instanceOnChain(chain)
    if (host === undefined) {
      throw new Error(
        routeUnavailableMessage(
          route,
          'no INSTANCE on the chain to this target, so there is nothing to re-read it from',
        ),
      )
    }
    // Re-read the target from the instance AT APPEND TIME. The handle the walk
    // stored and the handle the tree holds now need not be the same object, and
    // whether Figma honours one and not the other is the whole question.
    const wanted = idOf(target)
    const fresh =
      wanted === undefined
        ? target
        : (descendToTarget(host, wanted)?.target ??
          liveChildren(host).find(
            c => idOf(c) === wanted,
          ) ??
          target)
    appendVia(
      'direct',
      { target: fresh, chain },
      child,
    )
    return
  }
  if (route === 'slot-property') {
    const host = instanceOnChain(chain)
    if (host === undefined) {
      throw new Error(
        routeUnavailableMessage(
          route,
          'no INSTANCE on the chain to this target, so there is no override surface',
        ),
      )
    }
    const setProperties = host.setProperties
    if (typeof setProperties !== 'function') {
      throw new Error(
        routeUnavailableMessage(
          route,
          'the enclosing INSTANCE exposes no setProperties',
        ),
      )
    }
    const slotName = nameOf(target)
    const defined = ((): Record<string, unknown> => {
      try {
        const props = host.componentProperties
        return typeof props === 'object' && props !== null
          ? (props as Record<string, unknown>)
          : {}
      } catch {
        return {}
      }
    })()
    const key = Object.keys(defined).find(
      k => k === slotName || k.split('#')[0] === slotName,
    )
    if (key === undefined) {
      throw new Error(
        routeUnavailableMessage(
          route,
          'the enclosing INSTANCE has no component property named "' +
            slotName +
            '"',
        ),
      )
    }
    ;(
      setProperties as (v: Record<string, unknown>) => void
    ).call(host, { [key]: idOf(child) })
    return
  }
  const appendChild = target.appendChild
  if (typeof appendChild !== 'function') {
    throw new Error(
      routeUnavailableMessage(
        route,
        'the target exposes no appendChild',
      ),
    )
  }
  ;(appendChild as (c: LandingNode) => void).call(
    target,
    child,
  )
}

/**
 * Whether a create for this target must be STAGED — built at page level and
 * moved in — rather than appended where it stands.
 *
 * Decided on the STATED ID FIRST, and that is the correction. A compound id
 * says "inside an instance" by construction, with no walk at all; the upward
 * `sealedInstanceHost` walk it used to rely on reads `.parent`, which these
 * handles refuse, so it answered "no instance" for exactly the targets that
 * needed staging most and every route fell through to a plain append.
 *
 * The upward walk is still consulted for a PLAIN id, where it is the only thing
 * that can tell an instance's descendant from an ordinary frame.
 */
export const needsStaging = (
  route: SlotRoute,
  statedParentId: string | undefined,
  parent: LandingNode | null | undefined,
): boolean => {
  if (route !== 'stage-then-move') return false
  if (
    statedParentId !== undefined &&
    leadingInstanceId(statedParentId) !== undefined
  ) {
    return true
  }
  return sealedInstanceHost(parent) !== undefined
}

/**
 * The INSTANCE that seals an append target, named for a message.
 *
 * Chain first — it needs no `.parent` — and the upward walk only as the fallback
 * for a target that was not reached by a walk.
 */
export const landingHostOf = (
  chain: readonly LandingNode[] | undefined,
  parent: LandingNode | null | undefined,
): { id: string; name: string } | undefined => {
  const onChain =
    chain === undefined ? undefined : instanceOnChain(chain)
  if (onChain !== undefined) {
    return {
      id: idOf(onChain) ?? '(unnamed id)',
      name: nameOf(onChain),
    }
  }
  return sealedInstanceHost(parent)
}

/**
 * What the reply says about a create the tool staged.
 *
 * ONE line, on the create's own envelope. It names the route because the id
 * that comes back is the id AFTER the move — and, since Figma re-mints a node
 * on the way into a slot, that id is not the one the staged node had. A caller
 * that read "created in the slot" and got the staged id would hold a phantom,
 * which is what B94 is.
 */
export const stagedLandingMessage = ({
  operation,
  parentId,
  hostName,
  hostId,
}: {
  operation: string
  parentId: string
  hostName: string
  hostId: string
}): string =>
  operation +
  ': built at page level and moved into ' +
  parentId +
  ', because that target is inside the INSTANCE "' +
  hostName +
  '" (' +
  hostId +
  ') and Figma refuses an append straight into a slot there. This is the ' +
  'build-then-reparent remedy, paid by the tool instead of by the caller. ' +
  'Figma re-mints a node on the way into a slot, so the id in this reply was ' +
  'read back off the parent AFTER the move — it is the node’s real id, and it ' +
  'is not the id the node had while it was being built.'

/**
 * What the reply says when the move happened and the landed node could not be
 * named (B94).
 *
 * The node is in the file, so this is not a failure of the write; it is a
 * failure to VERIFY, and the two must not be reported the same way. Answering
 * the staged id here is exactly the defect — that id addresses a handle Figma
 * dropped, and a write to it acks and reaches nothing.
 */
export const unverifiedLandingMessage = (
  parentId: string,
): string =>
  'The content was built and moved into ' +
  parentId +
  ', but its id could not be read back: the parent would not list its children ' +
  'after the move, or more than one child changed. Figma re-mints a node on ' +
  'the way into a slot, so the id it had while it was being built no longer ' +
  'names it and this reply will not hand that id out — a write to it would be ' +
  'accepted and reach nothing. Read ' +
  parentId +
  ' (get_node, depth:1) to get the id of what landed.'

/**
 * What the reply says when a SELECTED candidate route was refused and the
 * default carried the write instead.
 *
 * Figma's own words are quoted, because the probe is reading them: the whole
 * value of a candidate arm is what Figma says when it says no.
 */
export const routeFellBackMessage = (
  route: SlotRoute,
  raw: string,
): string =>
  'slot route "' +
  route +
  '" did not land, so the write took the default route ("' +
  DEFAULT_SLOT_ROUTE +
  '") instead. Figma said: ' +
  raw
