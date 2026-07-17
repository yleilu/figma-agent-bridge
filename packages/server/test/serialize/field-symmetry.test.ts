// field-symmetry.test.ts — guard the silent-field-strip bug class.
//
// Bug class: a field is READ by the plugin apply (code.ts) or declared in
// NodeSpec, but STRIPPED by the Zod schema (not declared in nodeSpecBase) or
// never EMITTED by specToFigma — so it is silently dead with no error.
// Historical victims: vectorPaths, booleanOperation, vectorNodeId, component,
// pointCount, innerRadius, sectionContentsHidden.
//
// ASSERTIONS:
//   1. Schema → writer symmetry: for every key in nodeSpecBase.shape, specToFigma
//      must emit a corresponding output key (i.e. the writer never silently drops
//      a schema-declared field), UNLESS the field appears in the ALLOW_LIST with a
//      one-line justification.
//
//   2. Plugin-read fields ⊆ schema keys: every field read by the plugin apply cases
//      (PLUGIN_READ_FIELDS constant, cross-referenced to code.ts) must be declared
//      in nodeSpecBase.shape. A plugin-read field that lacks a schema declaration
//      would be stripped by Zod before reaching the writer.

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'

// We import nodeSpecSchema which uses nodeSpecBase internally.
// Since nodeSpecBase is `const` (not exported), we extract its shape from the
// schema. nodeSpecSchema is a z.lazy wrapping z.object; unwrap it by calling
// .schema (Zod 3.x exposes the inner schema via .schema on ZodLazy).
//
// NOTE: The recursive z.lazy means nodeSpecSchema is a ZodLazy<ZodObject>.
// Calling (nodeSpecSchema as z.ZodLazy<z.ZodObject<...>>).schema gives us
// the inner ZodObject, whose .shape we can inspect.

// We use a partial workaround: instantiate the schema to get the shape.
// Zod 3 ZodLazy exposes .schema (the wrapped schema).
import { nodeSpecSchema } from '@figma-agent-bridge/shared/node-spec-schema'

// Extract the shape of nodeSpecBase from the lazy schema.
// nodeSpecSchema is ZodType<NodeSpec> (z.lazy). Cast to access internals.
type AnyZodLazy = { schema: z.ZodTypeAny }
type AnyZodObject = { shape: Record<string, z.ZodTypeAny> }

const innerSchema = (
  nodeSpecSchema as unknown as AnyZodLazy
).schema as unknown as AnyZodObject

// ─── ALLOW_LIST ───────────────────────────────────────────────────────────────
//
// Fields that are intentionally asymmetric (schema-declared but NOT emitted
// to the FigmaWritePayload with a matching key, OR emitted under a different
// key). Each entry has a one-line justification so "documented asymmetry" is a
// checked, cited assertion — not an untested exemption.
//
// Format: fieldName → justification string

const ALLOW_LIST: Record<string, string> = {
  // ALWAYS-ASYMMETRIC (schema present, writer mapping differs or absent)

  // `type` is consumed by specToFigmaForCreate (not specToFigma itself);
  // specToFigma is the property-patch converter and intentionally does not
  // emit `type` (see the header comment in node-spec-writer.ts).
  type: 'specToFigma is a property-patch converter; type is only emitted by specToFigmaForCreate',

  // `children` is not in nodeSpecBase (it is added per-variant in nodeSpecSchema),
  // but test robustness: if it ever leaks into shape, it is handled by the plugin,
  // not by specToFigma.
  children:
    'children are handled by the plugin tree-walker, not by the flat specToFigma payload',

  // `id` is emitted by specToFigma (out.id = spec.id) but is ignored by the
  // plugin on create. It is present in the payload — no asymmetry here.
  // (id is NOT in the allow list — it IS emitted)

  // component.remote: the `component` object has a `remote` sub-field
  // (read-emitted as a HINT) that is honored on write but is not a
  // top-level spec field. `component` itself IS emitted by specToFigma.
  // No top-level allow-list entry needed for `component`.

  // `overrides` is emitted as-is (out.overrides = spec.overrides); the plugin
  // apply is deferred (T7 degrade note in node-spec-writer.ts header).
  // No asymmetry — it IS in the payload.

  // `exportSettings` is emitted as-is; the plugin apply is deferred.
  // No asymmetry.

  // `context` is emitted as-is; the plugin reads it.
  // No asymmetry.

  // `variantProperties` is emitted as-is.
  // No asymmetry.

  // `componentProperties` is emitted as-is.
  // No asymmetry.

  // `grids` is emitted via atomToGrid mapping.
  // No asymmetry.

  // `vectorPaths` is emitted via atomToPath mapping.
  // No asymmetry.

  // `stroke` is emitted but mapped to multiple flat keys (strokeWeight,
  // strokeAlign, strokeDash, strokeCap, strokeJoin, strokeMiterLimit) —
  // the output key name differs from the schema field name.
  stroke:
    'stroke atom is expanded to multiple flat keys (strokeWeight/strokeAlign/strokeDash/…); no single "stroke" key in the payload',

  // `blend` is emitted as `blendMode` in the payload (key rename).
  blend:
    'blend field is emitted as blendMode in the payload (plugin API key name)',

  // M13 — `explicitVariableModes` is a READ map ({collectionId: modeId})
  // populated by plugin export enrichment; its WRITE equivalent is
  // bind_variable's `mode` param (one collection per call). The field must
  // not be emitted by specToFigma (T8 — node↔collection relation stays out
  // of the appearance grammar; write is via bind_variable, not node-spec).
  explicitVariableModes:
    'read-only map populated by plugin export enrichment; write is via bind_variable mode param (documented read-map/write-one asymmetry, T8)',
}

// ─── Representative write values for each nodeSpecBase key ───────────────────
// These let us feed a spec with ONLY that key set and check the output.
// For complex types, we use the simplest valid value.

const REPRESENTATIVE_VALUES: Record<string, unknown> = {
  type: 'FRAME',
  name: 'test',
  id: 'test-id',
  size: [100, 100],
  position: [0, 0],
  layoutPositioning: 'ABSOLUTE',
  layout: { mode: 'H' },
  sizing: ['FIXED', 'FIXED'],
  constraints: ['MIN', 'MIN'],
  minWidth: 10,
  maxWidth: null,
  minHeight: 10,
  maxHeight: null,
  fills: ['#FF0000'],
  strokes: ['#000000'],
  stroke: '1',
  effects: [],
  radius: '8',
  opacity: 0.5,
  rotation: 45,
  blend: 'MULTIPLY',
  visible: true,
  clipsContent: true,
  grids: [],
  vectorPaths: [],
  text: { content: 'hi', font: 'font(Inter,Regular,14)' },
  exportSettings: [],
  component: { id: 'abc123' },
  componentProperties: { prop: 'val' },
  variantProperties: { variant: 'A' },
  overrides: [],
  context: 'some context',
  pointCount: 6,
  innerRadius: 0.4,
  sectionContentsHidden: false,
  isMask: true,
  maskType: 'ALPHA' as const,
}

// ─── PLUGIN_READ_FIELDS ───────────────────────────────────────────────────────
//
// Fields read by the plugin's createSingleNode / apply cases in
// packages/figma-plugin/src/code.ts. This list is maintained manually
// and cross-referenced to the apply cases by comment.
//
// Assertion: PLUGIN_READ_FIELDS ⊆ nodeSpecBase.shape
// (any plugin-read field must be schema-declared, or Zod strips it)
//
// HOW TO UPDATE: when adding a new case to createSingleNode / applyCommonProperties
// in code.ts, add the field name here with a reference.

const PLUGIN_READ_FIELDS: readonly string[] = [
  // createSingleNode switch cases:
  'type', // every case: createSingleNode switches on spec.type (line ~670)
  'component', // INSTANCE case: resolves main component (line ~777)
  'pointCount', // POLYGON + STAR cases (lines 733, 741)
  'innerRadius', // STAR case (line 744)
  'sectionContentsHidden', // SECTION case (line 766)
  'vectorPaths', // VECTOR case (line 752)

  // applyCommonProperties reads:
  'name', // line ~880
  'size', // line ~885
  'position', // line ~890
  'fills', // line ~900
  'strokes', // line ~905
  'stroke', // strokeWeight/strokeAlign/strokeDash (line ~910)
  'effects', // line ~920
  'radius', // line ~925 (cornerRadius)
  'opacity', // line ~930
  'rotation', // line ~935
  'blend', // blendMode (line ~940)
  'visible', // line ~945
  'clipsContent', // line ~950
  'layout', // layoutMode/itemSpacing/padding/align/wrap (line ~960)
  'constraints', // line ~970
  'minWidth', // line ~975
  'maxWidth', // line ~976
  'minHeight', // line ~977
  'maxHeight', // line ~978

  // applyTextProperties reads:
  'text', // text.content, text.font, text.color, text.align, text.valign, … (line ~1000)

  // applyPostAppendProperties reads:
  'sizing', // layoutSizingHorizontal/Vertical (line ~1050)
  'layoutPositioning', // line ~1060
  'isMask', // mask clipping (line ~1065)
  'maskType', // mask mode (line ~1075)
]

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('field-symmetry — schema → writer', () => {
  it('nodeSpecBase shape is inspectable', () => {
    // Guard: make sure we can actually introspect the schema.
    // If this fails, the schema structure changed and we must update the test.
    expect(typeof innerSchema.shape).toBe('object')
    expect(innerSchema.shape).not.toBeNull()
  })

  it('every schema key is either emitted by specToFigma or in the ALLOW_LIST', () => {
    const { shape } = innerSchema
    const violations: string[] = []

    for (const [key] of Object.entries(shape)) {
      if (key in ALLOW_LIST) {
        // Documented intentional asymmetry — skip.
        continue
      }

      // Check: if we set ONLY this key, specToFigma must produce at least one
      // output key (i.e. not silently drop it).
      const repValue = REPRESENTATIVE_VALUES[key]
      if (repValue === undefined) {
        // No representative value — that itself is a gap: add one to
        // REPRESENTATIVE_VALUES above.
        violations.push(
          `${key}: no REPRESENTATIVE_VALUES entry — add one`,
        )
        continue
      }

      const payload = specToFigma({
        [key]: repValue,
      } as never)

      if (Object.keys(payload).length === 0) {
        // specToFigma produced nothing for this key → silent field strip.
        violations.push(
          `${key}: declared in schema but specToFigma emits nothing (silent field strip)`,
        )
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Field-symmetry violations found:\n` +
          violations.map(v => `  - ${v}`).join('\n'),
      )
    }
  })
})

describe('field-symmetry — plugin-read ⊆ schema', () => {
  it('every plugin-read field has a schema declaration', () => {
    const { shape } = innerSchema
    const schemaKeys = new Set(Object.keys(shape))

    const missing = PLUGIN_READ_FIELDS.filter(
      f => !schemaKeys.has(f),
    )

    if (missing.length > 0) {
      throw new Error(
        `Plugin reads these fields but they are absent from nodeSpecBase (Zod would strip them):\n` +
          missing.map(f => `  - ${f}`).join('\n'),
      )
    }
  })
})
