// serialize/node-spec-writer.ts — NodeSpec → FigmaWritePayload
//
// PURE converter: emits ONLY keys present in `spec`. Omitted ⇒ absent ⇒
// untouched. No defaults are injected except in the CREATE wrappers
// (specToFigmaForCreate / slotEntryToFigma): the `name ?? type` fallback and
// the frame layout default (B29). Creation-only, by construction — the patch
// face update_node runs on is this pure converter.
//
// The emitted payload matches the plugin's apply-contract:
//   Phase 1  applyCommonProperties  reads the flat keys
//   Phase 2  applyTextProperties    reads spec.text.font as parsed object
//   Phase 3  applyPostAppendProperties reads spec.sizing / spec.layoutPositioning
//
// ── Plugin consumption (figma-plugin/src/code.ts, as of this phase) ──────────
// Emitting a key here does NOT guarantee the CURRENT plugin applies it. To keep
// round-trip claims honest, the breakdown is:
//
//   CONSUMED by the current plugin:
//     applyCommonProperties  — name, size, position, fills, strokes,
//       strokeWeight, strokeWeights (per-side [t,r,b,l] → strokeTopWeight/…,
//       applyStrokeWeights), strokeAlign, strokeDash (→ dashPattern),
//       strokeCap/strokeJoin/strokeMiterLimit (applyStrokeGeometry),
//       exportSettings (applyExportSettings), grids → layoutGrids
//       (applyGrids), radius, opacity, blendMode, rotation, visible,
//       clipsContent, effects, layout,
//       minWidth/maxWidth/minHeight/maxHeight, constraints,
//       fillStyleId/strokeStyleId/effectStyleId/textStyleId
//       — see apply-node-fields.ts for the three most recently landed
//       (strokeCap/strokeJoin/strokeMiterLimit, exportSettings, grids). Each
//       is confirmed APPLIED to the live node (verified against the raw
//       plugin GET_NODE reply, pre-serialization), and all three now ROUND-TRIP
//       — node-spec-reader.ts projects them back (strokeCap/Join/MiterLimit as
//       the stroke atom's {…} keys, layoutGrids as `grids`, exportSettings with
//       its constraint tuple). Each is elided at its Figma default, so a read
//       emits only what differs (T4).
//     applyTextProperties    — text.content, text.font, text.align, text.valign,
//       text.color, text.decoration, text.case, text.paragraphSpacing,
//       text.lineHeight / text.letterSpacing ({value,unit}), textAutoResize
//     applyPostAppendProperties — sizing, layoutPositioning
//     applyWrapperBindings   — bindings (the NAME each inline var()/style()
//       wrapper carried; applied AFTER the literal, on the create AND the
//       update path — see serialize/wrapper-bindings.ts)
//     createSingleNode (INSTANCE case) — component { id | key, properties }
//       (resolves the main component, createInstance(), then setProperties)
//
//   EMITTED but NOT YET consumed (reserved for later phases — do not claim
//   round-trip for these until the plugin reads them):
//     overrides (also broken on the read face — a separate, tracked issue)
//
//   Read-only by design (writer emits them; the plugin correctly ignores
//   them on write — NOT gaps):
//     componentProperties, variantProperties (instance overrides — the
//       documented read-only override surface)
//     id (writer emits it; plugin ignores it on create — Figma assigns the id)
//
// ── lh/ls (review finding #3, RESOLVED) ──────────────────────────────────────
// lh/ls are CANONICAL on the font(...) atom (`font(Inter,SemiBold,18){lh=24}`).
// The writer's text path lifts atomToFont's lineHeight/letterSpacing into the
// plugin's text.lineHeight / text.letterSpacing ({value,unit}) keys that
// applyTextProperties reads. There is no redundant top-level text.lh / text.ls.

import type {
  NodeSpec,
  NodeSpecPatch,
  LayoutSpec,
  SlotEntry,
} from '@figma-agent-bridge/shared/node-spec'
import { NODE_SPEC_PATCH_KEYS } from '@figma-agent-bridge/shared/node-spec-schema'
import {
  atomToPaint,
  atomToEffect,
  atomToFont,
  atomToStroke,
  atomToGrid,
  atomToPath,
  tokenize,
} from '../grammar'
import { collectWrapperBindings } from './wrapper-bindings'
import { readStyledFields } from './styled-fields'

export type FigmaWritePayload = Record<string, unknown>

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a font atom to the plugin's text-font payload.
 *
 * lh/ls are CANONICAL on the font(...) atom (`{lh=…,ls=…}`). atomToFont
 * parses them into the font object's `lineHeight`/`letterSpacing`; the plugin's
 * applyTextProperties reads them as the SIBLING text keys
 * `text.lineHeight` / `text.letterSpacing` ({value,unit}). So we LIFT them out
 * of the font object up to the text payload, leaving the font object as a bare
 * { family, style, size } that applyTextProperties' loadFontAsync consumes.
 */
const convertFontInto = (
  out: Record<string, unknown>,
  fontAtom: string,
): void => {
  const f = atomToFont(fontAtom)
  out.font = {
    family: f.family,
    style: f.style,
    size: f.size,
  }
  if (f.lineHeight !== undefined) {
    out.lineHeight = f.lineHeight
  }
  if (f.letterSpacing !== undefined) {
    out.letterSpacing = f.letterSpacing
  }
}

/** Parse the `radius` atom (a bare number, or a string/"[tl,tr,br,bl]" tuple). */
const parseRadius = (
  s: string | number,
): number | [number, number, number, number] => {
  // A bare number is the uniform-radius form (consistent with opacity/rotation
  // bare literals) — accept it directly rather than crashing on s.trim().
  if (typeof s === 'number') {
    return s
  }
  // A read emits the binding wrapper — `var(radius/medium)8`, or the
  // per-corner `var(radius/medium)[8,8,0,0]` — and the spec says a write
  // resolves each wrapper to its literal. Every other atom strips it inside
  // parseAtom; radius is the one atom parsed by hand, so it must strip it too,
  // via the SHARED tokenizer rather than a second matcher that could drift
  // from it (T8). Without this, Number('var(…)8') is NaN, which crosses the
  // wire as null. Figma then REJECTS the write ("Property cornerRadius failed
  // validation: Expected number, received null" — verified live), so a
  // read-modify-write on any token-bound node fails outright where it used to
  // round-trip. Loud rather than silent, but still broken.
  const trimmed = tokenize(s).body.trim()
  if (trimmed.startsWith('[')) {
    // "[8,8,0,0]" → [8, 8, 0, 0]
    const inner = trimmed.slice(1, -1)
    const parts = inner
      .split(',')
      .map(p => Number(p.trim()))
    return parts as [number, number, number, number]
  }
  return Number(trimmed)
}

/** Map a LayoutSpec to the flat layout object the plugin expects. */
const convertLayout = (
  layout: LayoutSpec,
  warnings?: string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = { mode: layout.mode }
  if (layout.gap !== undefined) {
    out.spacing = layout.gap
  }
  if (layout.pad !== undefined) {
    out.padding = layout.pad
  }
  if (layout.align !== undefined) {
    out.align = layout.align
  }
  if (layout.wrap !== undefined) {
    out.wrap = layout.wrap
  }
  // GRID-mode keys (M12). Emit only when present (pure-emit contract).
  // T7 handler-side validation: warn when grid keys appear on a non-GRID mode
  // (they are a silent no-op on H/V/NONE).
  const hasGridKeys =
    layout.rows !== undefined ||
    layout.cols !== undefined ||
    layout.rowGap !== undefined ||
    layout.colGap !== undefined
  if (hasGridKeys && layout.mode !== 'GRID' && warnings) {
    warnings.push(
      `layout: rows/cols/rowGap/colGap keys are GRID-only but mode is '${layout.mode}' — keys ignored`,
    )
  }
  if (layout.rows !== undefined) {
    out.rows = layout.rows
  }
  if (layout.cols !== undefined) {
    out.cols = layout.cols
  }
  if (layout.rowGap !== undefined) {
    out.rowGap = layout.rowGap
  }
  if (layout.colGap !== undefined) {
    out.colGap = layout.colGap
  }
  return out
}

// ─── specToFigma ─────────────────────────────────────────────────────────────

/**
 * The keys a patch names that the write face does not know, and what to say
 * about them (T7).
 *
 * zod STRIPS an unknown key by default, so `update_node({patch:{x:10}})` used
 * to report success with an empty `warnings[]` having changed nothing at all —
 * the one failure mode a mutation must never have. `partialNodeSpecSchema` is
 * a passthrough so the key survives to here, where it is REPORTED and still
 * never written.
 *
 * The hints cover the near-misses that produced the bug: the flat CSS-ish
 * geometry names, which NodeSpec carries as tuples.
 */
const PATCH_KEY_HINTS: Record<string, string> = {
  x: 'position',
  y: 'position',
  width: 'size',
  height: 'size',
  characters: 'text',
  fill: 'fills',
  effect: 'effects',
  cornerRadius: 'radius',
}

/**
 * Read-only node-struct fields a read emits and the write face ignores
 * (`expression-formats.md` → *Read-only node fields*). They ARE NodeSpec
 * fields — a read-modify-write echoes them back by design — so telling the
 * agent they are "not a NodeSpec field" would contradict the grammar it read.
 * They get their own wording; genuinely unknown keys keep theirs.
 */
const READ_ONLY_PATCH_KEYS: ReadonlySet<string> = new Set([
  'warnings',
  'readError',
  'readErrors',
])

const nameList = (keys: string[]): string =>
  keys.map(k => `\`${k}\``).join(', ')

export const unknownPatchKeyWarnings = (
  patch: object,
  converted: FigmaWritePayload,
): string[] => {
  const extra = Object.keys(patch).filter(
    k => !NODE_SPEC_PATCH_KEYS.has(k),
  )
  if (extra.length === 0) {
    return []
  }
  const readOnly = extra.filter(k =>
    READ_ONLY_PATCH_KEYS.has(k),
  )
  const unknown = extra.filter(
    k => !READ_ONLY_PATCH_KEYS.has(k),
  )
  const out: string[] = []
  if (readOnly.length > 0) {
    const many = readOnly.length > 1
    out.push(
      `${many ? 'keys' : 'key'} ${nameList(readOnly)} ` +
        `${many ? 'are' : 'is'} read-only and ` +
        `${many ? 'were' : 'was'} ignored on write`,
    )
  }
  if (unknown.length > 0) {
    const many = unknown.length > 1
    const hints = [
      ...new Set(
        unknown
          .map(k => PATCH_KEY_HINTS[k])
          .filter((h): h is string => h !== undefined),
      ),
    ]
    out.push(
      `${many ? 'keys' : 'key'} ${nameList(unknown)} ` +
        `${many ? 'are' : 'is'} not a NodeSpec field and ` +
        `${many ? 'were' : 'was'} ignored` +
        (hints.length > 0
          ? ` — did you mean ${hints.join(' / ')}?`
          : ''),
    )
  }
  // "nothing was changed" only when the whole patch was inert: a patch that
  // also carried a real field DID land, and saying otherwise would be a
  // second dishonesty.
  if (Object.keys(converted).length === 0) {
    out[out.length - 1] +=
      ' (nothing was changed by this call)'
  }
  return out
}

/**
 * Convert a (partial) NodeSpec to a FigmaWritePayload.
 *
 * PURE — emits ONLY keys present in `spec`. Never injects defaults.
 *
 * `warnings` is an OPTIONAL sink: when supplied, a conversion that cannot carry
 * what the spec asked for (e.g. GRID-only `layout` keys on an H/V mode, or a
 * `var()` wrapper on a field with no binding route) pushes a human-readable
 * note onto it. The M3 create/update/component handlers pass
 * their own warnings array so the agent sees the loss; callers that only need
 * the payload (and the ~40 `.toEqual()` converter tests) omit it and get the
 * exact same return value.
 */
export const specToFigma = (
  spec: NodeSpecPatch,
  warnings?: string[],
): FigmaWritePayload => {
  const out: FigmaWritePayload = {}

  // ── styled fields, FIRST ─────────────────────────────────────────────────
  // `fills`/`strokes`/`effects`/`grids` are each EITHER a style reference or a
  // list of literals, and the mixes a slot cannot hold are rejected here —
  // before any atom is converted, so a rejected write has done nothing at all
  // (expression-formats.md, "A styled field is a reference, not a list").
  const styled = readStyledFields(spec)

  // ── identity / pass-through ──────────────────────────────────────────────
  if (spec.name !== undefined) {
    out.name = spec.name
  }
  if (spec.id !== undefined) {
    out.id = spec.id
  }

  // ── geometry pass-through ────────────────────────────────────────────────
  if (spec.size !== undefined) {
    out.size = spec.size
  }
  if (spec.position !== undefined) {
    out.position = spec.position
  }

  // ── layout ───────────────────────────────────────────────────────────────
  if (spec.layout !== undefined) {
    out.layout = convertLayout(spec.layout, warnings)
  }
  if (spec.sizing !== undefined) {
    out.sizing = spec.sizing
  }
  if (spec.constraints !== undefined) {
    out.constraints = spec.constraints
  }
  if (spec.minWidth !== undefined) {
    out.minWidth = spec.minWidth
  }
  if (spec.maxWidth !== undefined) {
    out.maxWidth = spec.maxWidth
  }
  if (spec.minHeight !== undefined) {
    out.minHeight = spec.minHeight
  }
  if (spec.maxHeight !== undefined) {
    out.maxHeight = spec.maxHeight
  }
  if (spec.layoutPositioning !== undefined) {
    out.layoutPositioning = spec.layoutPositioning
  }

  // ── visual atoms ─────────────────────────────────────────────────────────
  // A REFERENCE emits no literals at all: the style is the field's whole
  // content, the resolved list riding with it is not a second instruction, and
  // assigning the field directly is what DETACHES the style. Only the
  // `bindings[]` entry below carries it.
  if (styled.fills?.kind === 'literals') {
    out.fills = styled.fills.atoms.map(atomToPaint)
  }
  if (styled.strokes?.kind === 'literals') {
    out.strokes = styled.strokes.atoms.map(atomToPaint)
  }
  if (spec.stroke !== undefined) {
    const geom = atomToStroke(spec.stroke)
    if (geom.weight !== undefined) {
      out.strokeWeight = geom.weight
    }
    if (geom.weights !== undefined) {
      // Per-side weights [t,r,b,l] (B27). The four sides ride the payload as
      // `strokeWeights` and the plugin assigns strokeTopWeight/… — Figma
      // carries them on frame-like and RECTANGLE nodes (IndividualStrokesMixin).
      //
      // This used to collapse to the TOP side with a warning, which made
      // `stroke([0,0,1,0])` — a bottom rule, the commonest divider in table and
      // list design — weight 0, i.e. INVISIBLE, against a grammar that has
      // promised per-side since expression-formats.md:192.
      //
      // The writer does not warn about the sides it cannot apply, because it
      // does not know the target's node type: the feature detection and its
      // collapse warning belong where the node is (T7, figma-plugin's
      // applyStrokeWeights).
      //
      // EQUAL sides are emitted as the plain uniform weight instead. That is
      // the canonical form on the read face too, and it keeps ONE owner of the
      // value in the payload — nothing can re-collapse a tuple after the fact.
      //
      // A list that is not four finite numbers degrades WHOLE. The parser
      // reports the positional list as written, so `stroke([1,2,3,4,5])` used
      // to lose its fifth entry to a destructure and land as a well-formed
      // four-sided stroke — a silent misread of what the caller asked for. The
      // stroke's weight is left untouched instead, and the sink is told why
      // (matching applyStrokeWeights' own malformed-tuple degrade).
      const sides = geom.weights
      if (
        sides.length !== 4 ||
        sides.some(w => !Number.isFinite(w))
      ) {
        warnings?.push(
          `stroke([…]) takes four weights [top,right,bottom,left]; got ` +
            `${sides.length} (${sides.join(', ')}) — the per-side weights ` +
            `were ignored and the stroke weight is unchanged.`,
        )
      } else {
        const [top, right, bottom, left] = sides
        if (
          right === top &&
          bottom === top &&
          left === top
        ) {
          out.strokeWeight = top
        } else {
          out.strokeWeights = [top, right, bottom, left]
        }
      }
    }
    if (geom.align !== undefined) {
      out.strokeAlign = geom.align
    }
    if (geom.dash !== undefined) {
      out.strokeDash = geom.dash
    }
    if (geom.cap !== undefined) {
      out.strokeCap = geom.cap
    }
    if (geom.join !== undefined) {
      out.strokeJoin = geom.join
    }
    if (geom.miter !== undefined) {
      out.strokeMiterLimit = geom.miter
    }
  }
  if (styled.effects?.kind === 'literals') {
    out.effects = styled.effects.atoms.map(atomToEffect)
  }
  if (spec.radius !== undefined) {
    out.radius = parseRadius(spec.radius)
  }
  if (spec.opacity !== undefined) {
    out.opacity = spec.opacity
  }
  if (spec.rotation !== undefined) {
    out.rotation = spec.rotation
  }
  if (spec.blend !== undefined) {
    out.blendMode = spec.blend
  }
  if (spec.visible !== undefined) {
    out.visible = spec.visible
  }
  if (spec.clipsContent !== undefined) {
    out.clipsContent = spec.clipsContent
  }
  if (styled.grids?.kind === 'literals') {
    out.grids = styled.grids.atoms.map(atomToGrid)
  }
  if (spec.vectorPaths !== undefined) {
    out.vectorPaths = spec.vectorPaths.map(atomToPath)
  }

  // node-type-specific shape fields — plain pass-through (no grammar atom)
  if (spec.pointCount !== undefined) {
    out.pointCount = spec.pointCount
  }
  if (spec.innerRadius !== undefined) {
    out.innerRadius = spec.innerRadius
  }
  if (spec.sectionContentsHidden !== undefined) {
    out.sectionContentsHidden = spec.sectionContentsHidden
  }
  if (spec.isMask !== undefined) {
    out.isMask = spec.isMask
  }
  if (spec.maskType !== undefined) {
    out.maskType = spec.maskType
  }

  // ── text ─────────────────────────────────────────────────────────────────
  if (spec.text !== undefined) {
    const t = spec.text
    const textOut: Record<string, unknown> = {}
    // EVERY member is guarded, `content` and `font` included: a patch may
    // supply any subset of the struct and omitted means untouched. `font` was
    // converted unconditionally, so `{text:{content}}` — the plainest patch
    // there is — died in the atom tokenizer instead of rewriting the copy.
    if (t.content !== undefined) {
      textOut.content = t.content
    }
    // lh/ls ride on the font atom and are lifted into
    // text.lineHeight / text.letterSpacing for the plugin.
    if (t.font !== undefined) {
      convertFontInto(textOut, t.font)
    }
    if (t.color !== undefined) {
      textOut.color = atomToPaint(t.color)
    }
    if (t.align !== undefined) {
      textOut.align = t.align
    }
    if (t.valign !== undefined) {
      textOut.valign = t.valign
    }
    if (t.decoration !== undefined) {
      textOut.decoration = t.decoration
    }
    if (t.case !== undefined) {
      textOut.case = t.case
    }
    if (t.paragraphSpacing !== undefined) {
      textOut.paragraphSpacing = t.paragraphSpacing
    }
    if (t.runs !== undefined) {
      textOut.runs = t.runs.map(run => {
        const r: Record<string, unknown> = { at: run.at }
        if (run.font !== undefined) {
          convertFontInto(r, run.font)
        }
        if (run.color !== undefined) {
          r.color = atomToPaint(run.color)
        }
        return r
      })
    }
    out.text = textOut
  }

  // ── export / component meta (pass-through) ───────────────────────────────
  if (spec.exportSettings !== undefined) {
    out.exportSettings = spec.exportSettings
  }
  // component (INSTANCE main-component ref): passed through so the plugin's
  // createSingleNode INSTANCE case can resolve it by `id` (local component
  // node) or `key` (importComponentByKeyAsync), then createInstance() and
  // apply `properties`. See packages/figma-plugin/src/code.ts.
  if (spec.component !== undefined) {
    out.component = spec.component
  }
  if (spec.componentProperties !== undefined) {
    out.componentProperties = spec.componentProperties
  }
  if (spec.variantProperties !== undefined) {
    out.variantProperties = spec.variantProperties
  }
  if (spec.overrides !== undefined) {
    out.overrides = spec.overrides
  }
  if (spec.context !== undefined) {
    out.context = spec.context
  }

  // ── binding intent (I39) ─────────────────────────────────────────────────
  // Every converter above resolves its atom to the LITERAL and drops the
  // wrapper — which is right, the literal is what Figma sets. The wrapper's
  // NAME is the other half: a write of `var(surface/2)#141B2E` applies the
  // paint AND re-establishes the binding (expression-formats.md). `bindings`
  // carries that name to the plugin, which binds it once the literal has
  // landed. Emitted only when a wrapper was actually present — the pure-emit
  // contract holds for this key like every other.
  const bindings = collectWrapperBindings(spec, warnings)
  if (bindings.length > 0) {
    out.bindings = bindings
  }

  return out
}

// ─── creation defaults ───────────────────────────────────────────────────────

/**
 * The node types a created frame's layout default applies to (B29).
 *
 * A FRAME is born absolutely-positioned and a SLOT is born without auto-layout,
 * so under Figma's own defaults the MODERN arrangement — a stack — is the one
 * that had to be asked for, and the child that asks for `FILL` inside a fresh
 * slot is refused until someone remembers to set the layout. The default is
 * inverted here: a create that says nothing about layout stacks vertically.
 *
 * `SLOT` is listed because create_node accepts the type (the plugin builds a
 * FRAME placeholder for it); real slots are minted by update_component and go
 * through slotEntryToFigma below.
 */
const LAYOUT_DEFAULT_TYPES: ReadonlySet<string> = new Set([
  'FRAME',
  'SLOT',
])

/**
 * The layout a create gets when it states none. A FRESH object per call — one
 * shared literal would put the same mutable reference in every payload.
 */
const defaultCreateLayout = (): Record<
  string,
  unknown
> => ({ mode: 'V' })

/**
 * Apply the creation default to a create payload, in place.
 *
 * TWO halves, and the second is what keeps the first honest. Figma's
 * auto-layout HUGS by default, so injecting a layout into a spec that stated a
 * `size` would throw that size away: live, a FRAME created at `[300,200]` with
 * one child read back `[300,30]`, `sizing:["FIXED","HUG"]`. An empty frame
 * keeps its size, which is why a simple probe looks fine and the child case is
 * the one that bites. So when the default is injected AND the spec states a
 * `size` but no `sizing`, the size is pinned `['FIXED','FIXED']` — which is
 * precisely the behaviour the old absolute default gave: a stated size is
 * honored. The default may add an arrangement; it may not silently discard a
 * field the caller stated.
 *
 * Both halves are conditional on INJECTION. A stated layout (`NONE` included)
 * means the caller is arranging the node themselves and owns its sizing with
 * it; a spec that states no size is asking for nothing in particular, and hug
 * is the right answer for a container that named no height.
 */
const applyCreationDefaults = (
  spec: NodeSpecPatch,
  out: FigmaWritePayload,
): void => {
  if (spec.layout !== undefined) {
    return
  }
  out.layout = defaultCreateLayout()
  if (
    spec.size !== undefined &&
    spec.sizing === undefined
  ) {
    out.sizing = ['FIXED', 'FIXED']
  }
}

// ─── specToFigmaForCreate ─────────────────────────────────────────────────────

/**
 * CREATE wrapper. Carries the discriminator `type` through (the plugin's
 * createSingleNode switches on it to pick the Figma node kind — specToFigma
 * itself never emits `type`, being a property-patch converter), adds the
 * `name ?? type` fallback, and applies the creation defaults (B29 — the frame
 * layout, and the `sizing` pin that keeps it from hugging a stated size away).
 *
 * Defaulting stays minimal and CREATION-ONLY: `specToFigma` — the patch face
 * `update_node` runs on — injects nothing, so an omitted `layout` on a patch
 * still means *left untouched* and an existing absolute frame is never
 * converted behind the agent's back. Here the default fills a SILENCE only:
 * a stated `layout` (`{mode:'NONE'}` included, the documented opt-out) is
 * carried through exactly as `convertLayout` emitted it.
 */
export const specToFigmaForCreate = (
  spec: NodeSpec,
  warnings?: string[],
): FigmaWritePayload => {
  const out: FigmaWritePayload = {
    ...specToFigma(spec, warnings),
    type: spec.type,
    name: spec.name ?? spec.type,
  }
  if (LAYOUT_DEFAULT_TYPES.has(spec.type)) {
    applyCreationDefaults(spec, out)
  }
  return out
}

// ─── slot entries ─────────────────────────────────────────────────────────────

/**
 * Convert one `update_component` slot entry (B30).
 *
 * The object form goes through the SAME `specToFigma` write face as
 * `create_node`/`update_node`, which is the whole point: atoms are parsed here
 * once, and an inline `var()`/`style()` wrapper rides along in `bindings[]`
 * with no parallel path to maintain.
 *
 * A bare string is a name and nothing else — but the spec defines it as exactly
 * `{name}`, so it is CONVERTED like one rather than forwarded verbatim. That
 * matters for the layout default (B29): a slot created from a bare name is the
 * cheapest thing the surface offers and the one live builds reach for, so
 * leaving it absolutely-positioned while `{name}` stacks would make the default
 * depend on which of two spellings of the same entry was used. The plugin reads
 * both shapes either way (`readSlotEntry`).
 *
 * Every warning raised while converting is ATTRIBUTED to the slot by name —
 * one call can carry several slots, and an unattributed "layout: …" note would
 * leave the agent guessing which one it belongs to.
 */
export const slotEntryToFigma = (
  entry: SlotEntry,
  warnings?: string[],
): FigmaWritePayload => {
  if (typeof entry === 'string') {
    return { name: entry, layout: defaultCreateLayout() }
  }
  const { name, ...rest } = entry
  const local: string[] = []
  const converted = specToFigma(
    rest as NodeSpecPatch,
    local,
  )
  const payload: FigmaWritePayload = { ...converted, name }
  // The created slot takes the same creation defaults a created FRAME takes,
  // and on the same terms: only when the entry states no layout of its own,
  // and the size it stated is pinned so the layout cannot hug it away.
  applyCreationDefaults(rest as NodeSpecPatch, payload)
  // `payload` (not `converted`) so the "nothing was changed" tail never fires:
  // the name always lands, whatever else the entry got wrong.
  local.push(...unknownPatchKeyWarnings(rest, payload))
  warnings?.push(...local.map(w => `slot "${name}": ${w}`))
  return payload
}
