// grammar/heads/path.ts — the vector-path head (path()).
//
// path(NONZERO,"M0 0 L10 0 Z")
//
// arg0  winding rule: NONZERO | EVENODD | NONE (default NONZERO)
// arg1  SVG path data in double-quotes (spaces as separators, not commas)
//
// Maps the atom <-> a Figma VectorPath object
// { windingRule: 'NONZERO'|'EVENODD'|'NONE', data: string }.
//
// NOTE: The data arg is stored with surrounding double-quotes so that
// spaces inside the path data (e.g. "M0 0 L10 0 Z") survive the grammar
// tokenizer's comma-split without ambiguity. atomToPath strips the
// surrounding quotes on parse; pathToAtom wraps the data in quotes.
//
// SVG path data commas are normalized to spaces on the write path so the
// canonical atom never contains a bare comma in the data field.

import type { AtomAST, AtomArg } from '../types'
import { parseAtom } from '../parse-atom'
import { renderAtom } from '../render-atom'

export type FigmaVectorPath = {
  windingRule: 'NONZERO' | 'EVENODD' | 'NONE'
  data: string
}

type WindingRule = FigmaVectorPath['windingRule']

const WINDING_RULES = new Set<WindingRule>([
  'NONZERO',
  'EVENODD',
  'NONE',
])

const DEFAULT_WINDING: WindingRule = 'NONZERO'

const scalar = (
  a: AtomArg | undefined,
): string | number | boolean | undefined =>
  a !== undefined && a.kind === 'scalar'
    ? a.value
    : undefined

/**
 * Strip surrounding double-quotes from a scalar arg value that was parsed
 * from a quoted atom argument like `"M0 0 L10 0 Z"`.
 */
const unquote = (v: string): string => {
  if (
    v.startsWith('"') &&
    v.endsWith('"') &&
    v.length >= 2
  ) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Parse a path atom string into a Figma VectorPath object.
 *
 *   path(NONZERO,"M0 0 L10 0 Z")  →  { windingRule: 'NONZERO', data: 'M0 0 L10 0 Z' }
 */
export const atomToPath = (s: string): FigmaVectorPath => {
  const ast = parseAtom(s)
  if (ast.kind !== 'head' || ast.head !== 'path') {
    throw new Error(
      `atomToPath: not a path atom — got "${s}"`,
    )
  }
  const { args } = ast

  // arg0: winding rule scalar (e.g. NONZERO)
  const windingRaw = scalar(args[0])
  const windingRule: WindingRule =
    typeof windingRaw === 'string' &&
    WINDING_RULES.has(windingRaw as WindingRule)
      ? (windingRaw as WindingRule)
      : DEFAULT_WINDING

  // arg1: SVG path data (stored in double-quotes in the atom)
  const dataRaw = scalar(args[1])
  const data: string =
    typeof dataRaw === 'string' ? unquote(dataRaw) : ''

  return { windingRule, data }
}

/**
 * Normalize SVG path data for the atom: replace comma separators with spaces.
 * The SVG spec allows commas between coordinates as whitespace equivalents;
 * replacing them prevents the grammar's comma-split from misreading the data arg.
 */
const normalizePathData = (data: string): string =>
  data.replace(/,/g, ' ').replace(/\s{2,}/g, ' ')

/**
 * Render a Figma VectorPath object to a path atom string.
 *
 *   { windingRule: 'EVENODD', data: 'M0 0 L10 0 Z' }  →  path(EVENODD,"M0 0 L10 0 Z")
 */
export const pathToAtom = (p: FigmaVectorPath): string => {
  const args: AtomArg[] = [
    { kind: 'scalar', value: p.windingRule },
    // Embed surrounding double-quotes in the scalar value so the grammar
    // renders them verbatim: path(NONZERO,"M0 0 L10 0 Z").
    // Commas inside the data are normalized to spaces first (SVG allows either)
    // so the grammar's comma-split in splitTopLevel never sees a data comma.
    {
      kind: 'scalar',
      value: `"${normalizePathData(p.data)}"`,
    },
  ]
  const ast: AtomAST = {
    kind: 'head',
    head: 'path',
    args,
  }
  return renderAtom(ast)
}
