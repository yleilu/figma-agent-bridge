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
  parseAtom,
  tokenize,
  type Wrapper,
} from '../grammar'
import {
  FIELD_SLOT,
  readStyledFields,
  type StyledField,
} from './styled-fields'

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
  /**
   * Which gradient STOP of the paint at `index` this binds (I59).
   *
   * Absent for every other binding, including a solid paint's — a solid has one
   * colour and the paint IS the slot. A gradient's colours are per stop, so a
   * two-stop banner is two bindings on one paint, and only the stop number
   * tells them apart.
   */
  stop?: number
  /**
   * SERVER-SIDE ONLY — true when this style OWNS its field (the reference form
   * on one of the four styleable array fields), rather than wrapping a literal
   * on a scalar slot. `style-refs.ts` resolves the reference against the
   * document's own styles and strips both this and `rideAlong` before the
   * payload reaches the wire: the plugin applies a style the same way either
   * way, so nothing it does not use is sent to it.
   */
  owns?: boolean
  /**
   * SERVER-SIDE ONLY — the resolved list the reference carried, in the spelling
   * the write used. Never applied as literals; it is what the differ compares
   * against the style's actual content.
   */
  rideAlong?: string[]
}

/**
 * NodeSpec field → the `bind_variable` field that binds it.
 *
 * The layout entries are the B44 half. Figma binds `itemSpacing`, the two grid
 * gaps and each padding SIDE as independent node fields, and the plugin's
 * generic scalar route (`setBoundVariable`) has always been able to write them
 * — what was missing was any route from a `layout.*` wrapper to that field, so
 * an inline `gap: "var(space/8)8"` applied the 8 and dropped the token. `pad`
 * binds by POSITION, exactly as paints bind by index, because the four sides
 * are four fields.
 */
const VAR_ROUTES: Record<string, string> = {
  fills: 'fills',
  strokes: 'strokes',
  stroke: 'strokeWeight',
  radius: 'cornerRadius',
  // A text node's colour IS its fills — the same paint the `fills` route binds.
  'text.color': 'fills',
  'layout.gap': 'itemSpacing',
  'layout.rowGap': 'gridRowGap',
  'layout.colGap': 'gridColumnGap',
  'layout.pad[0]': 'paddingTop',
  'layout.pad[1]': 'paddingRight',
  'layout.pad[2]': 'paddingBottom',
  'layout.pad[3]': 'paddingLeft',
}

/**
 * NodeSpec field → the `apply_style` field that applies it.
 *
 * The four styleable ARRAY fields come from FIELD_SLOT — one table, so the
 * grammar's slot model and the write route cannot drift — plus the two scalar
 * slots, where a `style()` is an ordinary wrapper on a literal.
 */
const STYLE_ROUTES: Record<string, string> = {
  ...FIELD_SLOT,
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
    /** The reference form's resolved list — a style that OWNS its field. */
    rideAlong?: string[],
    /** The gradient stop this binds, for a per-stop token (I59). */
    stop?: number,
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
    const key = `${wrapper.kind}:${route}:${indexed ? index : ''}:${stop ?? ''}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    out.push({
      kind: wrapper.kind,
      name: wrapper.name,
      field: route,
      ...(indexed ? { index } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(rideAlong !== undefined
        ? { owns: true, rideAlong }
        : {}),
    })
  }

  /**
   * Every gradient STOP of one paint atom that names a variable (I59).
   *
   * A gradient's colours are per stop, so the atom-level wrapper cannot say
   * what a two-token banner needs — `linear(...)` wrapped once would claim one
   * variable owns both ends of it. The stops carry their own, and each becomes
   * its own binding on the same paint.
   *
   * A malformed atom is not this scan's error to raise, exactly as `wrapperOf`
   * explains: the field's converter parses the same string a moment later and
   * reports it with the message that field deserves.
   */
  const addStopBindings = (
    field: StyledField,
    atom: string | number | undefined,
    index: number,
  ): void => {
    if (typeof atom !== 'string') {
      return
    }
    let ast
    try {
      ast = parseAtom(atom)
    } catch {
      return
    }
    if (ast.kind !== 'head') {
      return
    }
    let stopIndex = 0
    for (const arg of ast.args) {
      if (arg.kind !== 'stop') {
        continue
      }
      add(field, arg.wrapper, index, undefined, stopIndex)
      stopIndex += 1
    }
  }

  // The four styleable ARRAY fields. A REFERENCE is one binding for the whole
  // field — the style owns it — and carries the resolved list it was written
  // with; a list of LITERALS binds per entry, which is what a var() does.
  const styled = readStyledFields(spec)
  const addStyled = (field: StyledField): void => {
    const value = styled[field]
    if (value === undefined) {
      return
    }
    if (value.kind === 'reference') {
      add(
        field,
        { kind: 'style', name: value.name },
        undefined,
        value.rideAlong,
      )
      return
    }
    value.atoms.forEach((atom, i) => {
      add(field, wrapperOf(atom), i)
      // …and each of that paint's own gradient stops (I59).
      addStopBindings(field, atom, i)
    })
  }
  addStyled('fills')
  addStyled('strokes')
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
  addStyled('effects')
  addStyled('grids')
  // The layout spacing scalars (B44). Each is its own Figma field, so each
  // carries its own wrapper and binds on its own; `pad` binds per SIDE, by
  // position. A `style()` here finds no route and warns, which is right — a
  // style cannot own a gap.
  const { layout } = spec
  add('layout.gap', wrapperOf(layout?.gap))
  add('layout.rowGap', wrapperOf(layout?.rowGap))
  add('layout.colGap', wrapperOf(layout?.colGap))
  layout?.pad?.forEach((side, i) =>
    add(`layout.pad[${i}]`, wrapperOf(side)),
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
