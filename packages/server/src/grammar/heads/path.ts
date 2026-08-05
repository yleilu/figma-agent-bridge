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
  /**
   * Per-point corner radii, SPARSE and keyed by point index — the order the
   * `data` string visits its points, subpaths included (verified live: a
   * vertex's position in Figma's network is that same order, and several
   * subpaths stay one flat sequence in one `data` string).
   *
   * Sparse because it has to scale: a 500-point illustration with three
   * rounded corners carries three entries, not five hundred (T4, T10). Absent
   * entirely when no point is rounded — which is every vector this grammar
   * authors, so an ordinary read is unchanged.
   */
  corners?: Record<number, number>
  /**
   * Per-point stroke caps, same sparse index basis as `corners`. The values are
   * the **Plugin API** spelling (`ARROW_LINES`, not REST's `LINE_ARROW`) —
   * expression-formats.md fixes one vocabulary because only that one writes.
   *
   * This is the key an arrow needs: a line that points one way carries a
   * different cap at each end, which the node-level `stroke(){cap=}` cannot
   * hold.
   */
  caps?: Record<number, string>
  /** Per-point stroke joins, same sparse index basis as `corners` and `caps`. */
  joins?: Record<number, string>
}

/** Plugin API StrokeCap. REST's two arrow spellings are normalized before here. */
const STROKE_CAPS = new Set([
  'NONE',
  'ROUND',
  'SQUARE',
  'ARROW_LINES',
  'ARROW_EQUILATERAL',
])

/** Plugin API StrokeJoin — the same three names REST uses, no divergence here. */
const STROKE_JOINS = new Set(['MITER', 'BEVEL', 'ROUND'])

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

const asRadius = (v: string): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const asStrokeCap = (v: string): string | undefined =>
  STROKE_CAPS.has(v) ? v : undefined

const asStrokeJoin = (v: string): string | undefined =>
  STROKE_JOINS.has(v) ? v : undefined

/**
 * Read an `index:value` sparse list out of the atom's `{…}` channel.
 *
 * The tokenizer already hands back each `1:10` as one array element, so this
 * only splits and validates — no new grammar was needed for any of these keys.
 * A malformed or unrecognized entry is **skipped, never thrown**: a read that
 * died mid-serialization over one odd pair would cost the whole node.
 *
 * Returns `undefined` rather than `{}` when nothing survives, so callers can
 * omit the key entirely and an ordinary read stays byte-for-byte unchanged.
 */
const readSparse = <T>(
  raw: unknown,
  value: (s: string) => T | undefined,
): Record<number, T> | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const out: Record<number, T> = {}
  for (const entry of raw) {
    const [i, ...rest] = String(entry).split(':')
    const idx = Number(i)
    const parsed = value(rest.join(':'))
    if (
      Number.isInteger(idx) &&
      idx >= 0 &&
      parsed !== undefined
    ) {
      out[idx] = parsed
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
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

  const corners = readSparse(ast.attrs?.corners, asRadius)
  const caps = readSparse(ast.attrs?.caps, asStrokeCap)
  const joins = readSparse(ast.attrs?.joins, asStrokeJoin)

  return {
    windingRule,
    data,
    ...(corners === undefined ? {} : { corners }),
    ...(caps === undefined ? {} : { caps }),
    ...(joins === undefined ? {} : { joins }),
  }
}

/**
 * Normalize SVG path data for the atom: replace comma separators with spaces.
 * The SVG spec allows commas between coordinates as whitespace equivalents;
 * replacing them prevents the grammar's comma-split from misreading the data arg.
 */
const normalizePathData = (data: string): string =>
  data.replace(/,/g, ' ').replace(/\s{2,}/g, ' ')

/**
 * Render a sparse map back to `index:value` entries, sorted so the atom is
 * deterministic, and `undefined` when there is nothing to say — which is how
 * a vector authored through this grammar renders exactly as it did before
 * these keys existed.
 */
const writeSparse = (
  m: Record<number, number | string> | undefined,
): string[] | undefined => {
  const entries = Object.entries(m ?? {})
    .map(([i, v]) => [Number(i), v] as const)
    .filter(([i]) => Number.isInteger(i) && i >= 0)
    .sort((a, b) => a[0] - b[0])
  if (entries.length === 0) {
    return undefined
  }
  return entries.map(([i, v]) => `${i}:${String(v)}`)
}

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
  const corners = writeSparse(p.corners)
  const caps = writeSparse(p.caps)
  const joins = writeSparse(p.joins)
  const attrs = {
    ...(corners === undefined ? {} : { corners }),
    ...(caps === undefined ? {} : { caps }),
    ...(joins === undefined ? {} : { joins }),
  }
  const ast: AtomAST = {
    kind: 'head',
    head: 'path',
    args,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
  }
  return renderAtom(ast)
}
