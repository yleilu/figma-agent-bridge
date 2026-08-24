// component-properties.ts — addressing a component property by what the agent
// actually holds, and saying so when nothing matches (M22a).
//
// `componentPropertyDefinitions` is keyed by the CANONICAL id — `Show
// date#453:63` — while every human, every doc and every `properties[].name` in
// a reply says `Show date`. `deleteComponentProperty` and
// `editComponentProperty` take the canonical key, so the bare name a caller
// reads back off its own add call is refused.
//
// M22 is what that costs: a removal that names the property the reply showed
// answers ok and removes nothing. So the bare name is ACCEPTED when exactly one
// property carries it, an ambiguous name is refused by naming the candidates,
// and an unknown one is refused by listing what the component does have. None
// of the three is a silent no-op.
//
// A COMPONENT_SET's variant properties are keyed by the bare name already, so
// the exact-match arm serves them unchanged.
//
// Structural on both sides, so it is testable without a Figma runtime.

/** One entry of `componentPropertyDefinitions`, as much as this module reads. */
export type PropertyDef = {
  type?: string
  defaultValue?: unknown
}

export type PropertyDefs = Record<string, PropertyDef>

/** The canonical key to act on, or why no single one could be chosen. */
export type KeyResolution =
  | { key: string; error?: undefined }
  | { key?: undefined; error: string }

/**
 * The bare NAME part of a canonical property id.
 *
 * The suffix is `#<nodeId>`, and a node id contains a `:`, so splitting on the
 * LAST `#` is safe for a property whose own name contains one.
 */
export const propertyName = (key: string): string => {
  const hash = key.lastIndexOf('#')
  return hash > 0 ? key.slice(0, hash) : key
}

const listed = (keys: string[]): string =>
  keys.map(k => `"${k}"`).join(', ')

/**
 * The canonical key `requested` names — by exact id, or by a bare name exactly
 * one property carries.
 */
export const resolvePropertyKey = (
  defs: PropertyDefs,
  requested: string,
): KeyResolution => {
  const keys = Object.keys(defs)
  if (
    Object.prototype.hasOwnProperty.call(defs, requested)
  ) {
    return { key: requested }
  }
  const byName = keys.filter(
    k => propertyName(k) === requested,
  )
  if (byName.length === 1) {
    return { key: byName[0] }
  }
  if (byName.length > 1) {
    return {
      error:
        `"${requested}" names ${byName.length} component properties (` +
        `${listed(byName)}) — pass the full property id, not the bare name`,
    }
  }
  return {
    error:
      `no component property named "${requested}"` +
      (keys.length === 0
        ? ' — this component has none'
        : ` — this component has: ${listed(keys)}`),
  }
}

/**
 * What a delete that did not take is told.
 *
 * Figma refuses some removals (a SLOT property, a variant property of a set)
 * and the refusal is not always a throw. Re-reading the definitions after the
 * call is the only way to know, and reporting ok on a property that is still
 * on the panel is the M22 failure in a new place.
 */
export const undeletedMessage = (key: string): string =>
  `component property "${key}" is still defined after deleteComponentProperty — ` +
  'Figma refused the removal (a SLOT property and a variant property of a set ' +
  'are the known cases). Remove it from the component panel in Figma.'
