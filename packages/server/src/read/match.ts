// match.ts — predicate builder for NodeSpec filtering.
//
// All predicates compose with AND semantics (every present field must match).
// An empty match {} matches everything.
//
// For componentKey, styleId, variableId, instancesOf: these fields are NOT
// present on NodeSpec directly. The read layer must populate them as augmented
// fields before filtering. The MatchableNode type (NodeSpec + extra fields)
// is used internally; callers pass NodeSpec and the guards read the extras
// via `(n as any).field`. This is documented so P1 wiring can populate them.

import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { Match } from '@figma-agent-bridge/shared/read-model'

/**
 * Augmented NodeSpec with optional extra fields the matcher can test.
 * The read layer (the search plugin scan, B3) populates these before calling
 * the matcher.
 *   componentKey — the INSTANCE's main-component key (getMainComponentAsync)
 *   instancesOf  — the INSTANCE's main-component name
 *   instancesOfSet — the name of the COMPONENT_SET that main belongs to, when
 *                    it is a variant (`State=Error` has it; a stand-alone
 *                    component does not). `match.instancesOf` tests BOTH, so a
 *                    family can be addressed by the name a human reads (B56).
 *   styleId / styleIds   — a style reference id, or (the plugin's emission) the
 *                          node's set of fill/text/effect/stroke/grid style ids
 *   variableId / variableIds — a bound variable id, or (the plugin's emission)
 *                          every id in the node's boundVariables
 *
 * A node can carry SEVERAL style refs / bound variables, so the plugin emits
 * the PLURAL arrays; the matcher matches when the requested id equals the
 * singular field OR ANY entry of the plural array.
 */
type MatchableNode = NodeSpec & {
  componentKey?: string
  styleId?: string
  styleIds?: string[]
  variableId?: string
  variableIds?: string[]
  instancesOf?: string
  instancesOfSet?: string
}

/**
 * The KEY inside a style reference, whichever spelling it arrives in (B85).
 *
 * Two channels now feed `styleIds`. A LIVE scan row carries the Plugin API's
 * `fillStyleId` / `effectStyleId` — `S:<key>,`, with an `S:` prefix and a
 * trailing comma. An EXPORT-served row carries what JSON_REST_V1 put under the
 * node's `styles` map, and the two need not agree on that decoration. The key
 * is what identifies the style in both, so both sides are reduced to it before
 * they are compared — which also means a caller who pasted an id out of
 * `get_styles` is not punished for the spelling it used.
 */
const styleKeyOf = (id: string): string => {
  const withoutPrefix = id.startsWith('S:')
    ? id.slice(2)
    : id
  const comma = withoutPrefix.indexOf(',')
  return comma === -1
    ? withoutPrefix
    : withoutPrefix.slice(0, comma)
}

/** Convert a glob pattern (supports * wildcard) to an anchored RegExp. */
const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${pattern}$`)
}

/**
 * Build a composed AND predicate from a Match spec.
 * Returns a function that tests a NodeSpec (cast to MatchableNode internally).
 *
 * The returned predicate never throws on any node shape.
 */
export const buildMatcher = (
  m: Match,
): ((n: NodeSpec) => boolean) => {
  const predicates: ((n: MatchableNode) => boolean)[] = []

  if (m.name !== undefined) {
    const re = globToRegex(m.name)
    predicates.push(n => re.test(n.name ?? ''))
  }

  if (m.regex !== undefined) {
    // Build the RegExp defensively. matchSchema.regex compile-checks the
    // pattern at parse time, but buildMatcher can be reached by callers that
    // bypass the schema, so we guard here too. On a bad pattern we throw a
    // typed validation error — NOT a silent match-all (which would over-return
    // and quietly hide the agent's mistake) and NOT a raw SyntaxError.
    let re: RegExp
    try {
      re = new RegExp(m.regex)
    } catch (err) {
      const detail =
        err instanceof Error ? `: ${err.message}` : ''
      throw new Error(
        `match.regex: invalid regex pattern ${JSON.stringify(m.regex)}${detail}`,
      )
    }
    predicates.push(n => re.test(n.name ?? ''))
  }

  if (m.type !== undefined) {
    if (Array.isArray(m.type)) {
      const types = new Set(m.type)
      predicates.push(n => types.has(n.type))
    } else {
      const t = m.type
      predicates.push(n => n.type === t)
    }
  }

  if (m.componentKey !== undefined) {
    const ck = m.componentKey
    predicates.push(n => n.componentKey === ck)
  }

  if (m.styleId !== undefined) {
    const sid = styleKeyOf(m.styleId)
    predicates.push(
      n =>
        (n.styleId !== undefined &&
          styleKeyOf(n.styleId) === sid) ||
        (Array.isArray(n.styleIds) &&
          n.styleIds.some(id => styleKeyOf(id) === sid)),
    )
  }

  if (m.variableId !== undefined) {
    const vid = m.variableId
    predicates.push(
      n =>
        n.variableId === vid ||
        (Array.isArray(n.variableIds) &&
          n.variableIds.includes(vid)),
    )
  }

  // `instancesOf` names a FAMILY, and a variant family is named on its SET.
  // A variant component's own name is `State=Error`; the name a human ever
  // sees — the components panel, the design doc, the acceptance gate — is the
  // set's, `State block`. Matching only the main's own name meant a design with
  // two provable instances scored as a missing master (B56). Either name
  // matches; neither is dropped.
  if (m.instancesOf !== undefined) {
    const compName = m.instancesOf
    predicates.push(
      n =>
        n.type === 'INSTANCE' &&
        (n.instancesOf === compName ||
          n.instancesOfSet === compName),
    )
  }

  // Compose all predicates with AND semantics.
  // Empty predicates list (empty match {}) → always true.
  return (n: NodeSpec): boolean => {
    const mn = n as MatchableNode
    return predicates.every(pred => pred(mn))
  }
}
