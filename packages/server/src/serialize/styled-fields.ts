// serialize/styled-fields.ts — a styled field is a reference, not a list.
//
// Figma holds ONE style link per field slot, exclusively: a style owns the
// whole field, or the field is literal. There is no state in which a style and
// an extra literal sit side by side, and assigning the field directly on a
// styled node DETACHES the style (Figma's own behaviour). So the four
// styleable array fields — `fills`, `strokes`, `effects`, `grids` — have
// exactly two write forms (expression-formats.md, "A styled field is a
// reference, not a list"):
//
//   a reference        effects: "style(AB/Blur)"        (the style is the field)
//   a list of literals effects: ["bg-blur(24)", "…"]    (each entry its own atom)
//
// A reference may carry the resolved list a read appends to it —
// `style(AB/Blur)[bg-blur(24)]` — which is what makes a read writable verbatim;
// the list rides along and is NEVER applied as literals.
//
// This module is the SHAPE half of the contract: it reads a field's value into
// one of those two forms, accepts the legacy write sugar, and raises rules 1
// and 2 (the mixes a slot cannot hold). Rules 3 and 4 need the document's own
// style table and live in style-refs.ts, which resolves them before the write
// reaches the plugin.

import { ToolError } from '../errors'
import type { NodeSpecPatch } from '@figma-agent-bridge/shared/node-spec'
import {
  atomToPaint,
  paintToAtom,
  atomToEffect,
  effectToAtom,
  atomToGrid,
  gridToAtom,
} from '../grammar'
import {
  matchClose,
  splitTopLevel,
} from '../grammar/tokenize'

/** The four array fields a style can own. */
export const STYLED_FIELDS = [
  'fills',
  'strokes',
  'effects',
  'grids',
] as const

export type StyledField = (typeof STYLED_FIELDS)[number]

/** The `apply_style` slot each styleable array field belongs to. */
export type StyleSlot =
  | 'fill'
  | 'stroke'
  | 'effect'
  | 'grid'

export const FIELD_SLOT: Record<StyledField, StyleSlot> = {
  fills: 'fill',
  strokes: 'stroke',
  effects: 'effect',
  grids: 'grid',
}

/** The slot each styleable array field is spelled by, inverted. */
export const SLOT_FIELD: Record<StyleSlot, StyledField> = {
  fill: 'fills',
  stroke: 'strokes',
  effect: 'effects',
  grid: 'grids',
}

/** The local-style CATEGORY a slot resolves against (the plugin's vocabulary). */
export const SLOT_CATEGORY: Record<StyleSlot, string> = {
  fill: 'paint',
  stroke: 'paint',
  effect: 'effect',
  grid: 'grid',
}

/**
 * A styleable field's value, read into one of its two forms.
 *
 * `rideAlong` is the resolved list a reference carries — empty for the bare
 * `style(Name)` form. It is never applied as literals; it exists so the write
 * can say whether what the agent believed the style supplies is what it does.
 */
export type StyledValue =
  | { kind: 'reference'; name: string; rideAlong: string[] }
  | { kind: 'literals'; atoms: string[] }

const STYLE_HEAD = 'style('

/**
 * Split a leading `style(Name)` off an atom: `{name, rest}`, or null when the
 * atom carries no style wrapper.
 *
 * Hand-split rather than run through `tokenize`, because the two forms this
 * has to recognise are exactly the two `tokenize` refuses: the BARE reference
 * `style(Name)` (a wrapper with no value — an error on every other field) and
 * `style(Name)[a, b]` (a wrapper on a list, which no other field has). The
 * bracket matcher is the tokenizer's own, so the two cannot disagree about
 * where a name ends.
 */
export const splitStyleWrapper = (
  atom: string,
): { name: string; rest: string } | null => {
  const s = atom.trim()
  if (!s.startsWith(STYLE_HEAD)) {
    return null
  }
  let close: number
  try {
    close = matchClose(s, STYLE_HEAD.length - 1)
  } catch {
    return null
  }
  return {
    name: s.slice(STYLE_HEAD.length, close),
    rest: s.slice(close + 1).trim(),
  }
}

/**
 * The resolved list a reference carries, in every spelling the write face
 * accepts: the bracketed list a read emits, the legacy lone atom beside the
 * style, and nothing at all.
 */
const rideAlongOf = (rest: string): string[] => {
  if (rest === '') {
    return []
  }
  if (rest.startsWith('[')) {
    let close: number
    try {
      close = matchClose(rest, 0)
    } catch {
      return [rest]
    }
    if (close === rest.length - 1) {
      return splitTopLevel(rest.slice(1, -1)).filter(
        s => s.length > 0,
      )
    }
  }
  return [rest]
}

/** Every ride-along entry of a same-name array, in order, as one list. */
const rideAlongOfAll = (
  refs: { rest: string }[],
): string[] => refs.flatMap(r => rideAlongOf(r.rest))

/**
 * The one message rules 1 and 2 carry — it teaches the fix, and names the field
 * the write used (expression-formats.md).
 */
export const mixedStyleMessage = (
  field: StyledField,
): string =>
  `a style owns the whole ${field} list — use a style containing every ` +
  `${FIELD_SLOT[field]} you want, or write them all as literals ` +
  `(a style cannot be combined with literal siblings)`

const rejectMix = (field: StyledField): never => {
  throw new ToolError(
    'INVALID_PARAM',
    mixedStyleMessage(field),
  )
}

/**
 * Read one styleable field's value into a reference or a list of literals.
 *
 * Raises rule 1 (a `style()` entry beside literal siblings) and rule 2 (two or
 * more DIFFERENT `style()` names in one field) — the mixes the slot cannot
 * hold. N entries naming the SAME style are not one of them: they state one
 * owner, which is exactly what the slot has room for.
 *
 * An array whose entries are ALL wrapped by the same style is therefore the
 * legacy write sugar and reads as the reference form, in every one of its
 * spellings: `[style(N)atom]`, `[style(N)]`, the read form array-wrapped out of
 * habit `[style(N)[atom]]`, and the MULTI-ENTRY form the 0.4.0 reader emitted
 * for a multi-value style, `[style(N)a, style(N)b]` — whose entries ride as one
 * resolved list, in order, through the differ like any other spelling.
 */
export const readStyledField = (
  field: StyledField,
  value: string | string[],
): StyledValue => {
  if (!Array.isArray(value)) {
    const ref = splitStyleWrapper(value)
    // A scalar that names no style is one literal atom, not a reference: the
    // field's converter parses it exactly as it would inside a one-entry array.
    return ref === null
      ? { kind: 'literals', atoms: [value] }
      : {
          kind: 'reference',
          name: ref.name,
          rideAlong: rideAlongOf(ref.rest),
        }
  }
  const styled = value
    .map(atom =>
      typeof atom === 'string'
        ? splitStyleWrapper(atom)
        : null,
    )
    .filter(
      (r): r is { name: string; rest: string } =>
        r !== null,
    )
  if (styled.length === 0) {
    return { kind: 'literals', atoms: value }
  }
  // Rule 2 counts OWNERS, not entries: N copies of one name state one owner.
  if (new Set(styled.map(r => r.name)).size > 1) {
    return rejectMix(field)
  }
  // Rule 1: a style that does not cover the whole field is beside literals.
  if (styled.length !== value.length) {
    return rejectMix(field)
  }
  return {
    kind: 'reference',
    name: styled[0].name,
    rideAlong: rideAlongOfAll(styled),
  }
}

/** Every styleable field of a spec, read into its form. Raises rules 1 and 2. */
export const readStyledFields = (
  spec: NodeSpecPatch,
): Partial<Record<StyledField, StyledValue>> => {
  const out: Partial<Record<StyledField, StyledValue>> = {}
  for (const field of STYLED_FIELDS) {
    const value = spec[field]
    if (value !== undefined) {
      out[field] = readStyledField(field, value)
    }
  }
  // A TEXT node's `text.color` IS its first fill, so `fills` and `text.color`
  // are two spellings of ONE slot — and two DIFFERENT styles across them is the
  // cross-field spelling of rule 2, which a per-field check cannot see.
  const color = spec.text?.color
  const colorRef =
    typeof color === 'string'
      ? splitStyleWrapper(color)
      : null
  const { fills } = out
  if (
    colorRef !== null &&
    fills?.kind === 'reference' &&
    fills.name !== colorRef.name
  ) {
    rejectMix('fills')
  }
  return out
}

// ─── canonical atoms (the differ's comparison basis) ──────────────────────────

const CANONICALIZE: Record<
  StyleSlot,
  (atom: string) => string
> = {
  fill: atom => paintToAtom(atomToPaint(atom)),
  stroke: atom => paintToAtom(atomToPaint(atom)),
  effect: atom => effectToAtom(atomToEffect(atom)),
  grid: atom => gridToAtom(atomToGrid(atom)),
}

/**
 * One atom in its canonical rendering, so two spellings of one value compare
 * equal (`rgba(255,0,0,1)` and `#FF0000` are the same paint).
 *
 * An atom this grammar cannot parse is compared as written: the differ is a
 * warning, and a value it cannot read is not a reason to invent a difference.
 */
export const canonicalAtom = (
  slot: StyleSlot,
  atom: string,
): string => {
  try {
    return CANONICALIZE[slot](atom)
  } catch {
    return atom.trim()
  }
}

/** The canonical rendering of a resolved list — `[a, b]`, comma-space. */
export const renderResolvedList = (
  atoms: string[],
): string => `[${atoms.join(', ')}]`
