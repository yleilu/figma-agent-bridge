// grammar/parse-atom.ts — raw atom string -> AtomAST.
//
// Dispatches the value on literal | tuple | head. The wrapper and the
// trailing {…} channel are handled by tokenize; an inner-arg {…} form
// (e.g. font(Inter,SemiBold,18,{lh=24}) or stroke(2,{align=INSIDE}))
// is folded into the same attrs so the AST has ONE attr channel.

import type { AtomAST, AtomArg, Attrs } from './types'
import {
  tokenize,
  splitTopLevel,
  parseAttrs,
  matchClose,
} from './tokenize'

const HEX_RE = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/

const parseNumberOrBool = (
  v: string,
): string | number | boolean => {
  if (v === 'true') {
    return true
  }
  if (v === 'false') {
    return false
  }
  if (/^-?\d+(?:\.\d+)?$/.test(v)) {
    return Number(v)
  }
  return v
}

/** rgb(r,g,b) / rgba(r,g,b,a) -> #RRGGBB(AA) uppercase. */
const rgbToHex = (inner: string): string => {
  const parts = splitTopLevel(inner).map(p =>
    Number(p.trim()),
  )
  const [r, g, b, a] = parts
  const ch = (n: number): string =>
    Math.round(n)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  const base = `#${ch(r)}${ch(g)}${ch(b)}`
  if (a !== undefined && a < 1) {
    return `${base}${ch(a * 255)}`
  }
  return base
}

/** Parse a single head argument. */
const parseArg = (raw: string): AtomArg => {
  const v = raw.trim()
  // gradient stop: #color@percent
  const stopMatch = v.match(
    /^(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)@(-?\d+(?:\.\d+)?)$/,
  )
  if (stopMatch !== null) {
    return {
      kind: 'stop',
      hex: stopMatch[1].toUpperCase(),
      position: Number(stopMatch[2]),
    }
  }
  if (HEX_RE.test(v)) {
    return { kind: 'color', hex: v.toUpperCase() }
  }
  // rgb()/rgba() write-only sugar -> normalize to a hex color arg.
  const rgbMatch = v.match(/^(rgba?)\(([^)]*)\)$/)
  if (rgbMatch !== null) {
    return { kind: 'color', hex: rgbToHex(rgbMatch[2]) }
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const items = splitTopLevel(v.slice(1, -1)).map(
      parseNumberOrBool,
    ) as (string | number)[]
    return { kind: 'tuple', items }
  }
  return { kind: 'scalar', value: parseNumberOrBool(v) }
}

/** Resolve a color-sugar head (solid/rgb/rgba) to a hex string. */
const colorSugarToHex = (
  head: 'solid' | 'rgb' | 'rgba',
  args: AtomArg[],
): string => {
  if (head === 'solid') {
    const a = args[0]
    if (a?.kind === 'color') {
      return a.hex
    }
    if (a?.kind === 'scalar') {
      return String(a.value)
    }
    throw new Error('parseAtom: solid() expects a color')
  }
  // rgb(r,g,b) / rgba(r,g,b,a) — args are scalar channels.
  const ch = (n: number): string =>
    Math.round(n)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  const n = (i: number): number =>
    args[i]?.kind === 'scalar' ? Number(args[i].value) : 0
  const base = `#${ch(n(0))}${ch(n(1))}${ch(n(2))}`
  if (head === 'rgba') {
    const alpha = n(3)
    if (alpha < 1) {
      return `${base}${ch(alpha * 255)}`
    }
  }
  return base
}

/**
 * Parse a head's argument list, peeling any inner-arg {…} into attrs.
 * Returns the positional args plus the merged inner attrs.
 */
const parseHeadArgs = (
  inner: string,
): { args: AtomArg[]; innerAttrs?: Attrs } => {
  const segs = splitTopLevel(inner).filter(
    s => s.length > 0,
  )
  const args: AtomArg[] = []
  let innerAttrs: Attrs | undefined
  for (const seg of segs) {
    if (seg.startsWith('{') && seg.endsWith('}')) {
      innerAttrs = {
        ...innerAttrs,
        ...parseAttrs(seg.slice(1, -1)),
      }
      continue
    }
    args.push(parseArg(seg))
  }
  return {
    args,
    ...(innerAttrs !== undefined ? { innerAttrs } : {}),
  }
}

export const parseAtom = (raw: string): AtomAST => {
  const { wrapper, body, attrs } = tokenize(raw)
  const wrap = wrapper !== undefined ? { wrapper } : {}

  // head: name(...)
  const headMatch = body.match(/^([A-Za-z][\w-]*)\(/)
  if (headMatch !== null) {
    const open = headMatch[0].length - 1
    const close = matchClose(body, open)
    if (close !== body.length - 1) {
      throw new Error(
        `parseAtom: trailing text after head in "${raw}"`,
      )
    }
    const { args, innerAttrs } = parseHeadArgs(
      body.slice(open + 1, close),
    )
    const merged: Attrs | undefined =
      attrs !== undefined || innerAttrs !== undefined
        ? { ...innerAttrs, ...attrs }
        : undefined
    const head = headMatch[1]
    // Color-sugar heads collapse to a bare hex literal (the view face).
    // solid(#hex)/solid(rgb(...)), rgb(...), rgba(...) all normalize so
    // the renderer emits "#RRGGBB(AA)", never the sugar head.
    if (
      head === 'solid' ||
      head === 'rgb' ||
      head === 'rgba'
    ) {
      const hex = colorSugarToHex(head, args)
      return {
        kind: 'literal',
        value: hex,
        ...wrap,
        ...(merged !== undefined ? { attrs: merged } : {}),
      }
    }
    return {
      kind: 'head',
      head,
      args,
      ...wrap,
      ...(merged !== undefined ? { attrs: merged } : {}),
    }
  }

  const attrPart = attrs !== undefined ? { attrs } : {}

  // tuple: [a,b,c]
  if (body.startsWith('[')) {
    if (!body.endsWith(']')) {
      throw new Error(
        `parseAtom: unbalanced tuple in "${raw}"`,
      )
    }
    const items = splitTopLevel(body.slice(1, -1)).map(
      parseNumberOrBool,
    ) as (string | number)[]
    return { kind: 'tuple', items, ...wrap, ...attrPart }
  }
  // a stray "(" that isn't a recognized head is malformed
  if (body.includes('(')) {
    throw new Error(
      `parseAtom: malformed head/value in "${raw}"`,
    )
  }

  // literal: hex, number, bool, enum string
  if (HEX_RE.test(body)) {
    return {
      kind: 'literal',
      value: body.toUpperCase(),
      ...wrap,
      ...attrPart,
    }
  }
  return {
    kind: 'literal',
    value: parseNumberOrBool(body),
    ...wrap,
    ...attrPart,
  }
}

/** Read-tolerant variant: null instead of throwing. */
export const tryParseAtom = (
  raw: string,
): AtomAST | null => {
  try {
    return parseAtom(raw)
  } catch {
    return null
  }
}

export { HEX_RE, rgbToHex }
