// instance-ceiling.ts — the per-instance write ceiling, said once and said
// honestly (I66).
//
// An INSTANCE is SEALED. Its contents mirror its main component, and Figma
// refuses to add a child anywhere inside one except a component SLOT. That is a
// platform rule, not a gap in this surface: roughly thirty backlog items are
// the same wall hit from different directions, and the workaround — build the
// content at page level, then `reparent_node` it in — is proven and taught
// (S44). NOTHING here adds an override; this only fixes what the refusal SAYS.
//
// What it used to say was worse than nothing. Four copies of one sentence,
// each raised from a bare `catch {}` that discarded the real error and then
// asserted the instance story regardless — so a parent refusing a child for any
// OTHER reason (a TEXT node, a locked layer, a type that cannot hold that
// child) was told about component slots, and the caller went looking for a slot
// that was never the problem. And when the instance story WAS right, the
// message named neither the instance responsible nor the way through.
//
// So the refusal now does three things it did not do:
//   - it CHECKS whether an instance is actually the reason, by walking the
//     ancestor chain, and reports the raw Figma refusal when it is not;
//   - it names the INSTANCE that seals the target, not just the target;
//   - it names both taught ways forward — a slot in the MASTER, or build
//     outside and reparent in.
//
// Structural on both sides, so both are testable without a Figma runtime.

/** As much of a node as the ancestor walk touches. */
import {
  deadHandleMessage,
  staleHandleThrow,
} from './resolve-node'

export type AncestorNode = {
  id?: unknown
  name?: unknown
  type?: unknown
  parent?: unknown
}

/** The instance that seals a target. */
export type SealingHost = { id: string; name: string }

/**
 * A cap on the ancestor walk.
 *
 * A Figma tree is nowhere near this deep. The cap is here because the walk runs
 * inside an error path: a handle whose `parent` chain is degraded or cyclic must
 * not turn a refusal into a hang, and an unbounded loop in the code that
 * explains a failure is the worst place to put one.
 */
const MAX_ANCESTORS = 64

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

/**
 * The nearest INSTANCE at or above `node`, or `undefined`.
 *
 * "At or above": a target that IS an instance is sealed by itself, which is the
 * commonest case — an agent addressing the instance rather than its slot.
 *
 * Every read is guarded. This runs while explaining a failure, and the handle
 * that failed may refuse `parent`, `type` and `id` alike; a refusal that throws
 * while composing its own message would replace a bad sentence with no sentence.
 * A walk that cannot finish answers `undefined`, which downgrades the message to
 * the honest raw one rather than inventing a host.
 */
export const sealedInstanceHost = (
  node: AncestorNode | null | undefined,
): SealingHost | undefined => {
  let current: AncestorNode | null | undefined = node
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    if (current === null || current === undefined) {
      return undefined
    }
    try {
      if (str(current.type) === 'INSTANCE') {
        return {
          id: str(current.id) ?? '(unnamed id)',
          name: str(current.name) ?? '(unnamed instance)',
        }
      }
      const next = current.parent as
        | AncestorNode
        | null
        | undefined
      if (next === current) {
        return undefined
      }
      current = next
    } catch {
      return undefined
    }
  }
  return undefined
}

/** What a blocked append/move says. */
export const appendRefusal = ({
  operation,
  parentId,
  parentType,
  host,
  raw,
}: {
  /** The word for what was attempted, e.g. `create` or `move`. */
  operation: string
  parentId: string | undefined
  parentType: string | undefined
  /** The instance that seals the target, when one does. */
  host: SealingHost | undefined
  /** What Figma actually said. */
  raw: string
}): string => {
  const target =
    'into ' +
    (parentId ?? '(unnamed parent)') +
    ' (' +
    (parentType ?? 'unknown type') +
    ')'
  if (host === undefined) {
    // Figma refused an address it composed off a pre-append id (B81/B73):
    // its sentence quotes a two-segment id the caller never sent and no
    // read answers. Restate it against the id the caller DID send — the
    // same restatement the write doors get from `restatedRefusal` — so the
    // create/move door keeps B73's promise too (live 2026-09-03: the nested
    // slot create quoted `I<preappend>;<local>` verbatim).
    if (parentId !== undefined && staleHandleThrow(raw)) {
      return (
        'Cannot ' +
        operation +
        ' ' +
        target +
        ': ' +
        deadHandleMessage(parentId)
      )
    }
    // No instance is responsible, so do not blame one. This branch is the
    // whole point of checking: the old text claimed the instance rule from a
    // discarded error, and sent callers hunting a slot that was never involved.
    return (
      'Cannot ' +
      operation +
      ' ' +
      target +
      ': Figma refused it — ' +
      raw
    )
  }
  return (
    'Cannot ' +
    operation +
    ' ' +
    target +
    ': it is inside the INSTANCE "' +
    host.name +
    '" (' +
    host.id +
    '), and an instance is SEALED — its contents mirror its main component, so ' +
    'only a component SLOT takes children inside one. This is the per-instance ' +
    'write ceiling, and it is a Figma rule, not a limit of this tool. Three ways ' +
    'through: target the SLOT node itself if the region already has one; add a ' +
    'slot to the MASTER component with update_component({slots}) and then fill ' +
    'it; or build the content at page level and move it in with reparent_node.'
  )
}
