// grammar/render-atom.ts — AtomAST -> canonical view-face atom string.
//
// Inverse of parse-atom. Emits the lossy, compact VIEW form:
//   - hex (6/8-char UPPERCASE, no shorthand), never rgb()/rgba()
//   - the {…} channel is always TRAILING (never the inner-arg form)
//   - canonical spacing (Decision: gradients use ", " between args,
//     all other heads use ",", and {…} keys are ", "-separated). This
//     makes the worked example in expression-formats.md round-trip
//     exactly: linear(135, #..@0, #..@100) but shadow(0,4,12,#..) and
//     font(Inter,SemiBold,18).

import type {
  AtomAST,
  AtomArg,
  Attrs,
  Wrapper,
} from './types'

/** Heads whose argument list is rendered with ", " (comma+space). */
const SPACED_HEADS = new Set([
  'linear',
  'radial',
  'angular',
  'diamond',
])

// Exported so the read-face reader (node-spec-reader.ts) can wrap a
// binding-carrying leaf through the ONE grammar renderer instead of
// hand-concatenating `${kind}(${name})` itself (T8 — one grammar, both
// faces). Do not change its behaviour when exporting.
export const renderWrapper = (w?: Wrapper): string =>
  w === undefined ? '' : `${w.kind}(${w.name})`

const renderScalar = (
  v: string | number | boolean,
): string => String(v)

const renderArg = (arg: AtomArg): string => {
  switch (arg.kind) {
    case 'scalar':
      return renderScalar(arg.value)
    case 'color':
      return arg.hex
    case 'stop':
      return `${arg.hex}@${arg.position}`
    case 'tuple':
      return `[${arg.items.map(renderScalar).join(',')}]`
    default:
      return ''
  }
}

const renderAttrValue = (
  v: string | number | boolean | (string | number)[],
): string => {
  if (Array.isArray(v)) {
    return `[${v.map(renderScalar).join(',')}]`
  }
  return renderScalar(v)
}

/** Render the trailing {…} channel (", "-separated, insertion order). */
const renderAttrs = (attrs?: Attrs): string => {
  if (attrs === undefined) {
    return ''
  }
  const keys = Object.keys(attrs)
  if (keys.length === 0) {
    return ''
  }
  const body = keys
    .map(k => `${k}=${renderAttrValue(attrs[k])}`)
    .join(', ')
  return `{${body}}`
}

export const renderAtom = (ast: AtomAST): string => {
  const wrap = renderWrapper(ast.wrapper)
  const attrs = renderAttrs(ast.attrs)

  if (ast.kind === 'literal') {
    return `${wrap}${renderScalar(ast.value)}${attrs}`
  }
  if (ast.kind === 'tuple') {
    const body = ast.items.map(renderScalar).join(',')
    return `${wrap}[${body}]${attrs}`
  }
  // head
  const sep = SPACED_HEADS.has(ast.head) ? ', ' : ','
  const args = ast.args.map(renderArg).join(sep)
  return `${wrap}${ast.head}(${args})${attrs}`
}
