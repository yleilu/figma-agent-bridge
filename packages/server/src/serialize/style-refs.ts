// serialize/style-refs.ts — resolve a styled field's reference before the write
// reaches the document.
//
// `styled-fields.ts` reads a field into a reference or a list of literals and
// raises the two mixes a slot cannot hold (rules 1 and 2). The other two
// rejections need the document's own style table:
//
//   3. a reference whose name resolves to a style of the WRONG TYPE for the slot
//   4. a reference whose name resolves to NOTHING
//
// Both are errors rather than the degrade a wrapper-on-a-literal gets: a
// reference has no literal half, so degrading would write nothing at all and
// call it success (expression-formats.md).
//
// The same resolution answers the third question the write has to ask — whether
// the resolved list the reference carried is what the style actually supplies.
// It is a WARNING, never a rejection: a style edited between the read and the
// write must not turn a correct write-back into an error. A verbatim write-back
// never fires it, because the list a read emitted IS the style's content.
//
// The walk is over the CONVERTED payload rather than the spec, so one
// implementation covers every write path — create_node, create_tree (children
// and the ref pool), update_node, update_component's slots and batch's ops.
//
// And it is reached through ONE door: `sendConvertedWrite` is the only way a
// converted payload gets to the plugin, so the gate is structural rather than
// something five handlers each remember to call. A sixth write path cannot skip
// rules 3/4 — skipping them would send a field with no literals and a style
// binding that cannot be made, i.e. write nothing and call it success — and
// cannot leak the server-side binding markers either. `tools/write-gate.test.ts`
// fails if a converting module ever sends by another route.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import { ToolError } from '../errors'
import {
  paintToAtom,
  effectToAtom,
  gridToAtom,
  type FigmaPaint,
  type FigmaEffect,
  type FigmaLayoutGrid,
} from '../grammar'
import {
  SLOT_CATEGORY,
  SLOT_FIELD,
  canonicalAtom,
  renderResolvedList,
  type StyleSlot,
} from './styled-fields'
import type { WrapperBinding } from './wrapper-bindings'

/** One local style, with its content rendered to canonical atoms. */
export type StyleRecord = {
  name: string
  /** paint | text | effect | grid — the local-style category. */
  category: string
  /**
   * The style's content as canonical atoms, or undefined when this read cannot
   * render it (a TEXT style, which is a scalar slot; or a value the grammar
   * does not speak). Undefined means "no honest comparison", not "empty".
   */
  atoms?: string[]
}

/** Name → every local style that carries it, across categories. */
export type StyleTable = Map<string, StyleRecord[]>

/** Resolves the document's local styles ONCE per tool call, on first demand. */
export type StyleCatalogue = {
  table: () => Promise<StyleTable>
}

type RawStyleEntry = {
  id?: string
  name?: string
  value?: unknown
  /**
   * EVERY entry of the style's content (all paints / all effects / all grids).
   * A style is a whole list, so `value` — the first entry, which the
   * `get_styles` read renders — cannot answer what the style supplies.
   */
  values?: unknown[]
}

const RENDERERS: Record<
  string,
  (value: unknown) => string
> = {
  paint: v => paintToAtom(v as FigmaPaint),
  effect: v => effectToAtom(v as FigmaEffect),
  grid: v => gridToAtom(v as FigmaLayoutGrid),
}

/** A style's content as canonical atoms; undefined when it cannot be rendered. */
const atomsOf = (
  category: string,
  entry: RawStyleEntry,
): string[] | undefined => {
  const render = RENDERERS[category]
  const { values } = entry
  if (render === undefined || !Array.isArray(values)) {
    return undefined
  }
  try {
    return values.map(render)
  } catch {
    return undefined
  }
}

const STYLE_CATEGORIES = [
  'paint',
  'text',
  'effect',
  'grid',
] as const

/**
 * A lazy, per-call view of the document's local styles.
 *
 * One `get_styles` round trip, and only when a write actually names a style on
 * one of the four styleable array fields — an unstyled write costs nothing.
 */
export const createStyleCatalogue = (
  client: ScopedFigmaClient,
): StyleCatalogue => {
  let pending: Promise<StyleTable> | null = null
  const load = async (): Promise<StyleTable> => {
    const raw = (await client.sendCommand(
      COMMANDS.GET_STYLES,
      {},
    )) as
      | (Record<string, unknown> & {
          error?: string
        })
      | null
    if (raw === null) {
      throw new Error(
        'Failed to read this file’s styles; the style a write named could not be resolved.',
      )
    }
    if (raw.error !== undefined) {
      throw new Error(raw.error)
    }
    const table: StyleTable = new Map()
    for (const category of STYLE_CATEGORIES) {
      const entries = raw[category]
      if (!Array.isArray(entries)) {
        continue
      }
      for (const entry of entries as RawStyleEntry[]) {
        const { name } = entry
        if (typeof name !== 'string') {
          continue
        }
        const record: StyleRecord = { name, category }
        const atoms = atomsOf(category, entry)
        if (atoms !== undefined) {
          record.atoms = atoms
        }
        const existing = table.get(name)
        if (existing === undefined) {
          table.set(name, [record])
        } else {
          existing.push(record)
        }
      }
    }
    return table
  }
  return {
    table: () => {
      pending ??= load()
      return pending
    },
  }
}

// ─── the walk ─────────────────────────────────────────────────────────────────

/** Every OWNING style binding in a converted payload, however deep it sits. */
const owningBindings = (
  payload: unknown,
  out: WrapperBinding[] = [],
): WrapperBinding[] => {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      owningBindings(item, out)
    }
    return out
  }
  if (payload === null || typeof payload !== 'object') {
    return out
  }
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>,
  )) {
    if (key === 'bindings' && Array.isArray(value)) {
      for (const binding of value as WrapperBinding[]) {
        if (binding?.owns === true) {
          out.push(binding)
        }
      }
      continue
    }
    owningBindings(value, out)
  }
  return out
}

/**
 * Drop the two server-side-only keys from every binding in a payload.
 *
 * The plugin applies a style by name whether or not it owns the field, so
 * nothing it does not read is put on the wire. Always run, so a payload can
 * never carry them past this point.
 */
const stripServerKeys = (payload: unknown): void => {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      stripServerKeys(item)
    }
    return
  }
  if (payload === null || typeof payload !== 'object') {
    return
  }
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>,
  )) {
    if (key === 'bindings' && Array.isArray(value)) {
      for (const binding of value as WrapperBinding[]) {
        delete binding.owns
        delete binding.rideAlong
      }
      continue
    }
    stripServerKeys(value)
  }
}

// ─── the messages ─────────────────────────────────────────────────────────────

const article = (word: string): string =>
  /^[aeiou]/i.test(word) ? 'an' : 'a'

/** Rule 3 — the name resolved, to a style of the wrong type for this slot. */
export const wrongTypeMessage = (
  name: string,
  slot: StyleSlot,
  found: string,
): string => {
  const want = SLOT_CATEGORY[slot]
  const field = SLOT_FIELD[slot]
  return (
    `style(${name}) is ${article(found)} ${found} style, but ${field} needs ` +
    `${article(want)} ${want} style — name ${article(want)} ${want} style ` +
    `that holds what you want, or write the ${field} as literals`
  )
}

/** Rule 4 — the name resolved to nothing at all. */
export const noSuchStyleMessage = (
  name: string,
  slot: StyleSlot,
): string => {
  const want = SLOT_CATEGORY[slot]
  const field = SLOT_FIELD[slot]
  return (
    `style(${name}) matches no ${want} style in this file, and a reference ` +
    `has no literal half to fall back on — check the name, create the style, ` +
    `or write the ${field} as literals`
  )
}

/**
 * The differ's one warning: the style governs, so the write landed the style's
 * own content — and this names what was written beside it and did not land.
 */
export const rideAlongMessage = (
  name: string,
  slot: StyleSlot,
  supplies: string[],
  extras: string[],
  written: string[],
): string => {
  const field = SLOT_FIELD[slot]
  const noun = slot
  const head =
    `style(${name}) owns ${field} — it supplies ` +
    `${renderResolvedList(supplies)}, so `
  if (extras.length > 0) {
    const many = extras.length > 1
    return (
      `${head}the ${extras.length} extra ${noun}${many ? 's' : ''} written ` +
      `beside it ${many ? 'were' : 'was'} not applied; add ` +
      `${many ? 'them' : 'it'} to the style, or write every ${noun} as a literal.`
    )
  }
  return (
    `${head}the ${noun} list written beside it ` +
    `${renderResolvedList(written)} is not what landed; edit the style, or ` +
    `write every ${noun} as a literal.`
  )
}

/** Multiset difference: what was written that the style does not supply. */
const extrasOf = (
  written: string[],
  supplies: string[],
): string[] => {
  const pool = [...supplies]
  const extras: string[] = []
  for (const atom of written) {
    const at = pool.indexOf(atom)
    if (at === -1) {
      extras.push(atom)
    } else {
      pool.splice(at, 1)
    }
  }
  return extras
}

const sameSequence = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

// ─── the gate ─────────────────────────────────────────────────────────────────

/**
 * Resolve every style reference a converted payload carries, BEFORE it is sent.
 *
 * Raises rules 3 and 4 as `INVALID_PARAM`, reports a ride-along that differs
 * from the style on `warnings`, and strips the server-side-only binding keys
 * either way.
 */
export const resolveStyleReferences = async (
  payload: unknown,
  catalogue: StyleCatalogue,
  warnings?: string[],
): Promise<void> => {
  const owned = owningBindings(payload)
  if (owned.length === 0) {
    stripServerKeys(payload)
    return
  }
  const table = await catalogue.table()
  for (const binding of owned) {
    const slot = binding.field as StyleSlot
    const want = SLOT_CATEGORY[slot]
    const found = table.get(binding.name) ?? []
    const match = found.find(r => r.category === want)
    if (match === undefined) {
      // Rule 3 when the name resolved to a style of another type, rule 4 when
      // it resolved to nothing — the same failure to the write, two different
      // fixes to the agent.
      throw new ToolError(
        'INVALID_PARAM',
        found.length > 0
          ? wrongTypeMessage(
              binding.name,
              slot,
              found[0].category,
            )
          : noSuchStyleMessage(binding.name, slot),
      )
    }
    const rideAlong = binding.rideAlong ?? []
    const supplies = match.atoms
    if (rideAlong.length === 0 || supplies === undefined) {
      // Nothing was claimed, or the style's content is not something this read
      // can render — either way there is no honest comparison to report.
      continue
    }
    const written = rideAlong.map(atom =>
      canonicalAtom(slot, atom),
    )
    if (sameSequence(written, supplies)) {
      continue
    }
    warnings?.push(
      rideAlongMessage(
        binding.name,
        slot,
        supplies,
        extrasOf(written, supplies),
        written,
      ),
    )
  }
  stripServerKeys(payload)
}

// ─── the one door ─────────────────────────────────────────────────────────────

/**
 * Send a CONVERTED write payload — the only route a converted payload takes to
 * the plugin.
 *
 * The gate above is not something each handler remembers to call: it is what
 * sending IS. A write path that converts a spec and reaches for
 * `client.sendCommand` directly would skip rules 3 and 4 — sending a field with
 * no literals and a style binding that cannot be made, which is the "write
 * nothing and call it success" failure the contract forbids — and would put the
 * server-side binding markers on the wire. Neither is possible through here.
 *
 * `catalogue` is threaded by callers that already made one (batch resolves each
 * op FIRST, for per-entry attribution, and shares one style read across them);
 * everyone else gets a fresh per-call one, so a style edited between two tool
 * calls is re-read.
 */
export const sendConvertedWrite = async (
  client: ScopedFigmaClient,
  command: string,
  params: Record<string, unknown>,
  opts?: {
    warnings?: string[]
    catalogue?: StyleCatalogue
  },
): Promise<unknown> => {
  await resolveStyleReferences(
    params,
    opts?.catalogue ?? createStyleCatalogue(client),
    opts?.warnings,
  )
  return client.sendCommand(command, params)
}
