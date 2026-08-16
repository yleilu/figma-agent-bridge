// node-spec.ts — the one canonical node shape.
//
// `get_node` RETURNS a NodeSpec; `create_node` / `update_node` /
// `create_tree` CONSUME it (the round-trip anchor, principle T2). It
// replaces the old split (`ParsedNode` for reads, `CreateNodeSpec` for
// writes), which had drifted.
//
// Every leaf value is an ATOM STRING in the grammar of
// docs/specs/expression-formats.md (e.g. "#3B82F6",
// "linear(135, #FF0000@0, #00FF00@100)",
// "style(Heading/H1)font(Inter,Bold,32){lh=40}"). Every composite is a
// STRUCT (object). Binding rides on the `var()`/`style()` wrapper of the
// atom — there is NO `boundVariables` field.

/**
 * A single leaf value, encoded as a compact atom string per
 * expression-formats.md:
 *   [ style(Name) | var(Name) ]  value  [ { key=val, … } ]
 */
export type Atom = string

/**
 * A styleable ARRAY field — `fills`, `strokes`, `effects`, `grids`.
 *
 * Figma holds one style link per field slot, exclusively, so such a field is
 * EITHER a reference (the scalar atom `style(Name)`, optionally carrying the
 * resolved list a read appends — `style(AB/Blur)[bg-blur(24)]`) OR an array of
 * literal atoms. A style beside literal siblings is a shape the slot cannot
 * hold and is rejected on write (expression-formats.md — "A styled field is a
 * reference, not a list"). A read emits the reference form for a styled slot
 * and the array for an unstyled one.
 */
export type StyledAtoms = Atom | Atom[]

/**
 * Auto-layout configuration. `mode: 'NONE'` turns auto-layout off.
 *
 * GRID mode uses the four independent grid keys (`rows`, `cols`, `rowGap`,
 * `colGap`). The scalar `gap` key is H/V-only and stays unused for GRID.
 * T8: grid keys ride the existing layout struct — no separate grammar.
 */
export type LayoutSpec = {
  mode: 'H' | 'V' | 'NONE' | 'GRID'
  /** Item spacing in px (H/V only; not used for GRID). */
  gap?: number
  /** [top, right, bottom, left] in px (grammar `pad`). */
  pad?: [number, number, number, number]
  /** [primaryAxisAlign, counterAxisAlign]. */
  align?: [string, string]
  /** Enable WRAP layout (H/V only). */
  wrap?: boolean
  /** Grid row count (GRID mode only). Maps to `gridRowCount` on FrameNode. */
  rows?: number
  /** Grid column count (GRID mode only). Maps to `gridColumnCount` on FrameNode. */
  cols?: number
  /** Grid row gap in px (GRID mode only). Maps to `gridRowGap` on FrameNode. */
  rowGap?: number
  /** Grid column gap in px (GRID mode only). Maps to `gridColumnGap` on FrameNode. */
  colGap?: number
}

/** A per-range text override; same atoms scoped by `at:[start,end]`. */
export type TextRun = {
  at: [number, number]
  font?: Atom
  color?: Atom
}

/**
 * Text properties (TEXT nodes). `font`/`color`/run leaves are atoms.
 *
 * Line height and letter spacing are CANONICAL on the `font(...)` atom
 * (`font(Inter,SemiBold,18){lh=24,ls=0.5}`) — there are no separate
 * top-level `lh`/`ls` fields (review finding #3).
 */
export type TextSpec = {
  content: string
  /** font(...) atom; carries lh/ls in its `{…}` channel. */
  font: Atom
  /** color atom (hex / var()/style() wrapped). */
  color?: Atom
  align?: string
  valign?: string
  decoration?: string
  case?: string
  paragraphSpacing?: number
  runs?: TextRun[]
}

/** A persistent export preset; round-trips via get_node/update_node. */
export type ExportSetting = {
  format: 'PNG' | 'JPG' | 'SVG' | 'PDF'
  suffix?: string
  constraint?: ['SCALE' | 'WIDTH' | 'HEIGHT', number]
}

/**
 * A structured instance override delta: report-only, naming *which*
 * fields differ from the main component. Figma's override record is
 * `{id, overriddenFields}` — field names only — so a read cannot state
 * what a field was overridden *to*; take that from the node struct.
 * Not a write format: `set_instance` degrades per-node `overrides`.
 */
export type OverrideEntry = {
  path: string
  field: string
  /**
   * OPTIONAL and never emitted by the read face. Figma's override record
   * carries no values, so the reader cannot fill this in honestly — it
   * used to pad every entry with `''`, which read as "overridden to
   * blank". Kept optional only so a caller-supplied spec that still
   * carries one type-checks; the writer does not consume it.
   */
  value?: Atom | string
}

/** Depth-boundary / wide-node collapse — keeps `id` for drill-by-id. */
export type IdStub = {
  id: string
  name: string
  type: string
  size: [number, number]
  childCount: number
}

/** The one canonical node shape (read + write). */
export type NodeSpec = {
  // identity
  type: string
  name?: string
  /** Present on reads, omitted on create. */
  id?: string

  // geometry
  size?: [number, number]
  position?: [number, number]
  /** Flow vs absolute child participation (§7 absolute-positioning audit). */
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'

  // layout
  layout?: LayoutSpec
  /** [horizontal, vertical] sizing: FIXED | HUG | FILL. */
  sizing?: [string, string]
  /** [horizontal, vertical] constraints: MIN/MAX/CENTER/STRETCH/SCALE. */
  constraints?: [string, string]
  minWidth?: number | null
  maxWidth?: number | null
  minHeight?: number | null
  maxHeight?: number | null

  // visual — all atoms
  /** Style reference or literal array (see StyledAtoms). */
  fills?: StyledAtoms
  /** Style reference or literal array (see StyledAtoms). */
  strokes?: StyledAtoms
  /** Stroke geometry as one atom (weight/align/dash in the head + {…}). */
  stroke?: Atom
  /** Style reference or literal array (see StyledAtoms). */
  effects?: StyledAtoms
  /** Corner radius atom: "8" (uniform) or "[8,8,0,0]" ([TL,TR,BR,BL]). */
  radius?: Atom
  opacity?: number
  rotation?: number
  blend?: string
  visible?: boolean
  clipsContent?: boolean
  /** Layout-grid atoms (columns()/rows()) — style reference or literal array. */
  grids?: StyledAtoms
  /** Vector path atoms (path(windingRule,"data")) — VECTOR nodes only. */
  vectorPaths?: Atom[]

  // node-type-specific shape fields (plain pass-through — no atom grammar)
  /** Number of points/sides — POLYGON and STAR nodes. */
  pointCount?: number
  /** Inner radius ratio 0..1 — STAR nodes only. */
  innerRadius?: number
  /** Collapse section contents — SECTION nodes only. */
  sectionContentsHidden?: boolean
  /** True when this node clips siblings below it in the same parent (mask). */
  isMask?: boolean
  /** Mask mode — only meaningful when isMask is true. */
  maskType?: 'ALPHA' | 'VECTOR' | 'LUMINANCE'

  // text
  text?: TextSpec

  // export presets (persistent) — round-trips
  exportSettings?: ExportSetting[]

  // component / instance — full override read/write surface
  /**
   * Main-component reference for create_node(INSTANCE) (write) and the
   * instance round-trip (read): `{ key }` for a published/library component
   * (imported via importComponentByKeyAsync) OR `{ id }` for a local
   * component node, plus optional `properties` (component-property values by
   * name). Read back from the instance so a locally-created instance
   * round-trips through get_node → create_node (T2).
   */
  component?: {
    key?: string
    id?: string
    properties?: Record<string, string | boolean>
    /**
     * Read-emitted hint (M14): true when the main component is from a
     * published library (remote). The write path prefers
     * importComponentByKeyAsync(key) when remote===true; id-first is
     * unchanged for local (non-remote) instances. Carried by every node
     * the read returns complete — the requested one and, within `depth`,
     * its descendants.
     */
    remote?: boolean
  }
  /** Current instance property values. */
  componentProperties?: Record<string, string | boolean>
  /** Current variant selection. */
  variantProperties?: Record<string, string>
  /** Structured override delta. */
  overrides?: OverrideEntry[]

  /**
   * READ-ONLY honesty channel: what this node's export carried that the
   * read could not represent, one entry per loss, naming the field and
   * the reason (T7 — the surface never hides what it could not do). A
   * read that returns everything omits the key entirely. Ignored on
   * write, so echoing a read back is harmless.
   */
  warnings?: string[]

  /**
   * READ-ONLY: this node could not be read, and this is what it said.
   *
   * The one failure `warnings` cannot express — not state the read could not
   * REPRESENT, but a node the read could not REACH (a stale slot-child handle
   * throws on every property access). The read returns the node labelled
   * rather than failing, so a broken node costs one node and not the tree
   * around it (T7). Omitted when the node read cleanly; ignored on write.
   */
  readError?: string

  /**
   * READ-ONLY: failures from BELOW this node that could not be pinned to a
   * node in the returned tree — `"<id the read saw>: <message>"` each.
   *
   * The two sides of a read key the same node by different ids when a handle
   * has gone stale, so a `readError` sometimes has no node to land on. It is
   * reported here on the ROOT of the returned tree instead of being dropped: a
   * read that cannot say WHICH node broke must still say that one did (T7).
   * Omitted when every failure found its node; ignored on write.
   */
  readErrors?: string[]

  /** Full round-trippable markdown note, stored in shared pluginData. Omitted on read when absent/empty. Verbatim; the server never parses it. Capped at CONTEXT_MAX_BYTES on write. */
  context?: string

  /**
   * M13 — Per-collection explicit variable mode pins (READ-ONLY). Maps
   * collectionId → modeId for each collection this node has been explicitly
   * pinned to. Populated by plugin export enrichment (feature-detected).
   * Write side: use bind_variable's `mode` param (one collection per call).
   * Omitted when absent or empty (no explicit pins).
   */
  explicitVariableModes?: Record<string, string>

  /**
   * Read-only projection. Written through update_component's targetNodeId/field
   * binding, not via NodeSpec.
   *
   * Maps component property name → the field on this node that the property
   * controls (e.g. `{ characters: 'Label#45:13' }`). Populated by plugin
   * export enrichment (feature-detected). Omitted when absent.
   */
  componentPropertyReferences?: Record<string, string>

  // children — reads: stubs past depth; writes: nested specs
  children?: NodeSpecOrStub[]
}

/** A child is either a full spec or a depth/wide-collapse stub. */
export type NodeSpecOrStub = NodeSpec | IdStub

/**
 * What `update_node`'s `patch` is: a partial NodeSpec whose `text` STRUCT is
 * partial too.
 *
 * `text.font` is required on a NodeSpec because a TEXT node cannot be CREATED
 * without one. A PATCH is the other case: `{text:{content}}` rewrites the copy
 * and leaves the type alone, and `{text:{color}}` recolours it — omitted means
 * untouched, the same rule every other patch field obeys. Requiring `font` to
 * change a string would make the partial-patch contract false for exactly one
 * struct.
 */
export type NodeSpecPatch = Omit<
  Partial<NodeSpec>,
  'text'
> & { text?: Partial<TextSpec> }

/**
 * One `update_component` slot entry (B30).
 *
 * `component.createSlot()` takes no argument, so a fresh slot is born 100×100
 * FIXED with an opaque #FFFFFF fill and no auto-layout. The spec is applied to
 * it through the SAME write face `update_node`'s patch goes through — hence
 * literally a `NodeSpecPatch` with `name` required — so one call yields a
 * usable slot instead of a create plus two `update_node` follow-ups.
 *
 * The index signature is the passthrough half of the schema: an unknown key
 * SURVIVES validation so the handler can report it (T7), and is never applied.
 */
export type SlotSpec = NodeSpecPatch & {
  name: string
  [key: string]: unknown
}

/** A slot entry: a bare name, or a name plus the spec applied to the slot. */
export type SlotEntry = string | SlotSpec

/**
 * The create_tree node shape: a NodeSpec with recursive children, a
 * ref-pool reuse (`{ ref }`), or a clone-by-id (`{ id }`).
 *
 * `children` is overridden (via Omit) rather than intersected so the
 * recursive child type is cleanly `TreeNodeSpec[]` — an intersection
 * `NodeSpec & { children?: TreeNodeSpec[] }` would instead narrow
 * `children` to `NodeSpecOrStub[] & TreeNodeSpec[]` (effectively empty).
 */
export type TreeNodeSpec =
  | (Omit<NodeSpec, 'children'> & {
      children?: TreeNodeSpec[]
    })
  | { ref: string }
  | { id: string }

/** ref-pool: shared specs keyed for repeated instances/clones. */
export type RefPool = Record<string, TreeNodeSpec>
