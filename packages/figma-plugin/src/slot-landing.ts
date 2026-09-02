// slot-landing.ts — how a create LANDS inside a component SLOT, and the seam
// a live probe flips to decide which route Figma really honours (B81).
//
// WHAT IS KNOWN, LIVE, AND NOT IN DOUBT (2026-09-03, `6318986`):
//
//   PROPERTY writes through a canonical handle LAND. Opacity written on a
//   nested instance's sublayer read back 0.5. The write gate over-rejected and
//   no longer does.
//
//   STRUCTURAL writes into a nested instance's slot are refused BY FIGMA. The
//   throw is Figma's own and it quotes an address Figma composed off the inner
//   instance's PRE-APPEND id — `I<preappend>;<local>`, two segments, naming no
//   node. `restatedRefusal` already turns that into a sentence about the id the
//   caller sent; what nothing has done yet is make the write land.
//
// WHAT THAT COST. The 2026-09-03 build spent 152 of 1043 calls on
// `reparent_node`, and the operator named it the single largest expense of the
// build — *"it roughly doubled the call count for every composition."* Round
// cost went $76 → $322 as the definition count went 41 → 71. The workaround is
// not hard, it is just paid once per placed instance, by hand, forever:
//
//   create_node(at page level) → update_node(the overrides) → reparent_node(in)
//
// THIS MODULE ABSORBS THAT. The default route builds the node at page level
// through the create path that already works, then MOVES it in — the taught
// remedy, spent by the tool instead of by the caller, in one call instead of
// three. The node is fully configured before Figma's instance ceiling ever
// sees it, which is the actual reason the dance works.
//
// AND IT KEEPS THE QUESTION OPEN. Whether some route lands a create straight
// into a nested slot cannot be settled from here — it is a fact about Figma's
// runtime, and this process cannot reach Figma. So the three candidates are
// implemented beside the default and SELECTABLE, and a live probe decides:
//
//   'direct'         parent.appendChild(child) — today's behaviour, the control
//                    arm. Expected: Figma's "instance sublayer or table cell …
//                    does not exist" on the composed two-segment address.
//   'insert-child'   parent.insertChild(0, child). Same ceiling or not — Figma
//                    documents no difference, and the refusal is raised inside
//                    appendChild's shared implementation, so this arm tests
//                    whether the index form takes a different path.
//   'inner-handle'   re-resolve the slot by WALKING the live tree down from the
//                    enclosing INSTANCE, and append through the handle that
//                    walk yields, rather than through the handle a lookup on
//                    the composed canonical id returned. The two are different
//                    objects when slot content answers a pre-append id, and
//                    only one of them is the handle Figma's own tree holds.
//   'slot-property'  drive the content through the INSTANCE's own override
//                    surface — `instance.setProperties({<slot>: <id>})` —
//                    rather than through the child list. An override is the one
//                    write Figma does sanction inside a sealed instance.
//
// A candidate route that Figma refuses FALLS BACK to the default, and the
// warning carries Figma's own words for what it refused. A probe therefore
// never bricks a build, and the dispatcher reads the answer off the reply
// instead of off a crash.
//
// Structural on every side (`Record<string, unknown>`), so all four routes are
// testable without a Figma runtime — which is the point, since `code.ts` cannot
// be imported outside Figma.

import { idOf, liveChildren } from './canonical-ids'
import type { LiveNode } from './canonical-ids'
import { sealedInstanceHost } from './instance-ceiling'
import type { SealingHost } from './instance-ceiling'

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

/**
 * The INSTANCE that seals this append target, or undefined.
 *
 * The same walk `appendRefusal` runs, and deliberately the same one: the class
 * of target that needs a landing route is exactly the class the ceiling refuses.
 */
export const landingHost = (
  parent: LandingNode | null | undefined,
): SealingHost | undefined => sealedInstanceHost(parent)

/**
 * The nearest INSTANCE at or above `node`, as a HANDLE.
 *
 * `sealedInstanceHost` answers the instance's id and name, which is all a
 * message needs. Two of the routes need the node itself — one to walk down
 * from it, one to write an override on it — so the walk is run once more here
 * rather than widening the message builder's return.
 *
 * Guarded at every hop, and bounded, for the reasons `sealedInstanceHost`
 * states: this runs over handles that refuse their own reads.
 */
export const sealingInstanceNode = (
  node: LandingNode | null | undefined,
): LandingNode | undefined => {
  let current: LandingNode | null | undefined = node
  for (let hop = 0; hop < 64; hop += 1) {
    if (current === null || current === undefined) {
      return undefined
    }
    try {
      if (current.type === 'INSTANCE') return current
      const next = current.parent as
        | LandingNode
        | null
        | undefined
      if (next === current) return undefined
      current = next
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The handle Figma's own live tree holds for `target`, found by walking down
 * from `host` — candidate route (a).
 *
 * WHY THIS CAN DIFFER FROM WHAT A LOOKUP RETURNS. A read emits the id the
 * EXPORT gives a node, and the resolver answers that id by pairing the export
 * against the live tree (canonical-ids.ts). For slot content the two disagree:
 * the file says `I<outer>;<mid>;<leaf>` and the handle answers a plain
 * pre-append id. The paired handle is the right node to READ. Whether it is the
 * node Figma will take an `appendChild` through is exactly what is unknown, and
 * this walk produces the other candidate — the handle reached by descending
 * `children` from the instance, which is the only chain Figma composes
 * addresses along.
 *
 * Breadth-first, so the SHALLOWEST match wins. Depth-first would prefer a node
 * further from the host, and where the same component nests inside itself the
 * deeper one is the wrong node (B93).
 *
 * Falls back to `target` itself. A walk that finds nothing has learned nothing,
 * and substituting a different node on a guess would move the write.
 */
export const liveHandleFor = (
  host: LandingNode,
  target: LandingNode,
): LandingNode => {
  const wanted = idOf(target)
  if (wanted === undefined) return target
  const tail = wanted.slice(wanted.lastIndexOf(';') + 1)
  let byTail: LandingNode | undefined
  const queue: LandingNode[] = [host]
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i]
    const id = idOf(node)
    if (id === wanted) return node
    if (
      byTail === undefined &&
      id !== undefined &&
      id.slice(id.lastIndexOf(';') + 1) === tail
    ) {
      byTail = node
    }
    for (const child of liveChildren(node)) {
      queue.push(child)
    }
  }
  return byTail ?? target
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
  'slot route "' + route + '" is not available here: ' + reason

/**
 * Append `child` under `parent` through `route`.
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
  parent: LandingNode,
  child: LandingNode,
): void => {
  if (route === 'insert-child') {
    const insertChild = parent.insertChild
    if (typeof insertChild !== 'function') {
      throw new Error(
        routeUnavailableMessage(
          route,
          'the target exposes no insertChild',
        ),
      )
    }
    ;(insertChild as (i: number, c: LandingNode) => void).call(
      parent,
      0,
      child,
    )
    return
  }
  if (route === 'inner-handle') {
    const host = sealingInstanceNode(parent)
    if (host === undefined) {
      throw new Error(
        routeUnavailableMessage(
          route,
          'no INSTANCE encloses the target, so there is no chain to walk down',
        ),
      )
    }
    const handle = liveHandleFor(host, parent)
    appendVia('direct', handle, child)
    return
  }
  if (route === 'slot-property') {
    const host = sealingInstanceNode(parent)
    if (host === undefined) {
      throw new Error(
        routeUnavailableMessage(
          route,
          'no INSTANCE encloses the target, so there is no override surface',
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
    const slotName = ((): string | undefined => {
      try {
        const name = parent.name
        return typeof name === 'string' ? name : undefined
      } catch {
        return undefined
      }
    })()
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
            (slotName ?? '(unnamed slot)') +
            '"',
        ),
      )
    }
    ;(
      setProperties as (v: Record<string, unknown>) => void
    ).call(host, { [key]: idOf(child) })
    return
  }
  const appendChild = parent.appendChild
  if (typeof appendChild !== 'function') {
    throw new Error(
      routeUnavailableMessage(
        route,
        'the target exposes no appendChild',
      ),
    )
  }
  ;(appendChild as (c: LandingNode) => void).call(
    parent,
    child,
  )
}

/**
 * Whether a create for this target must be STAGED — built at page level and
 * moved in — rather than appended where it stands.
 *
 * Only inside an INSTANCE. Outside one there is no ceiling, no alias and no
 * refusal, and staging a plain frame append would move a working path for no
 * reason. A SLOT inside a MASTER is an ordinary container and is not staged.
 */
export const needsStaging = (
  route: SlotRoute,
  parent: LandingNode | null | undefined,
): boolean =>
  route === 'stage-then-move' &&
  landingHost(parent) !== undefined

/**
 * What the reply says about a create the tool staged.
 *
 * ONE line, on the create's own envelope. It names the route because the id
 * that comes back is the id AFTER the move — a caller that read "created in the
 * slot" and got an id from a page-level build would have no way to tell the two
 * apart, and this surface does not ack what did not happen the way it says.
 */
export const stagedLandingMessage = ({
  operation,
  parentId,
  host,
}: {
  operation: string
  parentId: string
  host: SealingHost
}): string =>
  operation +
  ': built at page level and moved into ' +
  parentId +
  ', because that target is inside the INSTANCE "' +
  host.name +
  '" (' +
  host.id +
  ') and Figma refuses an append straight into a slot there. This is the ' +
  'build-then-reparent remedy, paid by the tool instead of by the caller — ' +
  'the id in this reply is the node’s id AFTER the move, and it is the one to ' +
  'address it by.'

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
