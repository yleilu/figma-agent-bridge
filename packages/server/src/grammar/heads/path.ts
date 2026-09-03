// grammar/heads/path.ts — the vector-path head (path()).
//
// path(NONZERO,"M0 0 L10 0 Z")
//
// arg0  winding rule: NONZERO | EVENODD | NONE (REQUIRED — see below)
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
//
// BOTH args are required, and a path atom that does not carry them is
// INVALID_PARAM (expression-formats.md — "An atom that does not parse is
// rejected, never guessed at"). The head used to fill both in silently: a
// first arg that was not a winding rule fell back to NONZERO and a missing
// second arg became the empty string, so `path(M 12 0 L 24 24 Z)` — the fill
// rule forgotten, which is the commonest way to write this atom wrong —
// converted to `{windingRule:'NONZERO', data:''}`. Figma accepted that, drew
// nothing, and the node read back `vectorPaths: []` with no warning at all
// (B45). A guess has nothing to fall back on here: the whole shape lives in
// the data string.
//
// The other malformed form stays a DEGRADE, not a rejection: data that parses
// as an atom but that Figma refuses (`path(NONZERO,"garbage")`) is an ENGINE
// refusal — the node lands, the field drops, and the plugin reports Figma's
// own error on `warnings[]`.

import type { AtomAST, AtomArg } from '../types'
import { parseAtom } from '../parse-atom'
import { renderAtom } from '../render-atom'
import { ToolError } from '../../errors'
import { normalizeSvgCommands } from '../svg-path'

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

/**
 * The canonical form, in every rejection message. A rejection that only says
 * what is wrong makes the agent guess the fix, and guessing this atom is what
 * B45 was.
 */
export const PATH_TEACHING =
  'Write the fill rule first, then the SVG path data in double quotes — path(NONZERO,"M 0 0 L 24 24").'

/** Every path rejection: INVALID_PARAM, and the canonical form to write. */
const rejectPath = (why: string): never => {
  throw new ToolError(
    'INVALID_PARAM',
    `${why} ${PATH_TEACHING}`,
  )
}

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
 * Normalize SVG path data for the atom: replace comma separators with spaces.
 * The SVG spec allows commas between coordinates as whitespace equivalents;
 * replacing them prevents the grammar's comma-split from misreading the data arg.
 */
const normalizePathData = (data: string): string =>
  data.replace(/,/g, ' ').replace(/\s{2,}/g, ' ')

/**
 * Parse a path atom string into a Figma VectorPath object.
 *
 *   path(NONZERO,"M0 0 L10 0 Z")  →  { windingRule: 'NONZERO', data: 'M0 0 L10 0 Z' }
 *
 * Raises `INVALID_PARAM` on every atom it cannot read — the write reaches no
 * plugin, so a rejected path has changed nothing.
 */
export const atomToPath = (s: string): FigmaVectorPath => {
  let ast: AtomAST
  try {
    ast = parseAtom(s)
  } catch {
    // An unbalanced or malformed atom is the agent's parameter, not a plugin
    // fault — say so with the code that names it.
    return rejectPath(`"${s}" is not a path atom.`)
  }
  if (ast.kind !== 'head' || ast.head !== 'path') {
    return rejectPath(`"${s}" is not a path atom.`)
  }
  const { args } = ast
  if (args.length < 2) {
    return rejectPath(
      `path() takes a fill rule and the path data, but "${s}" carries ${args.length === 0 ? 'neither' : 'only one'}.`,
    )
  }

  // arg0: winding rule scalar (e.g. NONZERO)
  const windingRaw = scalar(args[0])
  if (
    typeof windingRaw !== 'string' ||
    !WINDING_RULES.has(windingRaw as WindingRule)
  ) {
    return rejectPath(
      `path() takes NONZERO, EVENODD or NONE as its fill rule, not "${String(windingRaw ?? '')}".`,
    )
  }
  const windingRule = windingRaw as WindingRule

  // arg1…: SVG path data (stored in double-quotes in the atom).
  //
  // Everything after the fill rule is the data, rejoined. SVG allows a comma
  // wherever it allows a space, and the grammar's tokenizer splits a head's
  // args on every top-level comma — so `path(NONZERO,"M0,0 L10,0 Z")`, the
  // form an agent copies straight out of an SVG file, arrives here as FOUR
  // args and used to keep `"M0` as the whole shape. Rejoining and then
  // normalizing is what makes the write face's own promise true (commas are
  // normalized to spaces on write — expression-formats.md).
  //
  // …and then the COMMANDS are normalized (B77). Figma's own converter refuses
  // `H`, `V` and `A` — `path(NONE,"M 4 4 H 10 V 10 H 4 Z")` came back as
  // "Failed to convert path. Invalid command at H" with the node landed and
  // its geometry gone — while `grammar.md` promises that data copied straight
  // out of an SVG file lands as written. Every refused command is pure syntax
  // sugar over one Figma takes, so the surface performs the conversion the
  // caller would otherwise have to do by hand. See svg-path.ts. Data with
  // nothing to rewrite comes back as the same string, so the read → write
  // round trip is untouched.
  const data = normalizeSvgCommands(
    normalizePathData(
      unquote(
        args
          .slice(1)
          .map(a => String(scalar(a) ?? ''))
          .join(','),
      ),
    ),
  )
  if (data.trim() === '') {
    return rejectPath(`"${s}" carries no path data.`)
  }

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
