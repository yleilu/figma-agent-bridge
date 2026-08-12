// serialize/wrapper-bindings.ts — the binding intent an inline var()/style()
// wrapper carries into a write.
//
// A read emits `var(surface/2)#141B2E`. Writing that atom back applies the
// literal AND re-establishes the binding (expression-formats.md — "var() /
// style() rules"), so the converter has to carry the NAME through to the
// plugin instead of stripping it off with the wrapper. That is all this module
// does: scan the atom-bearing fields of a spec, and turn each wrapper into one
// `bindings[]` entry naming the field the PLUGIN's own handler binds.
//
// The routes below are the two handlers' own field vocabularies, not a third
// list:
//   var(...)   → COMMANDS.BIND_VARIABLE `field` — the paint arrays bind per
//                paint (setBoundVariableForPaint), the scalars bind through
//                setBoundVariable.
//   style(...) → COMMANDS.APPLY_STYLE `field` — fill | stroke | text | effect |
//                grid, each with its own async setter.
//
// A field with no route in either handler is NOT invented here: the literal is
// written and one warning says the binding was not (T7).

import type {
  NodeSpecPatch,
  TextSpec,
} from '@figma-agent-bridge/shared/node-spec'
import {
  atomToStroke,
  tokenize,
  type Wrapper,
} from '../grammar'

/**
 * One binding a converted payload asks the plugin to establish after the
 * literal has landed.
 *
 * `field` is the plugin-side field name (the handler's vocabulary), `index`
 * the paint slot for an array field — a `var()` binds ONE paint, a `style()`
 * governs the whole array and carries no index.
 */
export type WrapperBinding = {
  kind: 'var' | 'style'
  name: string
  field: string
  index?: number
}

/** NodeSpec field → the `bind_variable` field that binds it. */
const VAR_ROUTES: Record<string, string> = {
  fills: 'fills',
  strokes: 'strokes',
  stroke: 'strokeWeight',
  radius: 'cornerRadius',
  // A text node's colour IS its fills — the same paint the `fills` route binds.
  'text.color': 'fills',
}

/** NodeSpec field → the `apply_style` field that applies it. */
const STYLE_ROUTES: Record<string, string> = {
  fills: 'fill',
  strokes: 'stroke',
  effects: 'effect',
  'text.font': 'text',
  'text.color': 'fill',
}

/** The array fields whose `var()` binding is per paint. */
const INDEXED_VAR_FIELDS = new Set(['fills', 'strokes'])

/**
 * The wrapper on an atom, or undefined when there is none.
 *
 * A malformed atom is NOT this scan's error to raise: the field's own
 * converter (atomToPaint / atomToEffect / …) parses the same string a moment
 * later and reports it there, with the message that field deserves. Swallowing
 * it here only means "no wrapper found".
 */
const wrapperOf = (
  atom: string | number | undefined,
): Wrapper | undefined => {
  if (typeof atom !== 'string') {
    return undefined
  }
  try {
    return tokenize(atom).wrapper
  } catch {
    return undefined
  }
}

/**
 * Is this stroke atom the per-side form (`stroke([0,0,1,0])`) rather than the
 * uniform one (`stroke(1)`)?
 *
 * Parsed rather than pattern-matched: the tuple sits inside the atom's head
 * (`stroke([…])`), not at the top of the body the way a radius tuple does, and
 * `atomToStroke` already knows how to find it through a wrapper.
 */
const isPerSideStroke = (
  atom: string | number | undefined,
): boolean => {
  if (typeof atom !== 'string') {
    return false
  }
  try {
    return atomToStroke(atom).weights !== undefined
  } catch {
    return false
  }
}

/**
 * Is this radius atom the per-corner tuple form (`[8,8,0,0]`) rather than the
 * uniform scalar (`8`)?
 */
const isPerCornerRadius = (
  atom: string | number | undefined,
): boolean => {
  if (typeof atom !== 'string') {
    return false
  }
  try {
    return tokenize(atom).body.trim().startsWith('[')
  } catch {
    return false
  }
}

/**
 * Collect every binding the spec's wrappers ask for.
 *
 * `warnings` is the same optional sink `specToFigma` threads: a wrapper on a
 * field this surface cannot bind is reported there and the literal is written
 * anyway (T7) — a missing route costs a binding, never the write.
 */
export const collectWrapperBindings = (
  spec: NodeSpecPatch,
  warnings?: string[],
): WrapperBinding[] => {
  const out: WrapperBinding[] = []
  const seen = new Set<string>()
  const warned = new Set<string>()

  /** One warning per distinct wrapper+field, however many atoms repeat it. */
  const warn = (key: string, message: string): void => {
    if (warned.has(key)) {
      return
    }
    warned.add(key)
    warnings?.push(message)
  }

  const add = (
    specField: string,
    wrapper: Wrapper | undefined,
    index?: number,
  ): void => {
    if (wrapper === undefined) {
      return
    }
    const route =
      wrapper.kind === 'var'
        ? VAR_ROUTES[specField]
        : STYLE_ROUTES[specField]
    if (route === undefined) {
      warn(
        `${wrapper.kind}:${wrapper.name}:${specField}`,
        `${wrapper.kind}(${wrapper.name}) on ${specField}: this surface has ` +
          'no binding route for that field — literal applied unbound',
      )
      return
    }
    // A style() governs the whole array, so it is one binding however many
    // paints repeat it; a var() binds the paint it sits on.
    const indexed =
      wrapper.kind === 'var' &&
      index !== undefined &&
      INDEXED_VAR_FIELDS.has(route)
    const key = `${wrapper.kind}:${route}:${indexed ? index : ''}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    out.push({
      kind: wrapper.kind,
      name: wrapper.name,
      field: route,
      ...(indexed ? { index } : {}),
    })
  }

  spec.fills?.forEach((atom, i) =>
    add('fills', wrapperOf(atom), i),
  )
  spec.strokes?.forEach((atom, i) =>
    add('strokes', wrapperOf(atom), i),
  )
  // stroke binds only in its UNIFORM form, for the same reason radius does
  // (below): Figma has no per-side stroke-weight variable field —
  // `setBoundVariable('strokeWeight')` sets ALL FOUR sides at once (it reads
  // back as four individualStrokeWeights entries aliasing one variable), so
  // binding a per-side atom would square the tuple it just applied and turn
  // `stroke([0,0,1,0])` — a bottom rule — into a full box. Geometry wins, and
  // the loss is announced (T7).
  const strokeWrapper = wrapperOf(spec.stroke)
  if (
    strokeWrapper !== undefined &&
    isPerSideStroke(spec.stroke)
  ) {
    warn(
      `${strokeWrapper.kind}:${strokeWrapper.name}:stroke`,
      `${strokeWrapper.kind}(${strokeWrapper.name}) on a per-side stroke: ` +
        'a single binding cannot express per-side weights — literal applied unbound',
    )
  } else {
    add('stroke', strokeWrapper)
  }
  // radius binds only in its UNIFORM form. Figma has no single radius field:
  // `setBoundVariable('cornerRadius')` binds all four corners at once
  // (live-verified — it reads back as rectangleCornerRadii ×4), so binding a
  // per-corner atom would square the corners the tuple says are different. The
  // read already collapsed WHICH corner was bound, so there is nothing faithful
  // to restore — geometry wins, and the loss is announced (T7).
  const radiusWrapper = wrapperOf(spec.radius)
  if (
    radiusWrapper !== undefined &&
    isPerCornerRadius(spec.radius)
  ) {
    warn(
      `${radiusWrapper.kind}:${radiusWrapper.name}:radius`,
      `${radiusWrapper.kind}(${radiusWrapper.name}) on a per-corner radius: ` +
        'a single binding cannot express per-corner values — literal applied unbound',
    )
  } else {
    add('radius', radiusWrapper)
  }
  spec.effects?.forEach((atom, i) =>
    add('effects', wrapperOf(atom), i),
  )
  spec.grids?.forEach((atom, i) =>
    add('grids', wrapperOf(atom), i),
  )
  const text: Partial<TextSpec> | undefined = spec.text
  add('text.font', wrapperOf(text?.font))
  // `text.color` IS the text node's first fill — index 0, never the whole
  // array. An un-indexed paint binding rebinds EVERY solid paint, which on a
  // two-fill node would destroy the second fill's own (different) binding; the
  // index also dedupes this against an explicit `fills[0]` wrapper.
  add('text.color', wrapperOf(text?.color), 0)
  text?.runs?.forEach(run => {
    add('text.runs[].font', wrapperOf(run.font))
    add('text.runs[].color', wrapperOf(run.color))
  })

  return out
}
