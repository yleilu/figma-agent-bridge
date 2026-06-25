// grammar/tokenize.ts — split a raw atom string into its three parts.
//
//   [ style(Name) | var(Name) ]  value  [ { key=val, … } ]
//
// Balanced-paren/bracket aware so heads, tuples, nested {tf=[...]}, and
// the inner-arg {…} form all split correctly. Whitespace around commas
// is tolerated; the renderer owns canonical spacing.

import type { Wrapper, Attrs, AttrValue } from './types'

/** The split atom: wrapper + value text + parsed {…} attrs. */
export type Tokens = {
  wrapper?: Wrapper
  /** The value portion: a literal, a tuple, or a head call. */
  body: string
  attrs?: Attrs
}

const isWrapperHead = (
  head: string,
): head is 'style' | 'var' =>
  head === 'style' || head === 'var'

/**
 * Find the index of the matching close bracket for the open bracket at
 * `open` (which must be one of `(` `[` `{`). Throws on imbalance.
 */
const matchClose = (s: string, open: number): number => {
  const pairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
  }
  const openCh = s[open]
  const closeCh = pairs[openCh]
  if (closeCh === undefined) {
    throw new Error(
      `tokenize: expected an open bracket at ${open} in "${s}"`,
    )
  }
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        if (ch !== closeCh) {
          throw new Error(
            `tokenize: mismatched bracket in "${s}"`,
          )
        }
        return i
      }
    }
  }
  throw new Error(
    `tokenize: unbalanced "${openCh}" in "${s}"`,
  )
}

/**
 * Split a comma-separated list at top level only (ignoring commas
 * nested inside any bracket). Trims each segment.
 */
export const splitTopLevel = (s: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
    } else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = s.slice(start).trim()
  if (tail.length > 0 || out.length > 0) {
    out.push(tail)
  }
  return out
}

const parseScalar = (raw: string): AttrValue => {
  const v = raw.trim()
  if (v === 'true') {
    return true
  }
  if (v === 'false') {
    return false
  }
  // A bare number (int/float, optional sign).
  if (/^-?\d+(?:\.\d+)?$/.test(v)) {
    return Number(v)
  }
  return v
}

/** Parse the inner text of a `{…}` block into a typed attr bag. */
export const parseAttrs = (inner: string): Attrs => {
  const attrs: Attrs = {}
  for (const seg of splitTopLevel(inner)) {
    if (seg.length === 0) {
      continue
    }
    const eq = seg.indexOf('=')
    if (eq === -1) {
      throw new Error(
        `tokenize: attr "${seg}" is missing "="`,
      )
    }
    const key = seg.slice(0, eq).trim()
    const valRaw = seg.slice(eq + 1).trim()
    if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
      const items = splitTopLevel(valRaw.slice(1, -1)).map(
        parseScalar,
      ) as (string | number)[]
      attrs[key] = items
    } else {
      attrs[key] = parseScalar(valRaw)
    }
  }
  return attrs
}

/**
 * Split a raw atom into wrapper + body + attrs. The body still holds
 * the value (literal/tuple/head); parse-atom dispatches on it.
 */
export const tokenize = (raw: string): Tokens => {
  let s = raw.trim()
  if (s.length === 0) {
    throw new Error('tokenize: empty atom')
  }

  // 1. Leading wrapper: style(Name) or var(Name).
  let wrapper: Wrapper | undefined
  const headMatch = s.match(/^([A-Za-z][\w-]*)\(/)
  if (headMatch !== null && isWrapperHead(headMatch[1])) {
    const open = headMatch[0].length - 1
    const close = matchClose(s, open)
    wrapper = {
      kind: headMatch[1],
      name: s.slice(open + 1, close),
    }
    s = s.slice(close + 1).trim()
    if (s.length === 0) {
      throw new Error(
        `tokenize: wrapper "${raw}" has no value`,
      )
    }
  }

  // 2. Trailing {…} attrs (after the value, balanced).
  let attrs: Attrs | undefined
  if (s.endsWith('}')) {
    // Find the matching open brace for the final close brace.
    let depth = 0
    let open = -1
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i]
      if (ch === '}' || ch === ')' || ch === ']') {
        depth++
      } else if (ch === '{' || ch === '(' || ch === '[') {
        depth--
        if (depth === 0) {
          open = i
          break
        }
      }
    }
    if (open >= 0 && s[open] === '{') {
      attrs = parseAttrs(s.slice(open + 1, -1))
      s = s.slice(0, open).trim()
    }
  }

  return {
    ...(wrapper !== undefined ? { wrapper } : {}),
    body: s,
    ...(attrs !== undefined ? { attrs } : {}),
  }
}

export { matchClose }
