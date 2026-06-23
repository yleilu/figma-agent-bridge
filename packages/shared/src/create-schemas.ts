import { z } from 'zod'

// --- Nested schemas ---

const createTextSpecSchema = z.object({
  content: z.string().describe('The text string.'),
  font: z
    .string()
    .describe(
      'Font expression: Family/Style/Size (e.g., Inter/SemiBold/18).',
    ),
  align: z
    .enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'])
    .optional()
    .describe('Horizontal text alignment.'),
  valign: z
    .enum(['TOP', 'CENTER', 'BOTTOM'])
    .optional()
    .describe('Vertical text alignment.'),
  color: z
    .string()
    .optional()
    .describe(
      'Text color as hex expression (e.g., #1A1A1A).',
    ),
  lineHeight: z
    .string()
    .optional()
    .describe('Line height: "24px", "150%", or "auto".'),
  letterSpacing: z
    .string()
    .optional()
    .describe('Letter spacing: "0.5px" or "2%".'),
  decoration: z
    .enum(['UNDERLINE', 'STRIKETHROUGH'])
    .optional()
    .describe('Text decoration.'),
  case: z
    .enum([
      'UPPER',
      'LOWER',
      'TITLE',
      'SMALL_CAPS',
      'SMALL_CAPS_FORCED',
    ])
    .optional()
    .describe('Text case transform.'),
  paragraphSpacing: z
    .number()
    .optional()
    .describe('Paragraph spacing in px.'),
})

const createLayoutSpecSchema = z.object({
  mode: z
    .enum(['H', 'V'])
    .describe('H = HORIZONTAL, V = VERTICAL.'),
  spacing: z.number().describe('Item spacing in px.'),
  padding: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe('[top, right, bottom, left] in px.'),
  align: z
    .tuple([z.string(), z.string()])
    .describe(
      '[primaryAxisAlignItems, counterAxisAlignItems].',
    ),
  wrap: z
    .boolean()
    .optional()
    .describe('Enable WRAP layout.'),
  counterAxisSpacing: z
    .number()
    .optional()
    .describe('Gap between wrapped rows in px.'),
  counterAxisAlignContent: z
    .enum(['AUTO', 'SPACE_BETWEEN'])
    .optional()
    .describe(
      'Alignment of wrapped tracks along the counter axis.',
    ),
  primaryAxisSizingMode: z
    .enum(['FIXED', 'AUTO'])
    .optional()
    .describe("Frame's own sizing along the primary axis."),
  counterAxisSizingMode: z
    .enum(['FIXED', 'AUTO'])
    .optional()
    .describe("Frame's own sizing along the counter axis."),
})

const createComponentRefSchema = z.object({
  key: z.string().describe('Component key for importing.'),
  properties: z
    .record(z.union([z.string(), z.boolean()]))
    .optional()
    .describe('Property overrides for the instance.'),
})

const createVectorPathSchema = z.object({
  windingRule: z.enum(['EVENODD', 'NONZERO']),
  data: z.string().describe('SVG path data string.'),
})

const createArcDataSchema = z.object({
  startingAngle: z.number(),
  endingAngle: z.number(),
  innerRadius: z.number(),
})

// --- Node spec schema (non-recursive, for create_node) ---

const nodeSpecSchema = z.object({
  // Identity
  type: z
    .string()
    .describe(
      'Figma node type (FRAME, RECTANGLE, TEXT, etc.).',
    ),
  name: z
    .string()
    .optional()
    .describe('Node name. Defaults to type name.'),

  // Geometry
  size: z
    .tuple([z.number(), z.number()])
    .describe('[width, height] in px.'),
  position: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('[x, y] position relative to parent.'),

  // Layout (FRAME only)
  layout: createLayoutSpecSchema
    .optional()
    .describe('Auto-layout configuration.'),

  // Child sizing
  sizing: z
    .tuple([z.string(), z.string()])
    .optional()
    .describe(
      '[horizontal, vertical] sizing: FIXED, HUG, or FILL.',
    ),
  layoutPositioning: z
    .enum(['AUTO', 'ABSOLUTE'])
    .optional()
    .describe('Layout positioning mode.'),
  minWidth: z.number().nullable().optional(),
  maxWidth: z.number().nullable().optional(),
  minHeight: z.number().nullable().optional(),
  maxHeight: z.number().nullable().optional(),

  // Visual
  fills: z
    .array(z.string())
    .optional()
    .describe('Fill expressions: hex, gradient, or image.'),
  strokes: z
    .array(z.string())
    .optional()
    .describe('Stroke color expressions.'),
  strokeWeight: z.number().optional(),
  strokeAlign: z
    .enum(['CENTER', 'INSIDE', 'OUTSIDE'])
    .optional(),
  strokeDash: z
    .array(z.number())
    .optional()
    .describe('Dash pattern [dash, gap, ...].'),
  radius: z
    .union([
      z.number(),
      z.tuple([
        z.number(),
        z.number(),
        z.number(),
        z.number(),
      ]),
    ])
    .optional()
    .describe(
      'Corner radius: uniform number or [TL, TR, BR, BL].',
    ),
  opacity: z.number().min(0).max(1).optional(),
  effects: z
    .array(z.string())
    .optional()
    .describe(
      'Effect expressions: shadow(), inner-shadow(), blur(), bg-blur().',
    ),
  blendMode: z.string().optional(),
  rotation: z.number().optional(),
  visible: z.boolean().optional(),
  clipsContent: z.boolean().optional(),

  // Text
  text: createTextSpecSchema
    .optional()
    .describe('Text properties (TEXT nodes only).'),
  textAutoResize: z
    .enum([
      'NONE',
      'WIDTH_AND_HEIGHT',
      'HEIGHT',
      'TRUNCATE',
    ])
    .optional(),

  // Component / Instance
  component: createComponentRefSchema
    .optional()
    .describe('Component reference for INSTANCE nodes.'),

  // Type-specific
  pointCount: z
    .number()
    .optional()
    .describe('Number of points/sides (POLYGON, STAR).'),
  innerRadius: z
    .number()
    .optional()
    .describe(
      'Inner radius ratio 0-1 (STAR, ELLIPSE arcData).',
    ),
  arcData: createArcDataSchema
    .optional()
    .describe('Arc configuration (ELLIPSE).'),
  vectorPaths: z
    .array(createVectorPathSchema)
    .optional()
    .describe('Vector path data (VECTOR).'),
  sectionContentsHidden: z
    .boolean()
    .optional()
    .describe('Hide section contents (SECTION).'),
  booleanOperation: z
    .enum(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'])
    .optional()
    .describe(
      'Boolean operation type (BOOLEAN_OPERATION in create_tree).',
    ),

  // TEXT_PATH
  vectorNodeId: z
    .string()
    .optional()
    .describe('VectorNode ID for TEXT_PATH type.'),
  startSegment: z
    .number()
    .optional()
    .describe(
      'Start segment index on the vector path (TEXT_PATH).',
    ),
  startPosition: z
    .number()
    .optional()
    .describe(
      'Start position along the segment 0-1 (TEXT_PATH).',
    ),

  // TRANSFORM_GROUP
  modifiers: z
    .record(z.unknown())
    .optional()
    .describe(
      'Transform modifiers for TRANSFORM_GROUP (rotation, scale, skew).',
    ),
})

// --- Tree node spec (recursive, for create_tree) ---

const cloneRefSchema = z.object({
  id: z
    .string()
    .describe(
      'ID of existing node to clone. COMPONENT → creates INSTANCE.',
    ),
})

// Zod lazy for recursive type
const treeNodeSpecSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    nodeSpecSchema.extend({
      children: z.array(treeNodeSpecSchema).optional(),
    }),
    cloneRefSchema,
  ]),
)

// --- Tool parameter schemas ---

export const createNodeParamsSchema = z.object({
  parentId: z
    .string()
    .describe(
      'Parent node ID where the new node will be appended. Use a FRAME, SECTION, or PAGE ID.',
    ),
  node: nodeSpecSchema.describe(
    'Node specification. Same structure as get_node output.',
  ),
})

export const createTreeParamsSchema = z.object({
  parentId: z
    .string()
    .describe(
      'Parent node ID where the root of the tree will be appended.',
    ),
  node: treeNodeSpecSchema.describe(
    'Root node specification with optional children[]. Supports { id } for cloning existing nodes.',
  ),
})

const componentPropertySchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      name: z.string().describe('Property name.'),
      type: z.literal('BOOLEAN'),
      default: z
        .boolean()
        .describe(
          'Default boolean value for a BOOLEAN property.',
        ),
    }),
    z.object({
      name: z.string().describe('Property name.'),
      type: z.literal('TEXT'),
      default: z
        .string()
        .describe(
          'Default text value for a TEXT property.',
        ),
    }),
    z.object({
      name: z.string().describe('Property name.'),
      type: z.literal('INSTANCE_SWAP'),
      default: z
        .string()
        .min(1)
        .describe(
          'Default component key for INSTANCE_SWAP (must not be empty).',
        ),
    }),
    z.object({
      name: z.string().describe('Property name.'),
      type: z.literal('SLOT'),
    }),
  ],
)

export const createComponentParamsSchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe(
      'Node ID to promote to component via createComponentFromNode().',
    ),
  nodeIds: z
    .array(z.string())
    .optional()
    .describe(
      'Node IDs to combine as variants via combineAsVariants().',
    ),
  combineAsVariants: z
    .boolean()
    .optional()
    .describe(
      'If true, combines nodeIds into a ComponentSet (variant group).',
    ),
  slots: z
    .array(z.string())
    .optional()
    .describe(
      'Child names to promote to SLOT after component creation.',
    ),
  componentProperties: z
    .array(componentPropertySchema)
    .optional()
    .describe(
      'Component properties to add after promotion (BOOLEAN, TEXT, INSTANCE_SWAP, SLOT).',
    ),
})

export const createFromSvgParamsSchema = z.object({
  parentId: z
    .string()
    .describe(
      'Parent node ID where the SVG frame will be appended.',
    ),
  svg: z
    .string()
    .describe(
      'SVG string to import. Must be valid SVG markup.',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Name for the created frame. Defaults to "SVG".',
    ),
  size: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe(
      'Optional [width, height] to resize the SVG frame after creation.',
    ),
})
