// slot-entries.ts — read one `update_component` slot entry (B30).
//
// A slot entry crosses the wire in one of two shapes: the CONVERTED spec
// object the server built on the shared write face, carrying `name` plus the
// Figma-ready fields the ordinary apply pipeline consumes — which is what the
// current server sends for every entry, a bare name included (the bare name IS
// `{name}`, so it is converted like one) — or a bare NAME, still read here
// because the param has always accepted one and an older server sends it.
//
// The branch lives here, free of the figma runtime, because it is the part
// worth testing: `code.ts` cannot be imported outside Figma, and getting the
// name wrong costs the slot its name — the one thing a slot must have.

/** A slot entry as it arrives from the server. */
export type SlotEntry = string | Record<string, unknown>

/** A live node, seen structurally so a test can stand one up. */
export type SlotParentNode = {
  id?: unknown
  name?: unknown
  type?: unknown
  parent?: unknown
  appendChild?: unknown
}

/**
 * Why this node cannot host the slot, or undefined when it can (I60).
 *
 * `createSlot()` drops its slot at the component's root, and a real component
 * puts its slot inside something — a card's body, a row's trailing cell. So the
 * entry may name where it goes, and this is the check that runs first.
 *
 * A refusal never costs the slot. The slot is already created and named by the
 * time this runs, so the answer to a bad target is to leave it at the root and
 * SAY so: a slot parked somewhere the caller did not ask for is worse than one
 * still at the root, because only the second is where the caller will look for
 * it.
 *
 * Two things are checked, and the order matters — a node outside the component
 * is the dangerous case, because appending to it would succeed and quietly move
 * a slot out of the component it belongs to.
 *
 * The ancestor walk is BOUNDED. A Figma tree is finite, but this reads a
 * structural `parent` a caller could hand a cycle back on, and a hung plugin is
 * a far worse answer than a refused reparent.
 */
export const slotParentRefusal = (
  target: SlotParentNode | null | undefined,
  component: { id?: unknown },
  targetId: string,
): string | undefined => {
  if (target === null || target === undefined) {
    return (
      'parentId "' +
      targetId +
      '" names no node; the slot stays at the component root'
    )
  }
  let current: SlotParentNode | null | undefined = target
  let inside = false
  for (let hops = 0; hops < 64; hops += 1) {
    if (current === null || current === undefined) break
    if (current.id === component.id) {
      inside = true
      break
    }
    current = current.parent as
      | SlotParentNode
      | null
      | undefined
  }
  if (!inside) {
    return (
      'parentId "' +
      targetId +
      '" is not inside this component; the slot stays at the component root'
    )
  }
  if (typeof target.appendChild !== 'function') {
    return (
      'parentId "' +
      targetId +
      '" is a ' +
      (typeof target.type === 'string'
        ? target.type
        : 'node') +
      ', which cannot have children; the slot stays at the component root'
    )
  }
  return undefined
}

/**
 * The name to give the slot, and the spec to apply to it (absent for a bare
 * name).
 *
 * A missing / non-string `name` yields `''`, which the caller reads as "leave
 * Figma's own auto-name" rather than assigning a stringified object.
 */
export const readSlotEntry = (
  entry: SlotEntry,
): { name: string; spec?: Record<string, unknown> } => {
  if (typeof entry === 'string') {
    return { name: entry }
  }
  if (entry === null || typeof entry !== 'object') {
    return { name: '' }
  }
  const name = (entry as { name?: unknown }).name
  return {
    name: typeof name === 'string' ? name : '',
    spec: entry,
  }
}
