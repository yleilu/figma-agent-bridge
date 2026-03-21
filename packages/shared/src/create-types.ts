// --- Create tool input types ---

/** Spec for text properties — matches ParsedNode.text from get_node output */
export type CreateTextSpec = {
  content: string
  font: string
  align?: string
  valign?: string
  color?: string
  lineHeight?: string
  letterSpacing?: string
  decoration?: string
  case?: string
  paragraphSpacing?: number
}

/** Spec for layout properties — matches ParsedNode.layout from get_node output */
export type CreateLayoutSpec = {
  mode: 'H' | 'V'
  spacing: number
  padding: [number, number, number, number]
  align: [string, string]
  wrap?: boolean
  counterAxisSpacing?: number
  counterAxisAlignContent?: 'AUTO' | 'SPACE_BETWEEN'
  primaryAxisSizingMode?: 'FIXED' | 'AUTO'
  counterAxisSizingMode?: 'FIXED' | 'AUTO'
}

/** Spec for component reference in INSTANCE creation */
export type CreateComponentRefSpec = {
  key: string
  properties?: Record<string, string | boolean>
}

/** Spec for vector path data */
export type CreateVectorPathSpec = {
  windingRule: 'EVENODD' | 'NONZERO'
  data: string
}

/** Spec for arc data (ELLIPSE) */
export type CreateArcDataSpec = {
  startingAngle: number
  endingAngle: number
  innerRadius: number
}

/** Single node spec — matches get_node output structure */
export type CreateNodeSpec = {
  // Identity
  type: string
  name?: string

  // Geometry
  size: [number, number]
  position?: [number, number]

  // Layout (FRAME only)
  layout?: CreateLayoutSpec

  // Child sizing
  sizing?: [string, string]
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'
  minWidth?: number | null
  maxWidth?: number | null
  minHeight?: number | null
  maxHeight?: number | null

  // Visual
  fills?: string[]
  strokes?: string[]
  strokeWeight?: number
  strokeAlign?: string
  strokeDash?: number[]
  radius?: number | [number, number, number, number]
  opacity?: number
  effects?: string[]
  blendMode?: string
  rotation?: number
  visible?: boolean
  clipsContent?: boolean

  // Text
  text?: CreateTextSpec
  textAutoResize?: string

  // Component / Instance
  component?: CreateComponentRefSpec

  // Type-specific
  pointCount?: number
  innerRadius?: number
  arcData?: CreateArcDataSpec
  vectorPaths?: CreateVectorPathSpec[]
  sectionContentsHidden?: boolean
  booleanOperation?:
    | 'UNION'
    | 'SUBTRACT'
    | 'INTERSECT'
    | 'EXCLUDE'

  // TEXT_PATH
  vectorNodeId?: string
  startSegment?: number
  startPosition?: number

  // TRANSFORM_GROUP
  modifiers?: Record<string, unknown>
}

/** Tree node spec — extends CreateNodeSpec with children, or is a clone reference */
export type CreateTreeNodeSpec =
  | (CreateNodeSpec & { children?: CreateTreeNodeSpec[] })
  | { id: string }

/** Response from plugin after creating a node */
export type CreateNodeResult = {
  id: string
  name: string
  type: string
}

/** Response from plugin after creating a component */
export type CreateComponentResult = {
  id: string
  name: string
  type: string
  key: string
}

/** Response from plugin after creating from SVG */
export type CreateFromSvgResult = {
  id: string
  name: string
  type: string
  childCount: number
}
