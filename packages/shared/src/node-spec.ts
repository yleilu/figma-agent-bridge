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

/** Auto-layout configuration. `mode: 'NONE'` turns auto-layout off. */
export type LayoutSpec = {
  mode: 'H' | 'V' | 'NONE'
  /** Item spacing in px (grammar `gap`). */
  gap?: number
  /** [top, right, bottom, left] in px (grammar `pad`). */
  pad?: [number, number, number, number]
  /** [primaryAxisAlign, counterAxisAlign]. */
  align?: [string, string]
  /** Enable WRAP layout. */
  wrap?: boolean
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
 * A structured instance override delta (read side of `set_instance`;
 * round-trips). `value` is an atom or a plain string (e.g. characters).
 */
export type OverrideEntry = {
  path: string
  field: string
  value: Atom | string
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
  fills?: Atom[]
  strokes?: Atom[]
  /** Stroke geometry as one atom (weight/align/dash in the head + {…}). */
  stroke?: Atom
  effects?: Atom[]
  /** Corner radius atom: "8" (uniform) or "[8,8,0,0]" ([TL,TR,BR,BL]). */
  radius?: Atom
  opacity?: number
  rotation?: number
  blend?: string
  visible?: boolean
  clipsContent?: boolean
  /** Layout-grid atoms (columns()/rows()). */
  grids?: Atom[]
  /** Vector path atoms (path(windingRule,"data")) — VECTOR nodes only. */
  vectorPaths?: Atom[]

  // node-type-specific shape fields (plain pass-through — no atom grammar)
  /** Number of points/sides — POLYGON and STAR nodes. */
  pointCount?: number
  /** Inner radius ratio 0..1 — STAR nodes only. */
  innerRadius?: number
  /** Collapse section contents — SECTION nodes only. */
  sectionContentsHidden?: boolean

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
  }
  /** Current instance property values. */
  componentProperties?: Record<string, string | boolean>
  /** Current variant selection. */
  variantProperties?: Record<string, string>
  /** Structured override delta. */
  overrides?: OverrideEntry[]

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

  // children — reads: stubs past depth; writes: nested specs
  children?: NodeSpecOrStub[]
}

/** A child is either a full spec or a depth/wide-collapse stub. */
export type NodeSpecOrStub = NodeSpec | IdStub

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
