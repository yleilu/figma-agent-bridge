// construction-defaults.ts — Figma's own create defaults, declared where the
// caller is (B86, and the B12/B16/I13 family behind it).
//
// THE FAMILY, AND ITS STANDING RULING. Figma's create APIs return a PAINTED
// node: a frame is opaque white, a rectangle #D9D9D9, a text node black, a
// vector carries a black 1px stroke. B16 ruled in 2026-08-06 that the bridge
// does not neutralise those — a designer drawing the same shape by hand gets
// them too, they round-trip stably, and `fills: []` / `strokes: []` clears
// them. That ruling closed B12 and I13 with it, and its remedy was the table in
// `expression-formats.md` § "A create that names no fills/strokes inherits
// Figma's default for that type".
//
// THE REMEDY DID NOT REACH THE CALLER. B86, live 2026-09-01: a naive operator
// sent a logo VECTOR inside `create_tree` with a full child spec and NO
// `strokes` key, and got back a 1px black rim on a gradient mark — invisible on
// a dark ground at small sizes, and an off-palette hardcode in every colour
// audit. Same round, the same operator only avoided the white-FRAME half
// because a QA skill it happened to load says "pass fills:[] on structural
// frames"; the 2026-08-13 build without that sentence shipped 16 white slabs
// over a dark screen and found them by eye in a PNG.
//
// Four sightings of one defect across four builds is a documentation failure,
// not a caller failure. So the ruling stands — what lands is unchanged, and
// nothing is neutralised — and the DECLARATION moves from the spec to the
// reply. One aggregated line per create call, naming the count, the type, the
// field and the way to opt out.
//
// Structural (`Record<string, unknown>`), so it is testable without a Figma
// runtime.

/** The field Figma paints when a spec of this type says nothing about it. */
const DEFAULT_FIELD: Record<string, 'fills' | 'strokes'> = {
  FRAME: 'fills',
  COMPONENT: 'fills',
  RECTANGLE: 'fills',
  ELLIPSE: 'fills',
  STAR: 'fills',
  POLYGON: 'fills',
  TEXT: 'fills',
  VECTOR: 'strokes',
  LINE: 'strokes',
}

/** One node that came out of Figma wearing a default nobody asked for. */
export type ConstructionDefault = {
  type: string
  field: 'fills' | 'strokes'
}

/**
 * What a freshly created node inherited on a field its spec never mentioned.
 *
 * Read BEFORE the spec is applied, which is the only moment the node holds
 * Figma's answer and nothing else.
 *
 * A TEXT node's fill is its COLOUR, and the grammar spells that
 * `text:{color}` — so a spec that states the colour has stated the fill, and
 * reporting it would be noise on the one type where the caller almost always
 * does say.
 */
export const unstatedDefaultOf = (
  spec: Record<string, unknown>,
  node: Record<string, unknown>,
): ConstructionDefault | undefined => {
  const type = spec.type
  if (typeof type !== 'string') return undefined
  const field = DEFAULT_FIELD[type]
  if (field === undefined) return undefined
  if (spec[field] !== undefined) return undefined
  if (type === 'TEXT') {
    const text = spec.text as
      | Record<string, unknown>
      | undefined
    if (text?.color !== undefined) return undefined
  }
  let value: unknown
  try {
    value = node[field]
  } catch {
    // A node that will not answer cannot be reported on.
    return undefined
  }
  return Array.isArray(value) && value.length > 0
    ? { type, field }
    : undefined
}

/**
 * The one line a create call says about every default it inherited, or
 * undefined when it inherited none.
 *
 * AGGREGATED, and that is not cosmetic: an unaided build leaves the fill
 * unstated on every structural frame, so one line per node would be sixteen
 * copies of one sentence — the noise I41 is filed about. The count is the
 * news; the remedy is the same for all of them.
 */
export const constructionDefaultsWarning = (
  defaults: readonly ConstructionDefault[],
): string | undefined => {
  if (defaults.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const d of defaults) {
    const key = d.type + ' ' + d.field
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parts = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => key + ' ×' + n)
  return (
    defaults.length +
    ' node(s) kept Figma’s own construction default on a field this spec ' +
    'never stated: ' +
    parts.join(', ') +
    '. A frame is born opaque white, a shape #D9D9D9, a vector with a black ' +
    '1px stroke — so an unstated field is a painted field, not an empty one, ' +
    'and it reads as an off-palette literal in any colour audit. Pass ' +
    '`fills: []` / `strokes: []` to mean none.'
  )
}
