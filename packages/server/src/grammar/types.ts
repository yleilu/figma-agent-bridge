// grammar/types.ts — the atom AST + shared value model.
//
// One grammar, both faces. The atom shape from
// docs/specs/expression-formats.md is:
//
//   [ style(Name) | var(Name) ]  value  [ { key=val, … } ]
//
// The wrapper (style()/var()) and the {…} attr channel are parsed ONCE
// (parse-atom) and re-emitted ONCE (render-atom); head modules never
// re-implement them — this is the "no special cases" guarantee.

/** style(Name) / var(Name) — a design-system source wrapper. */
export type Wrapper = {
  kind: 'style' | 'var'
  name: string
}

/** A single {…} attribute value. */
export type AttrValue =
  | string
  | number
  | boolean
  | (string | number)[]

/** The {…} attr channel — comma-separated key=val, any atom. */
export type Attrs = Record<string, AttrValue>

/**
 * An argument to a head — a literal scalar, a hex color, an inner
 * tuple, or a gradient stop (color@percent). Heads interpret these
 * positionally.
 */
export type AtomArg =
  | { kind: 'scalar'; value: string | number | boolean }
  | { kind: 'color'; hex: string }
  | { kind: 'stop'; hex: string; position: number }
  | { kind: 'tuple'; items: (string | number)[] }

/**
 * The atom AST: a value (literal | tuple | head) plus the universal
 * optional wrapper and {…} attrs.
 */
export type AtomAST =
  | {
      kind: 'literal'
      value: string | number | boolean
      wrapper?: Wrapper
      attrs?: Attrs
    }
  | {
      kind: 'tuple'
      items: (string | number)[]
      wrapper?: Wrapper
      attrs?: Attrs
    }
  | {
      kind: 'head'
      head: string
      args: AtomArg[]
      wrapper?: Wrapper
      attrs?: Attrs
    }
