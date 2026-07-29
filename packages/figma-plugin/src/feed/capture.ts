// The two reads the attributor performs against the Figma runtime from INSIDE
// the synchronous documentchange handler (change-feed.md, "Values, and the cap
// that bounds them" and "The locator").
//
// Both work on the node the CHANGE HANDED OVER — synchronous property access,
// never an id resolution — so neither disturbs the constraint that the handler
// performs no lookups. Both fail toward the names-only record: an access that
// throws yields no entry, and a walk that cannot be performed yields no
// locator. Isolated here because they are the only runtime-touching part of
// the pipeline, and everything around them is testable without a document.
import {
  RECORD_VALUE_BUDGET,
  pickValues,
} from '@figma-agent-bridge/shared'

/**
 * The final value of each changed property that fits, read off `node`.
 *
 * UNDEFINED when nothing survived, so a record carries no `set` rather than an
 * empty one — `set` is always a strict subset of `props`, and an empty object
 * would be wire cost carrying no answer.
 *
 * Each read is individually guarded (by `pickValues`): a property that throws
 * — a node on a page the runtime has not loaded, or one already removed —
 * yields no entry and keeps its place in `props`, which is the honest "this
 * changed and you must re-read it".
 */
export const captureValues = (
  node: unknown,
  props: readonly string[],
): Record<string, unknown> | undefined => {
  if (node === null || typeof node !== 'object') {
    return undefined
  }
  const bag = node as Record<string, unknown>
  const picked = pickValues(
    props.map(name => ({
      name,
      read: () => bag[name],
    })),
    RECORD_VALUE_BUDGET,
  )
  if (picked.size === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of picked) out[k] = v
  return out
}

/** Bound on the parent walk. A document is nowhere near this deep; the guard
 *  is against a chain that does not terminate at all, so that one malformed
 *  node cannot hang the synchronous handler. IMPLEMENTATION GUARD, not spec —
 *  the same judgement as MAX_CLOSURE_NODES. */
const MAX_PARENT_WALK = 256

/**
 * The best-effort locator: `pg`, the page the node is on, and `fr`, the
 * ancestor that is a direct child of that page — the node's own id when it IS
 * one.
 *
 * BOTH ABSENT when the walk cannot be performed: an unrooted node, a node
 * whose `parent` access throws, or a chain that does not reach a page. Never
 * called for a delete — a RemovedNode exposes no parent, so a delete is never
 * located.
 *
 * It buys two things for its two ids: a truncated drain can say WHERE the
 * remaining changes are rather than only how many, and the standing advice for
 * a large foreign count — re-read the affected region — becomes actionable.
 */
export const captureLocator = (
  node: unknown,
): { pg?: string; fr?: string } => {
  try {
    let child = node as {
      id?: unknown
      parent?: unknown
    } | null
    for (let i = 0; i < MAX_PARENT_WALK; i += 1) {
      if (child === null || child === undefined) break
      const parent = child.parent as {
        id?: unknown
        type?: unknown
        parent?: unknown
      } | null
      if (parent === null || parent === undefined) break
      if (parent.type === 'PAGE') {
        return typeof parent.id === 'string' &&
          typeof child.id === 'string'
          ? { pg: parent.id, fr: child.id }
          : {}
      }
      child = parent
    }
  } catch {
    // A locator costs nothing but itself: the record still carries the change.
  }
  return {}
}
