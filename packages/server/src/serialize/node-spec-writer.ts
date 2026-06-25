// serialize/node-spec-writer.ts — NodeSpec → FigmaWritePayload
//
// PURE converter: emits ONLY keys present in `spec`. Omitted ⇒ absent ⇒
// untouched. No defaults are injected except in specToFigmaForCreate
// (name fallback).
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
//       strokeWeight, strokeAlign, strokeDash (→ dashPattern), radius, opacity,
//       blendMode, rotation, visible, clipsContent, effects, layout,
//       minWidth/maxWidth/minHeight/maxHeight,
//       fillStyleId/strokeStyleId/effectStyleId/textStyleId
//     applyTextProperties    — text.content, text.font, text.align, text.valign,
//       text.color, text.decoration, text.case, text.paragraphSpacing,
//       text.lineHeight / text.letterSpacing ({value,unit}), textAutoResize
//     applyPostAppendProperties — sizing, layoutPositioning
//
//   EMITTED but NOT YET consumed (reserved for later phases — do not claim
//   round-trip for these until the plugin reads them):
//     strokeCap, strokeJoin, strokeMiterLimit   (plugin reads only weight/
//                                                 align/dashPattern today)
//     grids, cssGrid, constraints,
//     overrides, componentProperties, variantProperties, exportSettings,
//     id (writer emits it; plugin ignores it on create)
//
// ── lh/ls (review finding #3, RESOLVED) ──────────────────────────────────────
// lh/ls are CANONICAL on the font(...) atom (`font(Inter,SemiBold,18){lh=24}`).
// The writer's text path lifts atomToFont's lineHeight/letterSpacing into the
// plugin's text.lineHeight / text.letterSpacing ({value,unit}) keys that
// applyTextProperties reads. There is no redundant top-level text.lh / text.ls.

import type {
  NodeSpec,
  LayoutSpec,
} from '@figma-agent-bridge/shared/node-spec'
import {
  atomToPaint,
  atomToEffect,
  atomToFont,
  atomToStroke,
  atomToGrid,
} from '../grammar'

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

/** Parse the `radius` atom string to a number or [tl,tr,br,bl] tuple. */
const parseRadius = (
  s: string,
): number | [number, number, number, number] => {
  const trimmed = s.trim()
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
  return out
}

// ─── specToFigma ─────────────────────────────────────────────────────────────

/**
 * Convert a (partial) NodeSpec to a FigmaWritePayload.
 *
 * PURE — emits ONLY keys present in `spec`. Never injects defaults.
 */
export const specToFigma = (
  spec: Partial<NodeSpec>,
): FigmaWritePayload => {
  const out: FigmaWritePayload = {}

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
    out.layout = convertLayout(spec.layout)
  }
  if (spec.cssGrid !== undefined) {
    out.cssGrid = spec.cssGrid
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
  if (spec.fills !== undefined) {
    out.fills = spec.fills.map(atomToPaint)
  }
  if (spec.strokes !== undefined) {
    out.strokes = spec.strokes.map(atomToPaint)
  }
  if (spec.stroke !== undefined) {
    const geom = atomToStroke(spec.stroke)
    if (geom.weight !== undefined) {
      out.strokeWeight = geom.weight
    }
    if (geom.weights !== undefined) {
      // Per-side weights [t,r,b,l]: the plugin has no per-side stroke key, so
      // this collapses to a single strokeWeight (the top side), silently
      // dropping the other 3 sides — a LOSSY write (T7).
      // TODO(M3): surface a warning when the four sides differ. specToFigma is
      // a PURE converter returning a bare FigmaWritePayload and ~40 tests pin
      // its exact `.toEqual()` output, so threading a warning channel through
      // the signature here is not clean; defer to the M3 create/update rebuild
      // where the handler already carries a warnings array.
      const [top] = geom.weights
      out.strokeWeight = top
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
  if (spec.effects !== undefined) {
    out.effects = spec.effects.map(atomToEffect)
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
  if (spec.grids !== undefined) {
    out.grids = spec.grids.map(atomToGrid)
  }

  // ── text ─────────────────────────────────────────────────────────────────
  if (spec.text !== undefined) {
    const t = spec.text
    const textOut: Record<string, unknown> = {
      content: t.content,
    }
    // lh/ls ride on the font atom and are lifted into
    // text.lineHeight / text.letterSpacing for the plugin.
    convertFontInto(textOut, t.font)
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
  if (spec.componentProperties !== undefined) {
    out.componentProperties = spec.componentProperties
  }
  if (spec.variantProperties !== undefined) {
    out.variantProperties = spec.variantProperties
  }
  if (spec.overrides !== undefined) {
    out.overrides = spec.overrides
  }

  return out
}

// ─── specToFigmaForCreate ─────────────────────────────────────────────────────

/**
 * CREATE wrapper. Carries the discriminator `type` through (the plugin's
 * createSingleNode switches on it to pick the Figma node kind — specToFigma
 * itself never emits `type`, being a property-patch converter), and adds the
 * `name ?? type` fallback. Keep defaulting minimal — type pass-through and the
 * name fallback are the only firm create-only rules.
 */
export const specToFigmaForCreate = (
  spec: NodeSpec,
): FigmaWritePayload => ({
  ...specToFigma(spec),
  type: spec.type,
  name: spec.name ?? spec.type,
})
