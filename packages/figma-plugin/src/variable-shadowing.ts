// variable-shadowing.ts — a variable NAME is not unique, and B66 is what that
// costs in the two places it bites.
//
// Figma scopes a variable's name to its COLLECTION. Two collections can both
// hold `brand/primary`, and nothing in the file says so. This surface addresses
// variables BY NAME everywhere an agent writes one — `var(brand/primary)` in an
// atom, `create_variables` by name — and a name lookup has to pick one. It
// picks the first (bind-wrappers.ts, `loadVariables`), deterministically, and
// says nothing about the one it did not pick.
//
// Two moments, one fact:
//
//   CREATE — a new variable takes a name another collection already holds. The
//            collision is introduced here, silently, and every later binding by
//            that name is a coin toss the caller never sees flipped.
//   BIND   — an inline `var(name)literal` resolves to a variable whose value is
//            not the literal the atom stated. The write applies the literal,
//            the binding overrules it, and the node renders a colour nobody
//            asked for. Three live reproductions.
//
// THE VALUE COMPARISON IS THE SIGNAL; THE SHADOW LIST IS THE EXPLANATION. A
// shadowed name is not an error — a design system may legitimately mirror a
// name across collections — so warning on every shadow would be noise. A
// binding whose resolved value contradicts the literal beside it is a mistake
// whether or not a shadow explains it, and when one does, naming both
// collections turns "this is wrong" into "here is why".
//
// Structural types on both sides, so this is testable without a Figma runtime.

/** A variable, as much of one as shadowing has to see. */
export type VariableLike = {
  id?: unknown
  name?: unknown
  variableCollectionId?: unknown
  valuesByMode?: unknown
}

/** The literal an atom stated, in the shape a mode value can be compared to. */
export type StatedValue =
  | {
      kind: 'color'
      rgba: [number, number, number, number]
    }
  | { kind: 'number'; value: number }

/**
 * Does the variable hold this value in ANY of its modes?
 *
 * Tri-state on purpose. `unknown` is not `differs`: a variable whose modes hold
 * aliases, or whose values this runtime does not expose, gives no evidence
 * either way, and a warning built on no evidence is worse than silence.
 *
 * ANY mode rather than THE mode, because the mode a node resolves in depends on
 * its ancestors and this code cannot see them. A variable that holds the stated
 * value somewhere is a plausible thing to have named; one that holds it nowhere
 * is not.
 */
export const holdsValue = (
  variable: VariableLike,
  stated: StatedValue,
): 'match' | 'differs' | 'unknown' => {
  const byMode = variable.valuesByMode
  if (typeof byMode !== 'object' || byMode === null) {
    return 'unknown'
  }
  const values = Object.values(
    byMode as Record<string, unknown>,
  )
  if (values.length === 0) return 'unknown'
  let comparable = 0
  for (const value of values) {
    const verdict = compareOne(value, stated)
    if (verdict === 'match') return 'match'
    if (verdict === 'differs') comparable += 1
  }
  return comparable > 0 ? 'differs' : 'unknown'
}

// Figma stores a colour channel as a 0..1 float and an atom states it as an
// 8-bit hex, so a faithful round trip lands within half a step of 1/255.
const COLOR_EPSILON = 0.003

// A stated number is what the caller typed. Anything past float noise is a
// different number.
const NUMBER_EPSILON = 0.001

const compareOne = (
  value: unknown,
  stated: StatedValue,
): 'match' | 'differs' | 'unknown' => {
  if (stated.kind === 'number') {
    return typeof value !== 'number'
      ? 'unknown'
      : Math.abs(value - stated.value) < NUMBER_EPSILON
        ? 'match'
        : 'differs'
  }
  if (typeof value !== 'object' || value === null) {
    return 'unknown'
  }
  const c = value as {
    r?: unknown
    g?: unknown
    b?: unknown
    a?: unknown
  }
  if (
    typeof c.r !== 'number' ||
    typeof c.g !== 'number' ||
    typeof c.b !== 'number'
  ) {
    return 'unknown'
  }
  const alpha = typeof c.a === 'number' ? c.a : 1
  const [r, g, b, a] = stated.rgba
  return Math.abs(c.r - r) < COLOR_EPSILON &&
    Math.abs(c.g - g) < COLOR_EPSILON &&
    Math.abs(c.b - b) < COLOR_EPSILON &&
    Math.abs(alpha - a) < COLOR_EPSILON
    ? 'match'
    : 'differs'
}

/** The stated value a SOLID paint carries, or undefined for anything else. */
export const statedFromPaint = (
  paint: unknown,
): StatedValue | undefined => {
  const p = paint as {
    type?: unknown
    color?: { r?: unknown; g?: unknown; b?: unknown }
    opacity?: unknown
  } | null
  if (p === null || p?.type !== 'SOLID') return undefined
  const c = p.color
  if (
    typeof c?.r !== 'number' ||
    typeof c?.g !== 'number' ||
    typeof c?.b !== 'number'
  ) {
    return undefined
  }
  return {
    kind: 'color',
    rgba: [
      c.r,
      c.g,
      c.b,
      typeof p.opacity === 'number' ? p.opacity : 1,
    ],
  }
}

/** The stated value a scalar node field carries, or undefined. */
export const statedFromScalar = (
  value: unknown,
): StatedValue | undefined =>
  typeof value === 'number'
    ? { kind: 'number', value }
    : undefined

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

/**
 * The collections, by NAME, that hold `name` — minus the one at `except`.
 *
 * A collection this runtime cannot name is reported by its id rather than
 * dropped: an unnamed collision is still a collision, and the id is at least
 * something a caller can look up.
 */
export const otherCollectionsHolding = (
  name: string,
  variables: readonly VariableLike[],
  collectionNameById: Readonly<Record<string, string>>,
  except?: string,
): string[] => {
  const out: string[] = []
  for (const v of variables) {
    if (str(v.name) !== name) continue
    const cid = str(v.variableCollectionId)
    if (cid === undefined || cid === except) continue
    const label = collectionNameById[cid] ?? cid
    if (!out.includes(label)) out.push(label)
  }
  return out
}

/** What a create says when the name it minted was already taken elsewhere. */
export const createShadowWarning = (
  name: string,
  into: string,
  others: readonly string[],
): string =>
  'variable "' +
  name +
  '" now exists in "' +
  into +
  '" and also in ' +
  others.map(c => '"' + c + '"').join(', ') +
  '. A name is unique per COLLECTION, not per file, and this surface binds ' +
  'by name — var(' +
  name +
  ') resolves to whichever collection is enumerated first, which is not ' +
  'something the caller controls. Rename one, or bind by id with ' +
  'bind_variable.'

/** What a binding says when the token it resolved contradicts its literal. */
export const bindMismatchWarning = (
  name: string,
  others: readonly string[],
): string =>
  'var(' +
  name +
  ') resolves to a variable that does not hold the literal stated beside it. ' +
  'The binding wins, so this node renders the variable’s value, not the ' +
  'literal.' +
  (others.length === 0
    ? ' Check that the atom names the token you meant.'
    : ' The name is also defined in ' +
      others.map(c => '"' + c + '"').join(', ') +
      ', and a name lookup takes the first collection it enumerates. Rename ' +
      'one, or bind by id with bind_variable.')
