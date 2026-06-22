# M3: Build & Create — Implementation Plan

## Goal

Implement 4 MCP tools (`create_node`, `create_tree`, `create_component`, `create_from_svg`) that support all 18 Figma Design node types with full round-trip fidelity: `create_node` input = `get_node` output.

## Architecture

```
Agent (MCP client)
  |
  | create_node / create_tree / create_component / create_from_svg
  v
Server (packages/server)
  |  - Zod schema validation
  |  - Expression parsing (hex→Paint, shadow()→Effect, font→FontName)
  |  - Sends plugin command via relay
  v
Plugin (packages/figma-plugin)
  |  - Receives command, creates Figma nodes
  |  - Handles ordering constraints (FILL after append, font loading, etc.)
  |  - Returns created node info
  v
Figma Canvas
```

**Core design principle:** The node spec passed to `create_node` uses the same structure as `get_node` output. The server-side handler converts expression strings (hex colors, font expressions, effect expressions) into structured Figma API objects before sending to the plugin.

**Smart clone:** When a node spec in `create_tree` has an `id` field (referencing an existing node), clone it instead of creating from scratch. If the existing node is a COMPONENT, create an INSTANCE. If INSTANCE, create another instance of the same component.

## Tech Stack

- Runtime: Bun
- Test: `bun:test`
- Schema: Zod
- Language: TypeScript (strict)
- Monorepo: Bun workspaces (`packages/shared`, `packages/server`, `packages/figma-plugin`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for every implementation task. Each task follows strict TDD: write failing test first, verify failure, review test, implement minimal code, verify pass, commit.

---

## File Map

### New Files

| File | Package | Responsibility |
|------|---------|----------------|
| `packages/shared/src/create-schemas.ts` | shared | Zod schemas for 4 create tools |
| `packages/shared/src/create-types.ts` | shared | TypeScript types for create tool inputs/outputs |
| `packages/server/src/tools/create.ts` | server | `handleCreateNode` + `handleCreateTree` handlers |
| `packages/server/src/tools/create-component.ts` | server | `handleCreateComponent` handler |
| `packages/server/src/tools/create-svg.ts` | server | `handleCreateFromSvg` handler |
| `packages/server/src/expression-parser.ts` | server | Parse expression strings to Figma API objects |
| `packages/server/test/tools/create.test.ts` | server | Unit tests for create handlers |
| `packages/server/test/tools/create-component.test.ts` | server | Unit tests for create-component handler |
| `packages/server/test/tools/create-svg.test.ts` | server | Unit tests for create-svg handler |
| `packages/server/test/expression-parser.test.ts` | server | Unit tests for expression parsing |
| `packages/server/test/fixtures/created-node-response.json` | server | Fixture for plugin create response |
| `packages/server/test/integration/e2e-create.test.ts` | server | E2E tests for create tools |

### Modified Files

| File | Changes |
|------|---------|
| `packages/shared/src/index.ts` | Export new schemas and types |
| `packages/server/src/index.ts` | Register 4 new tools |
| `packages/figma-plugin/src/code.ts` | Add `create_node`, `create_tree`, `create_component`, `create_from_svg` command handlers |
| `packages/server/test/mocks/mock-plugin.ts` | Add mock handlers for create commands |

---

## Task 1: Shared Types and Schemas

### 1.1 Create types file

- [ ] Step 1: Write failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Test file:** `packages/server/test/create-schemas.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import {
  createNodeParamsSchema,
  createTreeParamsSchema,
  createComponentParamsSchema,
  createFromSvgParamsSchema,
} from '@figma-agent-bridge/shared'

describe('createNodeParamsSchema', () => {
  it('validates a minimal FRAME spec', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Container',
        size: [200, 100],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a RECTANGLE with fills and radius', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'RECTANGLE',
        name: 'Card BG',
        size: [320, 200],
        fills: ['#3B82F6'],
        radius: 8,
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a TEXT node with font expression', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'TEXT',
        name: 'Title',
        size: [200, 24],
        text: {
          content: 'Hello World',
          font: 'Inter/SemiBold/18',
          color: '#1A1A1A',
          align: 'LEFT',
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates an ELLIPSE with arcData', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'ELLIPSE',
        name: 'Circle',
        size: [100, 100],
        fills: ['#FF0000'],
        arcData: {
          startingAngle: 0,
          endingAngle: 6.28,
          innerRadius: 0,
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a STAR with pointCount and innerRadius', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'STAR',
        name: 'Star',
        size: [100, 100],
        pointCount: 5,
        innerRadius: 0.4,
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates an INSTANCE with componentKey', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'INSTANCE',
        name: 'Button',
        size: [120, 40],
        component: {
          key: 'abc123def456',
          properties: { Label: 'Click me' },
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates per-corner radius as tuple', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'RECTANGLE',
        name: 'Rounded',
        size: [100, 100],
        radius: [8, 8, 0, 0],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates layout properties', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Row',
        size: [400, 50],
        layout: {
          mode: 'H',
          spacing: 16,
          padding: [8, 16, 8, 16],
          align: ['MIN', 'CENTER'],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates layout with counterAxisAlignContent and sizing modes', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Wrap Grid',
        size: [400, 300],
        layout: {
          mode: 'H',
          spacing: 8,
          padding: [8, 8, 8, 8],
          align: ['MIN', 'MIN'],
          wrap: true,
          counterAxisSpacing: 8,
          counterAxisAlignContent: 'SPACE_BETWEEN',
          primaryAxisSizingMode: 'AUTO',
          counterAxisSizingMode: 'FIXED',
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates effects expressions', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Card',
        size: [320, 200],
        effects: ['shadow(0,4,8,#00000040)', 'blur(2)'],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates gradient fill expressions', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'RECTANGLE',
        name: 'Gradient BG',
        size: [400, 300],
        fills: ['linear-gradient(90deg, #FF0000 0%, #0000FF 100%)'],
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing type', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        name: 'No Type',
        size: [100, 100],
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing size', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'No Size',
      },
    })
    expect(result.success).toBe(false)
  })

  it('validates VECTOR with vectorPaths', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'VECTOR',
        name: 'Custom Path',
        size: [100, 100],
        vectorPaths: [
          { windingRule: 'EVENODD', data: 'M 0 0 L 100 0 L 100 100 Z' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates SECTION with sectionContentsHidden', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'SECTION',
        name: 'My Section',
        size: [500, 500],
        sectionContentsHidden: true,
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates text with lineHeight and letterSpacing', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'TEXT',
        name: 'Styled Text',
        size: [200, 48],
        text: {
          content: 'Hello',
          font: 'Inter/Regular/16',
          lineHeight: '24px',
          letterSpacing: '0.5px',
          decoration: 'UNDERLINE',
          case: 'UPPER',
          paragraphSpacing: 16,
        },
        textAutoResize: 'HEIGHT',
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates sizing and layoutPositioning', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Badge',
        size: [40, 40],
        sizing: ['FILL', 'HUG'],
        layoutPositioning: 'ABSOLUTE',
        position: [10, 10],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates minWidth/maxWidth/minHeight/maxHeight', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Responsive',
        size: [200, 100],
        minWidth: 100,
        maxWidth: 400,
        minHeight: 50,
        maxHeight: 300,
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a TEXT_PATH node with vectorNodeId', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'TEXT_PATH',
        name: 'Path Text',
        size: [200, 50],
        vectorNodeId: '3:15',
        startSegment: 0,
        startPosition: 0.1,
        text: {
          content: 'Along the path',
          font: 'Inter/Regular/14',
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a SLOT node (created as FRAME)', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'SLOT',
        name: 'Content Slot',
        size: [200, 100],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates stroke properties', () => {
    const result = createNodeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'RECTANGLE',
        name: 'Bordered',
        size: [100, 100],
        strokes: ['#000000'],
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
        strokeDash: [4, 4],
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('createTreeParamsSchema', () => {
  it('validates a tree with children', () => {
    const result = createTreeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Card',
        size: [320, 200],
        layout: {
          mode: 'V',
          spacing: 12,
          padding: [16, 16, 16, 16],
          align: ['MIN', 'MIN'],
        },
        fills: ['#FFFFFF'],
        children: [
          {
            type: 'TEXT',
            name: 'Title',
            size: [288, 24],
            text: {
              content: 'Card Title',
              font: 'Inter/SemiBold/18',
              color: '#1A1A1A',
            },
          },
          {
            type: 'RECTANGLE',
            name: 'Divider',
            size: [288, 1],
            fills: ['#E5E5E5'],
          },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a GROUP node (children first, then group)', () => {
    const result = createTreeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'GROUP',
        name: 'Icon Group',
        size: [100, 100],
        children: [
          { type: 'ELLIPSE', name: 'Circle', size: [50, 50], fills: ['#FF0000'] },
          { type: 'RECTANGLE', name: 'Square', size: [50, 50], fills: ['#0000FF'] },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a BOOLEAN_OPERATION node', () => {
    const result = createTreeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'BOOLEAN_OPERATION',
        name: 'Subtract Shape',
        size: [100, 100],
        booleanOperation: 'SUBTRACT',
        children: [
          { type: 'RECTANGLE', name: 'Base', size: [100, 100], fills: ['#000000'] },
          { type: 'ELLIPSE', name: 'Cutout', size: [60, 60], fills: ['#000000'] },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates a TRANSFORM_GROUP node', () => {
    const result = createTreeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'TRANSFORM_GROUP',
        name: 'Rotated Group',
        size: [100, 100],
        modifiers: { rotation: 45 },
        children: [
          { type: 'RECTANGLE', name: 'Inner', size: [50, 50], fills: ['#FF0000'] },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('validates clone-by-id reference', () => {
    const result = createTreeParamsSchema.safeParse({
      parentId: '1:2',
      node: {
        type: 'FRAME',
        name: 'Container',
        size: [400, 200],
        children: [
          { id: '5:99' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('createComponentParamsSchema', () => {
  it('validates promote-to-component', () => {
    const result = createComponentParamsSchema.safeParse({
      nodeId: '1:42',
    })
    expect(result.success).toBe(true)
  })

  it('validates combine-as-variants', () => {
    const result = createComponentParamsSchema.safeParse({
      nodeIds: ['1:42', '1:43', '1:44'],
      combineAsVariants: true,
    })
    expect(result.success).toBe(true)
  })

  it('validates promote-to-component with slots', () => {
    const result = createComponentParamsSchema.safeParse({
      nodeId: '1:42',
      slots: ['Content', 'Footer'],
    })
    expect(result.success).toBe(true)
  })

  it('validates promote-to-component with componentProperties', () => {
    const result = createComponentParamsSchema.safeParse({
      nodeId: '1:42',
      componentProperties: [
        { name: 'Show Icon', type: 'BOOLEAN', default: true },
        { name: 'Label', type: 'TEXT', default: 'Button' },
        { name: 'Icon', type: 'INSTANCE_SWAP', default: 'key:icon123' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects componentProperties with invalid type', () => {
    const result = createComponentParamsSchema.safeParse({
      nodeId: '1:42',
      componentProperties: [
        { name: 'Prop', type: 'INVALID_TYPE', default: 'x' },
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('createFromSvgParamsSchema', () => {
  it('validates SVG string input', () => {
    const result = createFromSvgParamsSchema.safeParse({
      parentId: '1:2',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 2L2 22h20L12 2z"/></svg>',
      name: 'Triangle Icon',
    })
    expect(result.success).toBe(true)
  })

  it('validates without optional name', () => {
    const result = createFromSvgParamsSchema.safeParse({
      parentId: '1:2',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50"/></svg>',
    })
    expect(result.success).toBe(true)
  })
})
```

**Run command:**
```bash
bun test packages/server/test/create-schemas.test.ts
```

**Expected output (failing):**
```
error: Cannot find module '@figma-agent-bridge/shared' ...createNodeParamsSchema
```

**Implementation file:** `packages/shared/src/create-types.ts`

```typescript
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
  booleanOperation?: 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE'

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
```

**Implementation file:** `packages/shared/src/create-schemas.ts`

```typescript
import { z } from 'zod'

// --- Nested schemas ---

const createTextSpecSchema = z.object({
  content: z.string().describe('The text string.'),
  font: z
    .string()
    .describe('Font expression: Family/Style/Size (e.g., Inter/SemiBold/18).'),
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
    .describe('Text color as hex expression (e.g., #1A1A1A).'),
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
    .enum(['UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED'])
    .optional()
    .describe('Text case transform.'),
  paragraphSpacing: z
    .number()
    .optional()
    .describe('Paragraph spacing in px.'),
})

const createLayoutSpecSchema = z.object({
  mode: z.enum(['H', 'V']).describe('H = HORIZONTAL, V = VERTICAL.'),
  spacing: z.number().describe('Item spacing in px.'),
  padding: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe('[top, right, bottom, left] in px.'),
  align: z
    .tuple([z.string(), z.string()])
    .describe('[primaryAxisAlignItems, counterAxisAlignItems].'),
  wrap: z.boolean().optional().describe('Enable WRAP layout.'),
  counterAxisSpacing: z
    .number()
    .optional()
    .describe('Gap between wrapped rows in px.'),
  counterAxisAlignContent: z
    .enum(['AUTO', 'SPACE_BETWEEN'])
    .optional()
    .describe('Alignment of wrapped tracks along the counter axis.'),
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
  type: z.string().describe('Figma node type (FRAME, RECTANGLE, TEXT, etc.).'),
  name: z.string().optional().describe('Node name. Defaults to type name.'),

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
    .describe('[horizontal, vertical] sizing: FIXED, HUG, or FILL.'),
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
  strokeAlign: z.enum(['CENTER', 'INSIDE', 'OUTSIDE']).optional(),
  strokeDash: z.array(z.number()).optional().describe('Dash pattern [dash, gap, ...].'),
  radius: z
    .union([z.number(), z.tuple([z.number(), z.number(), z.number(), z.number()])])
    .optional()
    .describe('Corner radius: uniform number or [TL, TR, BR, BL].'),
  opacity: z.number().min(0).max(1).optional(),
  effects: z
    .array(z.string())
    .optional()
    .describe('Effect expressions: shadow(), inner-shadow(), blur(), bg-blur().'),
  blendMode: z.string().optional(),
  rotation: z.number().optional(),
  visible: z.boolean().optional(),
  clipsContent: z.boolean().optional(),

  // Text
  text: createTextSpecSchema.optional().describe('Text properties (TEXT nodes only).'),
  textAutoResize: z
    .enum(['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'])
    .optional(),

  // Component / Instance
  component: createComponentRefSchema
    .optional()
    .describe('Component reference for INSTANCE nodes.'),

  // Type-specific
  pointCount: z.number().optional().describe('Number of points/sides (POLYGON, STAR).'),
  innerRadius: z
    .number()
    .optional()
    .describe('Inner radius ratio 0-1 (STAR, ELLIPSE arcData).'),
  arcData: createArcDataSchema.optional().describe('Arc configuration (ELLIPSE).'),
  vectorPaths: z
    .array(createVectorPathSchema)
    .optional()
    .describe('Vector path data (VECTOR).'),
  sectionContentsHidden: z.boolean().optional().describe('Hide section contents (SECTION).'),
  booleanOperation: z
    .enum(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'])
    .optional()
    .describe('Boolean operation type (BOOLEAN_OPERATION in create_tree).'),

  // TEXT_PATH
  vectorNodeId: z.string().optional().describe('VectorNode ID for TEXT_PATH type.'),
  startSegment: z.number().optional().describe('Start segment index on the vector path (TEXT_PATH).'),
  startPosition: z.number().optional().describe('Start position along the segment 0-1 (TEXT_PATH).'),

  // TRANSFORM_GROUP
  modifiers: z.record(z.unknown()).optional().describe('Transform modifiers for TRANSFORM_GROUP (rotation, scale, skew).'),
})

// --- Tree node spec (recursive, for create_tree) ---

const cloneRefSchema = z.object({
  id: z.string().describe('ID of existing node to clone. COMPONENT → creates INSTANCE.'),
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
    .describe('Parent node ID where the root of the tree will be appended.'),
  node: treeNodeSpecSchema.describe(
    'Root node specification with optional children[]. Supports { id } for cloning existing nodes.',
  ),
})

const componentPropertySchema = z.object({
  name: z.string().describe('Property name.'),
  type: z
    .enum(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'SLOT'])
    .describe('Property type.'),
  default: z
    .union([z.string(), z.boolean()])
    .describe('Default value. For INSTANCE_SWAP, must be a valid component key (not empty string).'),
})

export const createComponentParamsSchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe('Node ID to promote to component via createComponentFromNode().'),
  nodeIds: z
    .array(z.string())
    .optional()
    .describe('Node IDs to combine as variants via combineAsVariants().'),
  combineAsVariants: z
    .boolean()
    .optional()
    .describe('If true, combines nodeIds into a ComponentSet (variant group).'),
  slots: z
    .array(z.string())
    .optional()
    .describe('Child names to promote to SLOT after component creation.'),
  componentProperties: z
    .array(componentPropertySchema)
    .optional()
    .describe('Component properties to add after promotion (BOOLEAN, TEXT, INSTANCE_SWAP, SLOT).'),
})

export const createFromSvgParamsSchema = z.object({
  parentId: z
    .string()
    .describe('Parent node ID where the SVG frame will be appended.'),
  svg: z
    .string()
    .describe('SVG string to import. Must be valid SVG markup.'),
  name: z
    .string()
    .optional()
    .describe('Name for the created frame. Defaults to "SVG".'),
  size: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Optional [width, height] to resize the SVG frame after creation.'),
})
```

**Update `packages/shared/src/index.ts`:**

```typescript
export * from './types'
export * from './schemas'
export * from './create-types'
export * from './create-schemas'
export * from './constants'
```

**Run command (should pass):**
```bash
bun test packages/server/test/create-schemas.test.ts
```

**Expected output:**
```
 PASS  packages/server/test/create-schemas.test.ts
```

**Commit message:**
```
feat(shared): add Zod schemas and types for M3 create tools

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 2: Expression Parser

Parse expression strings (hex, gradients, shadow, font, etc.) into structured Figma API objects for the plugin.

### 2.1 Expression parser unit tests and implementation

- [ ] Step 1: Write failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Test file:** `packages/server/test/expression-parser.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import {
  parseColorExpression,
  parseFillExpressions,
  parseEffectExpressions,
  parseFontExpression,
  parseLineHeightExpression,
  parseLetterSpacingExpression,
} from '@figma-agent-bridge/server/expression-parser'

describe('parseColorExpression', () => {
  it('parses 6-char hex', () => {
    const result = parseColorExpression('#3B82F6')
    expect(result).toEqual({
      type: 'SOLID',
      color: { r: 0.231, g: 0.51, b: 0.965 },
      opacity: 1,
    })
    // Allow small rounding differences
    expect(result.color.r).toBeCloseTo(0.231, 2)
    expect(result.color.g).toBeCloseTo(0.51, 2)
    expect(result.color.b).toBeCloseTo(0.965, 2)
  })

  it('parses 8-char hex with alpha', () => {
    const result = parseColorExpression('#00000040')
    expect(result.color.r).toBe(0)
    expect(result.color.g).toBe(0)
    expect(result.color.b).toBe(0)
    expect(result.opacity).toBeCloseTo(0.251, 2)
  })

  it('strips style() prefix and parses hex', () => {
    const result = parseColorExpression('style(Colors/Primary/500)#3B82F6')
    expect(result.color.r).toBeCloseTo(0.231, 2)
    expect(result.styleName).toBe('Colors/Primary/500')
  })

  it('parses linear-gradient expression', () => {
    const result = parseColorExpression(
      'linear-gradient(90deg, #FF0000 0%, #0000FF 100%)',
    )
    expect(result.type).toBe('GRADIENT_LINEAR')
    expect(result.gradientStops).toHaveLength(2)
    expect(result.gradientStops[0].position).toBe(0)
    expect(result.gradientStops[0].color.r).toBeCloseTo(1, 2)
    expect(result.gradientStops[1].position).toBe(1)
    expect(result.gradientStops[1].color.b).toBeCloseTo(1, 2)
    expect(result.angle).toBe(90)
  })

  it('parses radial-gradient expression', () => {
    const result = parseColorExpression(
      'radial-gradient(#FFFFFF 0%, #00000000 100%)',
    )
    expect(result.type).toBe('GRADIENT_RADIAL')
    expect(result.gradientStops).toHaveLength(2)
  })

  it('parses angular-gradient expression', () => {
    const result = parseColorExpression(
      'angular-gradient(#FF0000 0%, #00FF00 50%, #0000FF 100%)',
    )
    expect(result.type).toBe('GRADIENT_ANGULAR')
    expect(result.gradientStops).toHaveLength(3)
  })

  it('parses diamond-gradient expression', () => {
    const result = parseColorExpression(
      'diamond-gradient(#FF0000 0%, #0000FF 100%)',
    )
    expect(result.type).toBe('GRADIENT_DIAMOND')
    expect(result.gradientStops).toHaveLength(2)
  })

  it('returns image sentinel for "image"', () => {
    const result = parseColorExpression('image')
    expect(result.type).toBe('IMAGE')
  })

  it('parses image() with URL', () => {
    const result = parseColorExpression('image(https://example.com/photo.jpg)')
    expect(result.type).toBe('IMAGE')
    expect((result as { imageUrl: string }).imageUrl).toBe('https://example.com/photo.jpg')
  })

  it('parses image() with URL and scaleMode', () => {
    const result = parseColorExpression('image(https://example.com/photo.jpg,FIT)')
    expect(result.type).toBe('IMAGE')
    expect((result as { imageUrl: string }).imageUrl).toBe('https://example.com/photo.jpg')
    expect((result as { scaleMode: string }).scaleMode).toBe('FIT')
  })

  it('parses image-hash() with hash value', () => {
    const result = parseColorExpression('image-hash(abc123def)')
    expect(result.type).toBe('IMAGE')
    expect((result as { imageHash: string }).imageHash).toBe('abc123def')
  })
})

describe('parseFillExpressions', () => {
  it('converts array of expressions to paint objects', () => {
    const paints = parseFillExpressions(['#FF0000', '#0000FF80'])
    expect(paints).toHaveLength(2)
    expect(paints[0].type).toBe('SOLID')
    expect(paints[1].opacity).toBeCloseTo(0.502, 2)
  })

  it('handles empty array', () => {
    const paints = parseFillExpressions([])
    expect(paints).toHaveLength(0)
  })
})

describe('parseEffectExpressions', () => {
  it('parses shadow() expression', () => {
    const effects = parseEffectExpressions(['shadow(0,4,8,#00000040)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[0].offset).toEqual({ x: 0, y: 4 })
    expect(effects[0].radius).toBe(8)
    expect(effects[0].color.a).toBeCloseTo(0.251, 2)
  })

  it('parses shadow() with spread', () => {
    const effects = parseEffectExpressions(['shadow(0,4,8,#000000,2)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].spread).toBe(2)
  })

  it('parses inner-shadow() expression', () => {
    const effects = parseEffectExpressions(['inner-shadow(0,2,4,#00000020)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('INNER_SHADOW')
  })

  it('parses blur() expression', () => {
    const effects = parseEffectExpressions(['blur(10)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('LAYER_BLUR')
    expect(effects[0].radius).toBe(10)
  })

  it('parses bg-blur() expression', () => {
    const effects = parseEffectExpressions(['bg-blur(20)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('BACKGROUND_BLUR')
    expect(effects[0].radius).toBe(20)
  })

  it('parses multiple mixed effects', () => {
    const effects = parseEffectExpressions([
      'shadow(0,4,8,#000)',
      'blur(2)',
    ])
    expect(effects).toHaveLength(2)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[1].type).toBe('LAYER_BLUR')
  })

  it('strips style() prefix from effects', () => {
    const effects = parseEffectExpressions([
      'style(Elevation/Medium)shadow(0,4,8,#00000040)',
    ])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[0].styleName).toBe('Elevation/Medium')
  })
})

describe('parseFontExpression', () => {
  it('parses family/style/size', () => {
    const result = parseFontExpression('Inter/SemiBold/18')
    expect(result.family).toBe('Inter')
    expect(result.style).toBe('SemiBold')
    expect(result.size).toBe(18)
  })

  it('parses style() prefixed font', () => {
    const result = parseFontExpression('style(Heading/H1)Inter/Bold/32')
    expect(result.family).toBe('Inter')
    expect(result.style).toBe('Bold')
    expect(result.size).toBe(32)
    expect(result.styleName).toBe('Heading/H1')
  })

  it('handles multi-word style names', () => {
    const result = parseFontExpression('Inter/Bold Italic/16')
    expect(result.family).toBe('Inter')
    expect(result.style).toBe('Bold Italic')
    expect(result.size).toBe(16)
  })

  it('handles font families with spaces', () => {
    const result = parseFontExpression('Noto Sans/Regular/14')
    expect(result.family).toBe('Noto Sans')
    expect(result.style).toBe('Regular')
    expect(result.size).toBe(14)
  })
})

describe('parseLineHeightExpression', () => {
  it('parses px value', () => {
    const result = parseLineHeightExpression('24px')
    expect(result).toEqual({ value: 24, unit: 'PIXELS' })
  })

  it('parses percentage value', () => {
    const result = parseLineHeightExpression('150%')
    expect(result).toEqual({ value: 150, unit: 'PERCENT' })
  })

  it('parses auto', () => {
    const result = parseLineHeightExpression('auto')
    expect(result).toEqual({ unit: 'AUTO' })
  })
})

describe('parseLetterSpacingExpression', () => {
  it('parses px value', () => {
    const result = parseLetterSpacingExpression('0.5px')
    expect(result).toEqual({ value: 0.5, unit: 'PIXELS' })
  })

  it('parses percentage value', () => {
    const result = parseLetterSpacingExpression('2%')
    expect(result).toEqual({ value: 2, unit: 'PERCENT' })
  })
})
```

**Run command:**
```bash
bun test packages/server/test/expression-parser.test.ts
```

**Expected output (failing):**
```
error: Cannot find module '@figma-agent-bridge/server/expression-parser'
```

**Implementation file:** `packages/server/src/expression-parser.ts`

```typescript
// --- Color parsing ---

type ParsedSolidPaint = {
  type: 'SOLID'
  color: { r: number; g: number; b: number }
  opacity: number
  styleName?: string
}

type ParsedGradientStop = {
  position: number
  color: { r: number; g: number; b: number; a: number }
}

type ParsedGradientPaint = {
  type:
    | 'GRADIENT_LINEAR'
    | 'GRADIENT_RADIAL'
    | 'GRADIENT_ANGULAR'
    | 'GRADIENT_DIAMOND'
  gradientStops: ParsedGradientStop[]
  angle?: number
  styleName?: string
}

type ParsedImagePaint = {
  type: 'IMAGE'
  imageUrl?: string
  imageHash?: string
  scaleMode?: string
  styleName?: string
}

export type ParsedPaint =
  | ParsedSolidPaint
  | ParsedGradientPaint
  | ParsedImagePaint

type ParsedShadowEffect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW'
  offset: { x: number; y: number }
  radius: number
  color: { r: number; g: number; b: number; a: number }
  spread?: number
  styleName?: string
}

type ParsedBlurEffect = {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'
  radius: number
  styleName?: string
}

export type ParsedEffect = ParsedShadowEffect | ParsedBlurEffect

export type ParsedFont = {
  family: string
  style: string
  size: number
  styleName?: string
}

export type ParsedLineHeight =
  | { value: number; unit: 'PIXELS' }
  | { value: number; unit: 'PERCENT' }
  | { unit: 'AUTO' }

export type ParsedLetterSpacing = {
  value: number
  unit: 'PIXELS' | 'PERCENT'
}

// --- Helpers ---

const extractStylePrefix = (
  expr: string,
): { styleName?: string; value: string } => {
  const match = expr.match(/^style\(([^)]+)\)(.*)$/)
  if (match) {
    return { styleName: match[1], value: match[2] }
  }
  return { value: expr }
}

const hexToRgb = (
  hex: string,
): { r: number; g: number; b: number; a: number } => {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1
  return { r, g, b, a }
}

const parseGradientStops = (
  stopsStr: string,
): ParsedGradientStop[] => {
  const stops: ParsedGradientStop[] = []
  // Match patterns like "#FF0000 0%" or "#00FF00 50%"
  const regex = /(#[0-9A-Fa-f]{6,8})\s+(\d+(?:\.\d+)?)%/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(stopsStr)) !== null) {
    const color = hexToRgb(match[1])
    const position = parseFloat(match[2]) / 100
    stops.push({ position, color })
  }
  return stops
}

// --- Public API ---

export const parseColorExpression = (expr: string): ParsedPaint => {
  const { styleName, value } = extractStylePrefix(expr)

  if (value === 'image') {
    return { type: 'IMAGE', ...(styleName ? { styleName } : {}) }
  }

  // image(url) or image(url,scaleMode)
  const imageUrlMatch = value.match(/^image\((.+?)(?:,(\w+))?\)$/)
  if (imageUrlMatch) {
    return {
      type: 'IMAGE',
      imageUrl: imageUrlMatch[1],
      ...(imageUrlMatch[2] ? { scaleMode: imageUrlMatch[2] } : {}),
      ...(styleName ? { styleName } : {}),
    }
  }

  // image-hash(hash)
  const imageHashMatch = value.match(/^image-hash\((.+?)\)$/)
  if (imageHashMatch) {
    return {
      type: 'IMAGE',
      imageHash: imageHashMatch[1],
      ...(styleName ? { styleName } : {}),
    }
  }

  // Gradient patterns
  const gradientMatch = value.match(
    /^(linear|radial|angular|diamond)-gradient\((.+)\)$/,
  )
  if (gradientMatch) {
    const gradientType = gradientMatch[1]
    const inner = gradientMatch[2]

    const typeMap: Record<string, ParsedGradientPaint['type']> = {
      linear: 'GRADIENT_LINEAR',
      radial: 'GRADIENT_RADIAL',
      angular: 'GRADIENT_ANGULAR',
      diamond: 'GRADIENT_DIAMOND',
    }

    let angle: number | undefined
    let stopsStr = inner

    if (gradientType === 'linear') {
      const angleMatch = inner.match(/^(\d+(?:\.\d+)?)deg,\s*(.+)$/)
      if (angleMatch) {
        angle = parseFloat(angleMatch[1])
        stopsStr = angleMatch[2]
      }
    }

    const gradientStops = parseGradientStops(stopsStr)

    return {
      type: typeMap[gradientType],
      gradientStops,
      ...(angle !== undefined ? { angle } : {}),
      ...(styleName ? { styleName } : {}),
    }
  }

  // Solid hex
  const color = hexToRgb(value)
  return {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
    opacity: color.a,
    ...(styleName ? { styleName } : {}),
  }
}

export const parseFillExpressions = (
  expressions: string[],
): ParsedPaint[] => {
  return expressions.map(parseColorExpression)
}

export const parseEffectExpressions = (
  expressions: string[],
): ParsedEffect[] => {
  return expressions.map(expr => {
    const { styleName, value } = extractStylePrefix(expr)

    // shadow(x,y,radius,color) or shadow(x,y,radius,color,spread)
    const shadowMatch = value.match(
      /^(shadow|inner-shadow)\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(#[0-9A-Fa-f]{3,8})(?:,(\d+(?:\.\d+)?))?\)$/,
    )
    if (shadowMatch) {
      const color = hexToRgb(shadowMatch[5])
      const result: ParsedShadowEffect = {
        type: shadowMatch[1] === 'shadow' ? 'DROP_SHADOW' : 'INNER_SHADOW',
        offset: {
          x: parseFloat(shadowMatch[2]),
          y: parseFloat(shadowMatch[3]),
        },
        radius: parseFloat(shadowMatch[4]),
        color,
        ...(shadowMatch[6] !== undefined
          ? { spread: parseFloat(shadowMatch[6]) }
          : {}),
        ...(styleName ? { styleName } : {}),
      }
      return result
    }

    // blur(radius)
    const blurMatch = value.match(/^(blur|bg-blur)\((\d+(?:\.\d+)?)\)$/)
    if (blurMatch) {
      return {
        type: blurMatch[1] === 'blur' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR',
        radius: parseFloat(blurMatch[2]),
        ...(styleName ? { styleName } : {}),
      } as ParsedBlurEffect
    }

    throw new Error(`Unknown effect expression: ${expr}`)
  })
}

export const parseFontExpression = (expr: string): ParsedFont => {
  const { styleName, value } = extractStylePrefix(expr)

  // Font format: Family/Style/Size
  // Split from the right — size is always last, style is second-to-last
  const lastSlash = value.lastIndexOf('/')
  const sizeStr = value.slice(lastSlash + 1)
  const rest = value.slice(0, lastSlash)
  const secondSlash = rest.lastIndexOf('/')
  const style = rest.slice(secondSlash + 1)
  const family = rest.slice(0, secondSlash)

  return {
    family,
    style,
    size: parseFloat(sizeStr),
    ...(styleName ? { styleName } : {}),
  }
}

export const parseLineHeightExpression = (
  expr: string,
): ParsedLineHeight => {
  if (expr === 'auto') {
    return { unit: 'AUTO' }
  }
  if (expr.endsWith('px')) {
    return { value: parseFloat(expr), unit: 'PIXELS' }
  }
  if (expr.endsWith('%')) {
    return { value: parseFloat(expr), unit: 'PERCENT' }
  }
  // Default to pixels if no unit
  return { value: parseFloat(expr), unit: 'PIXELS' }
}

export const parseLetterSpacingExpression = (
  expr: string,
): ParsedLetterSpacing => {
  if (expr.endsWith('%')) {
    return { value: parseFloat(expr), unit: 'PERCENT' }
  }
  if (expr.endsWith('px')) {
    return { value: parseFloat(expr), unit: 'PIXELS' }
  }
  return { value: parseFloat(expr), unit: 'PIXELS' }
}
```

**Run command (should pass):**
```bash
bun test packages/server/test/expression-parser.test.ts
```

**Commit message:**
```
feat(server): add expression parser for M3 create tools

Parses hex/gradient fill expressions, shadow/blur effect expressions,
font/lineHeight/letterSpacing expressions into structured Figma API objects.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 3: Plugin — Basic Shape Creation

Add command handlers in the Figma plugin for creating FRAME, RECTANGLE, ELLIPSE, LINE, POLYGON, STAR nodes.

### 3.1 Plugin create_node command handler

- [ ] Step 1: Write failing test (mock plugin test in server)
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Test file:** `packages/server/test/tools/create.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCreateNode,
  handleCreateTree,
} from '@figma-agent-bridge/server/tools/create'

const createMockClient = (
  handler: (cmd: string, params: Record<string, unknown>) => unknown,
): FigmaClient => ({
  joinChannel: () => Promise.resolve(''),
  sendCommand: (cmd, params) =>
    Promise.resolve(handler(cmd, params ?? {})),
  disconnect: () => undefined,
  isConnected: () => true,
  currentChannel: () => 'test-ch',
})

describe('handleCreateNode', () => {
  it('returns error when not connected', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleCreateNode(
      {
        parentId: '1:2',
        node: { type: 'FRAME', name: 'Test', size: [100, 100] },
      },
      client,
    )

    expect(result.content[0].text).toContain('Not connected')
  })

  it('sends create_node command with parsed fills', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:1', name: 'Card BG', type: 'RECTANGLE' }
      }
      return null
    })

    const result = await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Card BG',
          size: [320, 200],
          fills: ['#3B82F6'],
          radius: 8,
        },
      },
      client,
    )

    expect(result.content[0].text).toContain('99:1')
    expect(sentParams.node).toBeDefined()
    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('RECTANGLE')
    // Fills should be parsed from expression to paint objects
    const fills = node.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID')
  })

  it('resolves style names to style IDs when style cache is provided', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:20', name: 'Styled', type: 'RECTANGLE' }
      }
      return null
    })

    // Provide a style cache with known style mappings
    const styleCache = new Map([
      ['Colors/Primary/500', 'S:fill-style-id'],
      ['Elevation/Medium', 'S:effect-style-id'],
    ])

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Styled',
          size: [100, 100],
          fills: ['style(Colors/Primary/500)#3B82F6'],
          effects: ['style(Elevation/Medium)shadow(0,4,8,#00000040)'],
        },
      },
      client,
      styleCache,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.fillStyleId).toBe('S:fill-style-id')
    expect(node.effectStyleId).toBe('S:effect-style-id')
  })

  it('sends create_node with parsed effects', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:2', name: 'Shadow Box', type: 'FRAME' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Shadow Box',
          size: [200, 200],
          effects: ['shadow(0,4,8,#00000040)'],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const effects = node.effects as { type: string }[]
    expect(effects[0].type).toBe('DROP_SHADOW')
  })

  it('sends create_node with parsed text properties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:3', name: 'Title', type: 'TEXT' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'TEXT',
          name: 'Title',
          size: [200, 24],
          text: {
            content: 'Hello World',
            font: 'Inter/SemiBold/18',
            color: '#1A1A1A',
            lineHeight: '24px',
            letterSpacing: '0.5px',
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const text = node.text as Record<string, unknown>
    expect(text.content).toBe('Hello World')
    const font = text.font as { family: string; style: string; size: number }
    expect(font.family).toBe('Inter')
    expect(font.style).toBe('SemiBold')
    expect(font.size).toBe(18)
    const lineHeight = text.lineHeight as { value: number; unit: string }
    expect(lineHeight.value).toBe(24)
    expect(lineHeight.unit).toBe('PIXELS')
  })

  it('sends create_node with layout properties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:4', name: 'Row', type: 'FRAME' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Row',
          size: [400, 50],
          layout: {
            mode: 'H',
            spacing: 16,
            padding: [8, 16, 8, 16],
            align: ['MIN', 'CENTER'],
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.layout).toBeDefined()
  })

  it('sends create_node with counterAxisAlignContent and sizing modes', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:40', name: 'Grid', type: 'FRAME' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Grid',
          size: [400, 300],
          layout: {
            mode: 'H',
            spacing: 8,
            padding: [8, 8, 8, 8],
            align: ['MIN', 'MIN'],
            wrap: true,
            counterAxisAlignContent: 'SPACE_BETWEEN',
            primaryAxisSizingMode: 'AUTO',
            counterAxisSizingMode: 'FIXED',
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const layout = node.layout as Record<string, unknown>
    expect(layout.counterAxisAlignContent).toBe('SPACE_BETWEEN')
    expect(layout.primaryAxisSizingMode).toBe('AUTO')
    expect(layout.counterAxisSizingMode).toBe('FIXED')
  })

  it('sends create_node with gradient fill', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:5', name: 'Gradient', type: 'RECTANGLE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Gradient',
          size: [400, 300],
          fills: ['linear-gradient(90deg, #FF0000 0%, #0000FF 100%)'],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const fills = node.fills as { type: string }[]
    expect(fills[0].type).toBe('GRADIENT_LINEAR')
  })

  it('sends create_node with image fill from URL', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:30', name: 'Photo', type: 'RECTANGLE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Photo',
          size: [400, 300],
          fills: ['image(https://example.com/photo.jpg,FIT)'],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const fills = node.fills as { type: string; imageUrl?: string; scaleMode?: string }[]
    expect(fills[0].type).toBe('IMAGE')
    expect(fills[0].imageUrl).toBe('https://example.com/photo.jpg')
    expect(fills[0].scaleMode).toBe('FIT')
  })

  it('sends create_node with image fill from hash', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:31', name: 'Cached', type: 'RECTANGLE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Cached',
          size: [200, 200],
          fills: ['image-hash(abc123def)'],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const fills = node.fills as { type: string; imageHash?: string }[]
    expect(fills[0].type).toBe('IMAGE')
    expect(fills[0].imageHash).toBe('abc123def')
  })

  it('sends per-corner radius', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:6', name: 'Rounded', type: 'RECTANGLE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'RECTANGLE',
          name: 'Rounded',
          size: [100, 100],
          radius: [8, 8, 0, 0],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.radius).toEqual([8, 8, 0, 0])
  })

  it('sends ELLIPSE with arcData', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:7', name: 'Arc', type: 'ELLIPSE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'ELLIPSE',
          name: 'Arc',
          size: [100, 100],
          arcData: { startingAngle: 0, endingAngle: 3.14, innerRadius: 0.5 },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.arcData).toEqual({
      startingAngle: 0,
      endingAngle: 3.14,
      innerRadius: 0.5,
    })
  })

  it('sends STAR with pointCount and innerRadius', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:8', name: 'Star', type: 'STAR' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'STAR',
          name: 'Star',
          size: [100, 100],
          pointCount: 5,
          innerRadius: 0.4,
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.pointCount).toBe(5)
    expect(node.innerRadius).toBe(0.4)
  })

  it('sends TEXT_PATH with vectorNodeId', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:20', name: 'Path Text', type: 'TEXT_PATH' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'TEXT_PATH',
          name: 'Path Text',
          size: [200, 50],
          vectorNodeId: '3:15',
          startSegment: 0,
          startPosition: 0.1,
          text: {
            content: 'Along the path',
            font: 'Inter/Regular/14',
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('TEXT_PATH')
    expect(node.vectorNodeId).toBe('3:15')
    expect(node.startSegment).toBe(0)
    expect(node.startPosition).toBe(0.1)
  })

  it('sends INSTANCE with component key and properties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_node') {
        sentParams = params
        return { id: '99:9', name: 'Button', type: 'INSTANCE' }
      }
      return null
    })

    await handleCreateNode(
      {
        parentId: '1:2',
        node: {
          type: 'INSTANCE',
          name: 'Button',
          size: [120, 40],
          component: {
            key: 'abc123',
            properties: { Label: 'Click me' },
          },
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.component).toEqual({
      key: 'abc123',
      properties: { Label: 'Click me' },
    })
  })
})

describe('handleCreateTree', () => {
  it('sends create_tree command with nested children', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:10', name: 'Card', type: 'FRAME' }
      }
      return null
    })

    const result = await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Card',
          size: [320, 200],
          fills: ['#FFFFFF'],
          children: [
            {
              type: 'TEXT',
              name: 'Title',
              size: [288, 24],
              text: { content: 'Hello', font: 'Inter/Bold/18' },
            },
          ],
        },
      },
      client,
    )

    expect(result.content[0].text).toContain('99:10')
    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('FRAME')
    const children = node.children as Record<string, unknown>[]
    expect(children).toHaveLength(1)
    expect(children[0].type).toBe('TEXT')
  })

  it('passes clone reference { id } through unchanged', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:11', name: 'Container', type: 'FRAME' }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Container',
          size: [400, 200],
          children: [{ id: '5:99' }],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const children = node.children as Record<string, unknown>[]
    expect(children[0]).toEqual({ id: '5:99' })
  })

  it('parses expressions recursively in children', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:12', name: 'Row', type: 'FRAME' }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'FRAME',
          name: 'Row',
          size: [400, 100],
          children: [
            {
              type: 'RECTANGLE',
              name: 'Box',
              size: [100, 100],
              fills: ['#FF0000'],
              effects: ['shadow(0,2,4,#000)'],
            },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    const children = node.children as Record<string, unknown>[]
    const box = children[0]
    const fills = box.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID')
    const effects = box.effects as { type: string }[]
    expect(effects[0].type).toBe('DROP_SHADOW')
  })

  it('sends GROUP type through to plugin', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:13', name: 'Icon Group', type: 'GROUP' }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'GROUP',
          name: 'Icon Group',
          size: [100, 100],
          children: [
            { type: 'ELLIPSE', name: 'Circle', size: [50, 50] },
            { type: 'RECTANGLE', name: 'Square', size: [50, 50] },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('GROUP')
  })

  it('sends TRANSFORM_GROUP with modifiers', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:21', name: 'Rotated Group', type: 'TRANSFORM_GROUP' }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'TRANSFORM_GROUP',
          name: 'Rotated Group',
          size: [100, 100],
          modifiers: { rotation: 45 },
          children: [
            { type: 'RECTANGLE', name: 'Inner', size: [50, 50] },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('TRANSFORM_GROUP')
    expect(node.modifiers).toEqual({ rotation: 45 })
  })

  it('sends BOOLEAN_OPERATION with operation type', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_tree') {
        sentParams = params
        return { id: '99:14', name: 'Union', type: 'BOOLEAN_OPERATION' }
      }
      return null
    })

    await handleCreateTree(
      {
        parentId: '1:2',
        node: {
          type: 'BOOLEAN_OPERATION',
          name: 'Union',
          size: [100, 100],
          booleanOperation: 'UNION',
          children: [
            { type: 'RECTANGLE', name: 'A', size: [100, 100] },
            { type: 'ELLIPSE', name: 'B', size: [80, 80] },
          ],
        },
      },
      client,
    )

    const node = sentParams.node as Record<string, unknown>
    expect(node.type).toBe('BOOLEAN_OPERATION')
    expect(node.booleanOperation).toBe('UNION')
  })
})
```

**Run command:**
```bash
bun test packages/server/test/tools/create.test.ts
```

**Expected output (failing):**
```
error: Cannot find module '@figma-agent-bridge/server/tools/create'
```

**Implementation file:** `packages/server/src/tools/create.ts`

```typescript
import type { FigmaClient } from '../figma-client'
import type { CreateNodeSpec, CreateTreeNodeSpec } from '@figma-agent-bridge/shared'
import {
  parseFillExpressions,
  parseEffectExpressions,
  parseFontExpression,
  parseLineHeightExpression,
  parseLetterSpacingExpression,
  parseColorExpression,
} from '../expression-parser'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

/** Style cache type — populated by inspect_styles or similar tools */
type StyleCache = Map<string, string> // styleName → styleId

/**
 * Resolve style(name) references to styleIds using the style cache.
 * When a fill/effect/text expression contains style(Name), resolve the name
 * to a Figma style ID and attach it to the converted node spec.
 */
const resolveStyleIds = (
  converted: Record<string, unknown>,
  styleCache: StyleCache,
): void => {
  // Resolve fill style
  const fills = converted.fills as { styleName?: string }[] | undefined
  if (fills) {
    for (const fill of fills) {
      if (fill.styleName) {
        const styleId = styleCache.get(fill.styleName)
        if (styleId) {
          converted.fillStyleId = styleId
        }
      }
    }
  }

  // Resolve stroke style
  const strokes = converted.strokes as { styleName?: string }[] | undefined
  if (strokes) {
    for (const stroke of strokes) {
      if (stroke.styleName) {
        const styleId = styleCache.get(stroke.styleName)
        if (styleId) {
          converted.strokeStyleId = styleId
        }
      }
    }
  }

  // Resolve effect style
  const effects = converted.effects as { styleName?: string }[] | undefined
  if (effects) {
    for (const effect of effects) {
      if (effect.styleName) {
        const styleId = styleCache.get(effect.styleName)
        if (styleId) {
          converted.effectStyleId = styleId
        }
      }
    }
  }

  // Resolve text style
  const text = converted.text as { font?: { styleName?: string } } | undefined
  if (text?.font?.styleName) {
    const styleId = styleCache.get(text.font.styleName)
    if (styleId) {
      converted.textStyleId = styleId
    }
  }
}

/**
 * Convert expression strings in a node spec to structured Figma API objects.
 * This transforms the agent-friendly format into plugin-ready format.
 */
const convertNodeSpec = (
  spec: CreateNodeSpec,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    type: spec.type,
    name: spec.name ?? spec.type,
    size: spec.size,
  }

  // Position
  if (spec.position !== undefined) {
    result.position = spec.position
  }

  // Layout
  if (spec.layout !== undefined) {
    result.layout = spec.layout
  }

  // Sizing
  if (spec.sizing !== undefined) {
    result.sizing = spec.sizing
  }
  if (spec.layoutPositioning !== undefined) {
    result.layoutPositioning = spec.layoutPositioning
  }
  if (spec.minWidth !== undefined) result.minWidth = spec.minWidth
  if (spec.maxWidth !== undefined) result.maxWidth = spec.maxWidth
  if (spec.minHeight !== undefined) result.minHeight = spec.minHeight
  if (spec.maxHeight !== undefined) result.maxHeight = spec.maxHeight

  // Parse fills from expressions to paint objects
  if (spec.fills !== undefined) {
    result.fills = parseFillExpressions(spec.fills)
  }

  // Parse strokes from expressions to paint objects
  if (spec.strokes !== undefined) {
    result.strokes = parseFillExpressions(spec.strokes)
  }

  // Stroke properties
  if (spec.strokeWeight !== undefined) result.strokeWeight = spec.strokeWeight
  if (spec.strokeAlign !== undefined) result.strokeAlign = spec.strokeAlign
  if (spec.strokeDash !== undefined) result.strokeDash = spec.strokeDash

  // Radius
  if (spec.radius !== undefined) {
    result.radius = spec.radius
  }

  // Scalar visual properties
  if (spec.opacity !== undefined) result.opacity = spec.opacity
  if (spec.blendMode !== undefined) result.blendMode = spec.blendMode
  if (spec.rotation !== undefined) result.rotation = spec.rotation
  if (spec.visible !== undefined) result.visible = spec.visible
  if (spec.clipsContent !== undefined) result.clipsContent = spec.clipsContent

  // Parse effects from expressions to effect objects
  if (spec.effects !== undefined) {
    result.effects = parseEffectExpressions(spec.effects)
  }

  // Text properties
  if (spec.text !== undefined) {
    const font = parseFontExpression(spec.text.font)
    const text: Record<string, unknown> = {
      content: spec.text.content,
      font,
    }
    if (spec.text.align !== undefined) text.align = spec.text.align
    if (spec.text.valign !== undefined) text.valign = spec.text.valign
    if (spec.text.color !== undefined) {
      text.color = parseColorExpression(spec.text.color)
    }
    if (spec.text.lineHeight !== undefined) {
      text.lineHeight = parseLineHeightExpression(spec.text.lineHeight)
    }
    if (spec.text.letterSpacing !== undefined) {
      text.letterSpacing = parseLetterSpacingExpression(spec.text.letterSpacing)
    }
    if (spec.text.decoration !== undefined) text.decoration = spec.text.decoration
    if (spec.text.case !== undefined) text.case = spec.text.case
    if (spec.text.paragraphSpacing !== undefined) {
      text.paragraphSpacing = spec.text.paragraphSpacing
    }
    result.text = text
  }
  if (spec.textAutoResize !== undefined) {
    result.textAutoResize = spec.textAutoResize
  }

  // Component / Instance
  if (spec.component !== undefined) {
    result.component = spec.component
  }

  // Type-specific properties (pass through)
  if (spec.pointCount !== undefined) result.pointCount = spec.pointCount
  if (spec.innerRadius !== undefined) result.innerRadius = spec.innerRadius
  if (spec.arcData !== undefined) result.arcData = spec.arcData
  if (spec.vectorPaths !== undefined) result.vectorPaths = spec.vectorPaths
  if (spec.sectionContentsHidden !== undefined) {
    result.sectionContentsHidden = spec.sectionContentsHidden
  }
  if (spec.booleanOperation !== undefined) {
    result.booleanOperation = spec.booleanOperation
  }

  // TEXT_PATH properties
  if (spec.vectorNodeId !== undefined) result.vectorNodeId = spec.vectorNodeId
  if (spec.startSegment !== undefined) result.startSegment = spec.startSegment
  if (spec.startPosition !== undefined) result.startPosition = spec.startPosition

  // TRANSFORM_GROUP properties
  if (spec.modifiers !== undefined) result.modifiers = spec.modifiers

  return result
}

/**
 * Recursively convert a tree node spec, including children.
 * Clone references ({ id }) pass through unchanged.
 */
const convertTreeNodeSpec = (
  spec: CreateTreeNodeSpec,
): Record<string, unknown> => {
  // Clone reference
  if ('id' in spec && !('type' in spec)) {
    return { id: spec.id }
  }

  const nodeSpec = spec as CreateNodeSpec & { children?: CreateTreeNodeSpec[] }
  const result = convertNodeSpec(nodeSpec)

  if (nodeSpec.children !== undefined) {
    result.children = nodeSpec.children.map(convertTreeNodeSpec)
  }

  return result
}

export const handleCreateNode = async (
  params: {
    parentId: string
    node: CreateNodeSpec
  },
  client: FigmaClient,
  styleCache?: StyleCache,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Not connected to Figma. Use connect tool first.',
        },
      ],
    }
  }

  const converted = convertNodeSpec(params.node)

  // Resolve style(name) → styleId if style cache is available
  if (styleCache) {
    resolveStyleIds(converted, styleCache)
  }

  const result = (await client.sendCommand('create_node', {
    parentId: params.parentId,
    node: converted,
  })) as Record<string, unknown> | null

  if (result === null) {
    return {
      content: [
        { type: 'text', text: 'Failed to create node.' },
      ],
    }
  }

  if (result.error !== undefined) {
    return {
      content: [
        { type: 'text', text: `Error: ${result.error}` },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}

export const handleCreateTree = async (
  params: {
    parentId: string
    node: CreateTreeNodeSpec
  },
  client: FigmaClient,
  styleCache?: StyleCache,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Not connected to Figma. Use connect tool first.',
        },
      ],
    }
  }

  const converted = convertTreeNodeSpec(params.node)

  // Resolve style references recursively in tree
  if (styleCache) {
    const resolveTreeStyles = (node: Record<string, unknown>) => {
      if ('type' in node) {
        resolveStyleIds(node, styleCache)
        const children = node.children as Record<string, unknown>[] | undefined
        if (children) {
          for (const child of children) {
            resolveTreeStyles(child)
          }
        }
      }
    }
    resolveTreeStyles(converted)
  }

  const result = (await client.sendCommand('create_tree', {
    parentId: params.parentId,
    node: converted,
  })) as Record<string, unknown> | null

  if (result === null) {
    return {
      content: [
        { type: 'text', text: 'Failed to create tree.' },
      ],
    }
  }

  if (result.error !== undefined) {
    return {
      content: [
        { type: 'text', text: `Error: ${result.error}` },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}
```

**Run command (should pass):**
```bash
bun test packages/server/test/tools/create.test.ts
```

**Commit message:**
```
feat(server): add create_node and create_tree handler with expression conversion

Server-side handlers parse agent-friendly expressions (hex, shadow(),
font strings) into structured Figma API objects before sending to plugin.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 4: Plugin — create_node Command Handler

Implement the `create_node` command in the Figma plugin that creates a single node from the converted spec.

### 4.1 Plugin implementation

- [ ] Step 1: Write failing test (e2e test that sends create_node through relay)
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code in plugin + mock plugin
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

Since the plugin code runs inside Figma's sandbox and cannot be unit-tested directly, we test via the mock plugin in e2e tests and implement the real plugin code in parallel.

**Mock plugin update** — add to `packages/server/test/mocks/mock-plugin.ts`, inside the `switch` block:

```typescript
      case 'create_node': {
        const nodeSpec = cmd.params?.node as Record<string, unknown>
        const parentId = cmd.params?.parentId as string
        result = {
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name: (nodeSpec?.name as string) ?? (nodeSpec?.type as string),
          type: nodeSpec?.type as string,
          parentId,
        }
        break
      }

      case 'create_tree': {
        const treeSpec = cmd.params?.node as Record<string, unknown>
        const treeParentId = cmd.params?.parentId as string
        // Count total nodes in tree
        const countNodes = (node: Record<string, unknown>): number => {
          let count = 1
          const children = node.children as Record<string, unknown>[] | undefined
          if (children) {
            for (const child of children) {
              count += countNodes(child)
            }
          }
          return count
        }
        const totalNodes = countNodes(treeSpec)
        result = {
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name: (treeSpec?.name as string) ?? (treeSpec?.type as string),
          type: treeSpec?.type as string,
          parentId: treeParentId,
          totalNodes,
        }
        break
      }

      case 'create_component': {
        const compNodeId = cmd.params?.nodeId as string | undefined
        const compNodeIds = cmd.params?.nodeIds as string[] | undefined
        const combine = cmd.params?.combineAsVariants as boolean | undefined
        if (combine && compNodeIds) {
          result = {
            id: `cs:${Math.random().toString(36).slice(2, 8)}`,
            name: 'VariantSet',
            type: 'COMPONENT_SET',
            key: `key:${Math.random().toString(36).slice(2, 8)}`,
          }
        } else {
          result = {
            id: compNodeId ?? `comp:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Component',
            type: 'COMPONENT',
            key: `key:${Math.random().toString(36).slice(2, 8)}`,
          }
        }
        break
      }

      case 'create_from_svg': {
        const svgName = (cmd.params?.name as string) ?? 'SVG'
        result = {
          id: `svg:${Math.random().toString(36).slice(2, 8)}`,
          name: svgName,
          type: 'FRAME',
          childCount: 3,
        }
        break
      }
```

**Plugin implementation** — add to `packages/figma-plugin/src/code.ts`, inside the `handleCommand` switch:

```typescript
    case 'create_node': {
      const parentNode = await figma.getNodeByIdAsync(params.parentId as string);
      if (!parentNode || !('appendChild' in parentNode)) {
        return { error: 'Parent not found or cannot have children: ' + params.parentId };
      }
      const parent = parentNode as FrameNode | PageNode | SectionNode;
      const spec = params.node as Record<string, unknown>;
      const created = await createSingleNode(spec, parent);
      return { id: created.id, name: created.name, type: created.type };
    }

    case 'create_tree': {
      const treeParent = await figma.getNodeByIdAsync(params.parentId as string);
      if (!treeParent || !('appendChild' in treeParent)) {
        return { error: 'Parent not found or cannot have children: ' + params.parentId };
      }
      const treeParentNode = treeParent as FrameNode | PageNode | SectionNode;
      const treeSpec = params.node as Record<string, unknown>;
      const treeResult = await createTreeNode(treeSpec, treeParentNode);
      return { id: treeResult.id, name: treeResult.name, type: treeResult.type };
    }

    case 'create_component': {
      if (params.combineAsVariants && params.nodeIds) {
        const compNodes: ComponentNode[] = [];
        for (const nid of params.nodeIds as string[]) {
          const n = await figma.getNodeByIdAsync(nid);
          if (n && n.type === 'COMPONENT') {
            compNodes.push(n as ComponentNode);
          }
        }
        if (compNodes.length < 2) {
          return { error: 'Need at least 2 components for combineAsVariants' };
        }
        const parent = compNodes[0].parent as BaseNode & ChildrenMixin;
        const cs = figma.combineAsVariants(compNodes, parent);
        return { id: cs.id, name: cs.name, type: cs.type, key: cs.key };
      }
      const nodeToPromote = await figma.getNodeByIdAsync(params.nodeId as string);
      if (!nodeToPromote) {
        return { error: 'Node not found: ' + params.nodeId };
      }
      const comp = figma.createComponentFromNode(nodeToPromote as SceneNode);

      // Create slots if specified
      const slots = params.slots as string[] | undefined;
      if (slots) {
        for (const slotName of slots) {
          comp.createSlot(slotName);
        }
      }

      // Add component properties if specified
      const componentProperties = params.componentProperties as
        { name: string; type: string; default: string | boolean }[] | undefined;
      if (componentProperties) {
        for (const prop of componentProperties) {
          comp.addComponentProperty(
            prop.name,
            prop.type as ComponentPropertyType,
            prop.default,
          );
        }
      }

      return { id: comp.id, name: comp.name, type: comp.type, key: comp.key };
    }

    case 'create_from_svg': {
      const svgParent = await figma.getNodeByIdAsync(params.parentId as string);
      if (!svgParent || !('appendChild' in svgParent)) {
        return { error: 'Parent not found: ' + params.parentId };
      }
      const svgFrame = figma.createNodeFromSvg(params.svg as string);
      if (params.name) {
        svgFrame.name = params.name as string;
      }
      if (params.size) {
        const [w, h] = params.size as [number, number];
        svgFrame.resize(w, h);
      }
      (svgParent as FrameNode).appendChild(svgFrame);
      return {
        id: svgFrame.id,
        name: svgFrame.name,
        type: svgFrame.type,
        childCount: svgFrame.children.length,
      };
    }
```

**Add these helper functions to `packages/figma-plugin/src/code.ts`** (before `handleCommand`):

```typescript
type ParentNode = FrameNode | PageNode | SectionNode | ComponentNode | GroupNode;

const applyCommonProperties = async (
  node: SceneNode,
  spec: Record<string, unknown>,
  parent: ParentNode,
): Promise<void> => {
  // Name
  if (spec.name !== undefined) {
    node.name = spec.name as string;
  }

  // Size
  if (spec.size !== undefined) {
    const [w, h] = spec.size as [number, number];
    node.resize(w, h);
  }

  // Position
  if (spec.position !== undefined) {
    const [x, y] = spec.position as [number, number];
    node.x = x;
    node.y = y;
  }

  // Fills (already parsed to paint objects by server)
  if (spec.fills !== undefined) {
    const fills = spec.fills as (Paint & { imageUrl?: string; imageHash?: string; scaleMode?: string })[];
    const paintArray: Paint[] = [];
    for (const fill of fills) {
      if (fill.type === 'SOLID' && fill.color) {
        paintArray.push({
          type: 'SOLID',
          color: fill.color as RGB,
          opacity: (fill as SolidPaint).opacity ?? 1,
        } as SolidPaint);
      } else if (fill.type === 'IMAGE' && fill.imageUrl) {
        // Fetch image from URL and create ImagePaint
        const image = await figma.createImageAsync(fill.imageUrl);
        paintArray.push({
          type: 'IMAGE',
          imageHash: image.hash,
          scaleMode: (fill.scaleMode as ImagePaint['scaleMode']) ?? 'FILL',
        } as ImagePaint);
      } else if (fill.type === 'IMAGE' && fill.imageHash) {
        // Use existing image hash directly
        paintArray.push({
          type: 'IMAGE',
          imageHash: fill.imageHash,
          scaleMode: (fill.scaleMode as ImagePaint['scaleMode']) ?? 'FILL',
        } as ImagePaint);
      } else {
        paintArray.push(fill);
      }
    }
    (node as GeometryMixin & SceneNode).fills = paintArray;
  }

  // Strokes
  if (spec.strokes !== undefined) {
    const strokes = spec.strokes as Paint[];
    const strokeArray: Paint[] = [];
    for (const stroke of strokes) {
      if (stroke.type === 'SOLID' && stroke.color) {
        strokeArray.push({
          type: 'SOLID',
          color: stroke.color as RGB,
          opacity: (stroke as SolidPaint).opacity ?? 1,
        } as SolidPaint);
      } else {
        strokeArray.push(stroke);
      }
    }
    (node as GeometryMixin & SceneNode).strokes = strokeArray;
  }

  // Stroke properties
  if (spec.strokeWeight !== undefined) {
    (node as GeometryMixin & SceneNode).strokeWeight = spec.strokeWeight as number;
  }
  if (spec.strokeAlign !== undefined) {
    (node as GeometryMixin & SceneNode).strokeAlign = spec.strokeAlign as StrokeAlign;
  }
  if (spec.strokeDash !== undefined) {
    (node as GeometryMixin & SceneNode).dashPattern = spec.strokeDash as number[];
  }

  // Corner radius
  if (spec.radius !== undefined) {
    if (Array.isArray(spec.radius)) {
      const [tl, tr, br, bl] = spec.radius as [number, number, number, number];
      const rn = node as RectangleNode | FrameNode;
      rn.topLeftRadius = tl;
      rn.topRightRadius = tr;
      rn.bottomRightRadius = br;
      rn.bottomLeftRadius = bl;
    } else {
      (node as RectangleNode | FrameNode | EllipseNode).cornerRadius = spec.radius as number;
    }
  }

  // Scalar visual properties
  if (spec.opacity !== undefined) node.opacity = spec.opacity as number;
  if (spec.blendMode !== undefined) node.blendMode = spec.blendMode as BlendMode;
  if (spec.rotation !== undefined) node.rotation = spec.rotation as number;
  if (spec.visible !== undefined) node.visible = spec.visible as boolean;
  if (spec.clipsContent !== undefined) {
    (node as FrameNode).clipsContent = spec.clipsContent as boolean;
  }

  // Effects (already parsed to effect objects by server)
  if (spec.effects !== undefined) {
    const effects = spec.effects as Effect[];
    // Ensure visible defaults
    (node as GeometryMixin & SceneNode).effects = effects.map((e) => ({
      ...e,
      visible: (e as DropShadowEffect).visible ?? true,
    }));
  }

  // Layout (FRAME only)
  if (spec.layout !== undefined && 'layoutMode' in node) {
    const layout = spec.layout as {
      mode: string;
      spacing: number;
      padding: [number, number, number, number];
      align: [string, string];
      wrap?: boolean;
      counterAxisSpacing?: number;
      counterAxisAlignContent?: string;
      primaryAxisSizingMode?: string;
      counterAxisSizingMode?: string;
    };
    const frame = node as FrameNode;
    frame.layoutMode = layout.mode === 'H' ? 'HORIZONTAL' : 'VERTICAL';
    frame.itemSpacing = layout.spacing;
    frame.paddingTop = layout.padding[0];
    frame.paddingRight = layout.padding[1];
    frame.paddingBottom = layout.padding[2];
    frame.paddingLeft = layout.padding[3];
    frame.primaryAxisAlignItems = layout.align[0] as 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN';
    frame.counterAxisAlignItems = layout.align[1] as 'MIN' | 'MAX' | 'CENTER' | 'BASELINE';
    if (layout.wrap) {
      frame.layoutWrap = 'WRAP';
    }
    if (layout.counterAxisSpacing !== undefined) {
      frame.counterAxisSpacing = layout.counterAxisSpacing;
    }
    if (layout.counterAxisAlignContent !== undefined) {
      frame.counterAxisAlignContent = layout.counterAxisAlignContent as 'AUTO' | 'SPACE_BETWEEN';
    }
    if (layout.primaryAxisSizingMode !== undefined) {
      frame.primaryAxisSizingMode = layout.primaryAxisSizingMode as 'FIXED' | 'AUTO';
    }
    if (layout.counterAxisSizingMode !== undefined) {
      frame.counterAxisSizingMode = layout.counterAxisSizingMode as 'FIXED' | 'AUTO';
    }
  }

  // Min/max sizing
  if (spec.minWidth !== undefined) (node as FrameNode).minWidth = spec.minWidth as number | null;
  if (spec.maxWidth !== undefined) (node as FrameNode).maxWidth = spec.maxWidth as number | null;
  if (spec.minHeight !== undefined) (node as FrameNode).minHeight = spec.minHeight as number | null;
  if (spec.maxHeight !== undefined) (node as FrameNode).maxHeight = spec.maxHeight as number | null;

  // Apply resolved style IDs (server resolves style(name) → styleId)
  if (spec.fillStyleId !== undefined) {
    (node as GeometryMixin & SceneNode).fillStyleId = spec.fillStyleId as string;
  }
  if (spec.strokeStyleId !== undefined) {
    (node as GeometryMixin & SceneNode).strokeStyleId = spec.strokeStyleId as string;
  }
  if (spec.effectStyleId !== undefined) {
    (node as GeometryMixin & SceneNode).effectStyleId = spec.effectStyleId as string;
  }
  if (spec.textStyleId !== undefined && 'textStyleId' in node) {
    (node as TextNode).textStyleId = spec.textStyleId as string;
  }
};

const applyPostAppendProperties = (
  node: SceneNode,
  spec: Record<string, unknown>,
): void => {
  // These must be set AFTER appendChild to auto-layout parent

  // Sizing
  if (spec.sizing !== undefined) {
    const [h, v] = spec.sizing as [string, string];
    (node as FrameNode).layoutSizingHorizontal = h as 'FIXED' | 'HUG' | 'FILL';
    (node as FrameNode).layoutSizingVertical = v as 'FIXED' | 'HUG' | 'FILL';
  }

  // Layout positioning (ABSOLUTE)
  if (spec.layoutPositioning !== undefined) {
    (node as FrameNode).layoutPositioning = spec.layoutPositioning as 'AUTO' | 'ABSOLUTE';
  }
};

const applyTextProperties = async (
  node: TextNode,
  spec: Record<string, unknown>,
): Promise<void> => {
  const text = spec.text as Record<string, unknown>;
  if (!text) return;

  const font = text.font as { family: string; style: string; size: number };

  // Load font first — REQUIRED before setting any text property
  await figma.loadFontAsync({ family: font.family, style: font.style });

  // Set font
  node.fontName = { family: font.family, style: font.style };
  node.fontSize = font.size;

  // Text auto-resize (set before content to avoid resize fighting)
  if (spec.textAutoResize !== undefined) {
    node.textAutoResize = spec.textAutoResize as 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  }

  // Set text content
  if (text.content !== undefined) {
    node.characters = text.content as string;
  }

  // Alignment
  if (text.align !== undefined) {
    node.textAlignHorizontal = text.align as 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  }
  if (text.valign !== undefined) {
    node.textAlignVertical = text.valign as 'TOP' | 'CENTER' | 'BOTTOM';
  }

  // Text color (from parsed paint)
  if (text.color !== undefined) {
    const paint = text.color as { type: string; color: RGB; opacity: number };
    if (paint.type === 'SOLID') {
      node.fills = [{ type: 'SOLID', color: paint.color, opacity: paint.opacity ?? 1 }];
    }
  }

  // Line height
  if (text.lineHeight !== undefined) {
    const lh = text.lineHeight as { value?: number; unit: string };
    if (lh.unit === 'AUTO') {
      node.lineHeight = { unit: 'AUTO' };
    } else if (lh.unit === 'PIXELS') {
      node.lineHeight = { value: lh.value!, unit: 'PIXELS' };
    } else if (lh.unit === 'PERCENT') {
      node.lineHeight = { value: lh.value!, unit: 'PERCENT' };
    }
  }

  // Letter spacing
  if (text.letterSpacing !== undefined) {
    const ls = text.letterSpacing as { value: number; unit: string };
    node.letterSpacing = { value: ls.value, unit: ls.unit as 'PIXELS' | 'PERCENT' };
  }

  // Decoration
  if (text.decoration !== undefined) {
    node.textDecoration = text.decoration as 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  }

  // Case
  if (text.case !== undefined) {
    node.textCase = text.case as 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  }

  // Paragraph spacing
  if (text.paragraphSpacing !== undefined) {
    node.paragraphSpacing = text.paragraphSpacing as number;
  }
};

const createSingleNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
): Promise<SceneNode> => {
  const type = spec.type as string;
  let node: SceneNode;

  switch (type) {
    case 'FRAME':
      node = figma.createFrame();
      break;
    case 'RECTANGLE':
      node = figma.createRectangle();
      break;
    case 'ELLIPSE': {
      const ellipse = figma.createEllipse();
      if (spec.arcData !== undefined) {
        ellipse.arcData = spec.arcData as ArcData;
      }
      node = ellipse;
      break;
    }
    case 'TEXT':
      node = figma.createText();
      break;
    case 'LINE':
      node = figma.createLine();
      break;
    case 'POLYGON': {
      const polygon = figma.createPolygon();
      if (spec.pointCount !== undefined) {
        polygon.pointCount = spec.pointCount as number;
      }
      node = polygon;
      break;
    }
    case 'STAR': {
      const star = figma.createStar();
      if (spec.pointCount !== undefined) {
        star.pointCount = spec.pointCount as number;
      }
      if (spec.innerRadius !== undefined) {
        star.innerRadius = spec.innerRadius as number;
      }
      node = star;
      break;
    }
    case 'VECTOR': {
      const vector = figma.createVector();
      if (spec.vectorPaths !== undefined) {
        vector.vectorPaths = spec.vectorPaths as VectorPath[];
      }
      node = vector;
      break;
    }
    case 'SECTION': {
      const section = figma.createSection();
      if (spec.sectionContentsHidden !== undefined) {
        section.sectionContentsHidden = spec.sectionContentsHidden as boolean;
      }
      node = section;
      break;
    }
    case 'SLICE':
      node = figma.createSlice();
      break;
    case 'INSTANCE': {
      const compRef = spec.component as { key: string; properties?: Record<string, string | boolean> };
      const component = await figma.importComponentByKeyAsync(compRef.key);
      const instance = component.createInstance();
      if (compRef.properties) {
        instance.setProperties(compRef.properties);
      }
      node = instance;
      break;
    }
    case 'TEXT_PATH': {
      // TEXT_PATH requires an existing VectorNode and path segment info
      const vectorNodeId = spec.vectorNodeId as string;
      const startSegment = (spec.startSegment as number) ?? 0;
      const startPosition = (spec.startPosition as number) ?? 0;
      const vectorNode = await figma.getNodeByIdAsync(vectorNodeId);
      if (!vectorNode || vectorNode.type !== 'VECTOR') {
        throw new Error('TEXT_PATH requires a valid VectorNode ID, got: ' + vectorNodeId);
      }
      node = figma.createTextPath(vectorNode as VectorNode, startSegment, startPosition);
      break;
    }
    case 'SLOT': {
      // SLOT in create_node context: create a FRAME placeholder.
      // Actual SLOT promotion happens in create_component via component.createSlot().
      node = figma.createFrame();
      break;
    }
    default:
      throw new Error('Unsupported node type: ' + type);
  }

  // Apply common properties (fills, strokes, effects, etc.)
  await applyCommonProperties(node, spec, parent);

  // Apply text-specific properties (requires font loading)
  if (type === 'TEXT') {
    await applyTextProperties(node as TextNode, spec);
  }

  // Append to parent
  parent.appendChild(node);

  // Apply post-append properties (FILL sizing, ABSOLUTE positioning)
  applyPostAppendProperties(node, spec);

  return node;
};

const createTreeNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
): Promise<SceneNode> => {
  const type = spec.type as string;

  // Clone reference: { id }
  if (spec.id !== undefined && spec.type === undefined) {
    const existing = await figma.getNodeByIdAsync(spec.id as string);
    if (!existing) throw new Error('Node not found for clone: ' + spec.id);

    if (existing.type === 'COMPONENT') {
      // COMPONENT → create INSTANCE
      const instance = (existing as ComponentNode).createInstance();
      parent.appendChild(instance);
      return instance;
    }
    if (existing.type === 'INSTANCE') {
      // INSTANCE → create another instance of same component
      const mainComp = (existing as InstanceNode).mainComponent;
      if (mainComp) {
        const instance = mainComp.createInstance();
        parent.appendChild(instance);
        return instance;
      }
    }
    // Default: clone
    const cloned = (existing as SceneNode).clone();
    parent.appendChild(cloned);
    return cloned;
  }

  // GROUP: create children first, then group
  if (type === 'GROUP') {
    const children = spec.children as Record<string, unknown>[] | undefined;
    if (!children || children.length === 0) {
      throw new Error('GROUP requires at least one child');
    }
    const childNodes: SceneNode[] = [];
    for (const childSpec of children) {
      const child = await createTreeNode(childSpec, parent);
      childNodes.push(child);
    }
    const group = figma.group(childNodes, parent);
    if (spec.name) group.name = spec.name as string;
    return group;
  }

  // TRANSFORM_GROUP: create children first, then wrap (similar to GROUP)
  if (type === 'TRANSFORM_GROUP') {
    const children = spec.children as Record<string, unknown>[] | undefined;
    if (!children || children.length === 0) {
      throw new Error('TRANSFORM_GROUP requires at least one child');
    }
    const childNodes: SceneNode[] = [];
    for (const childSpec of children) {
      const child = await createTreeNode(childSpec, parent);
      childNodes.push(child);
    }
    const modifiers = spec.modifiers as Record<string, unknown> | undefined;
    const group = figma.group(childNodes, parent);
    if (spec.name) group.name = spec.name as string;
    // Apply transform modifiers if provided (rotation, scale, skew)
    if (modifiers) {
      if (modifiers.rotation !== undefined) group.rotation = modifiers.rotation as number;
    }
    return group;
  }

  // BOOLEAN_OPERATION: create children first, then combine
  if (type === 'BOOLEAN_OPERATION') {
    const children = spec.children as Record<string, unknown>[] | undefined;
    if (!children || children.length < 2) {
      throw new Error('BOOLEAN_OPERATION requires at least 2 children');
    }
    const childNodes: SceneNode[] = [];
    for (const childSpec of children) {
      const child = await createTreeNode(childSpec, parent);
      childNodes.push(child);
    }
    const op = spec.booleanOperation as string;
    let boolNode: BooleanOperationNode;
    switch (op) {
      case 'UNION':
        boolNode = figma.union(childNodes, parent);
        break;
      case 'SUBTRACT':
        boolNode = figma.subtract(childNodes, parent);
        break;
      case 'INTERSECT':
        boolNode = figma.intersect(childNodes, parent);
        break;
      case 'EXCLUDE':
        boolNode = figma.exclude(childNodes, parent);
        break;
      default:
        boolNode = figma.union(childNodes, parent);
    }
    if (spec.name) boolNode.name = spec.name as string;
    return boolNode;
  }

  // Regular node: create, apply properties, append
  const node = await createSingleNode(spec, parent);

  // Recurse into children (for FRAME, SECTION, etc.)
  const children = spec.children as Record<string, unknown>[] | undefined;
  if (children && children.length > 0 && 'appendChild' in node) {
    for (const childSpec of children) {
      await createTreeNode(childSpec, node as ParentNode);
    }
  }

  return node;
};
```

**Commit message:**
```
feat(plugin): add create_node/create_tree/create_component/create_from_svg handlers

Supports all 18 Figma Design node types with ordering constraints:
FILL sizing after append, font loading before text props, GROUP/BOOLEAN
children-first creation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 5: Server — create_component and create_from_svg Handlers

### 5.1 Create component handler

- [ ] Step 1: Write failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Test file:** `packages/server/test/tools/create-component.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleCreateComponent } from '@figma-agent-bridge/server/tools/create-component'

const createMockClient = (
  handler: (cmd: string, params: Record<string, unknown>) => unknown,
): FigmaClient => ({
  joinChannel: () => Promise.resolve(''),
  sendCommand: (cmd, params) =>
    Promise.resolve(handler(cmd, params ?? {})),
  disconnect: () => undefined,
  isConnected: () => true,
  currentChannel: () => 'test-ch',
})

describe('handleCreateComponent', () => {
  it('sends create_component with nodeId for promotion', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return { id: '1:42', name: 'Button', type: 'COMPONENT', key: 'key:abc' }
      }
      return null
    })

    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content[0].text).toContain('key:abc')
    expect(sentParams.nodeId).toBe('1:42')
  })

  it('sends create_component with combineAsVariants', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return {
          id: 'cs:1',
          name: 'Button Set',
          type: 'COMPONENT_SET',
          key: 'key:xyz',
        }
      }
      return null
    })

    const result = await handleCreateComponent(
      {
        nodeIds: ['1:42', '1:43'],
        combineAsVariants: true,
      },
      client,
    )

    expect(result.content[0].text).toContain('COMPONENT_SET')
    expect(sentParams.combineAsVariants).toBe(true)
    expect(sentParams.nodeIds).toEqual(['1:42', '1:43'])
  })

  it('sends create_component with slots', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return { id: '1:42', name: 'Card', type: 'COMPONENT', key: 'key:card' }
      }
      return null
    })

    await handleCreateComponent(
      { nodeId: '1:42', slots: ['Content', 'Footer'] },
      client,
    )

    expect(sentParams.slots).toEqual(['Content', 'Footer'])
  })

  it('sends create_component with componentProperties', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_component') {
        sentParams = params
        return { id: '1:42', name: 'Button', type: 'COMPONENT', key: 'key:btn' }
      }
      return null
    })

    await handleCreateComponent(
      {
        nodeId: '1:42',
        componentProperties: [
          { name: 'Show Icon', type: 'BOOLEAN', default: true },
          { name: 'Label', type: 'TEXT', default: 'Click me' },
        ],
      },
      client,
    )

    const props = sentParams.componentProperties as { name: string; type: string }[]
    expect(props).toHaveLength(2)
    expect(props[0].name).toBe('Show Icon')
    expect(props[0].type).toBe('BOOLEAN')
    expect(props[1].name).toBe('Label')
  })

  it('returns error when not connected', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

**Implementation file:** `packages/server/src/tools/create-component.ts`

```typescript
import type { FigmaClient } from '../figma-client'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const handleCreateComponent = async (
  params: {
    nodeId?: string
    nodeIds?: string[]
    combineAsVariants?: boolean
    slots?: string[]
    componentProperties?: { name: string; type: string; default: string | boolean }[]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Not connected to Figma. Use connect tool first.',
        },
      ],
    }
  }

  const result = (await client.sendCommand('create_component', {
    nodeId: params.nodeId,
    nodeIds: params.nodeIds,
    combineAsVariants: params.combineAsVariants,
    slots: params.slots,
    componentProperties: params.componentProperties,
  })) as Record<string, unknown> | null

  if (result === null) {
    return {
      content: [
        { type: 'text', text: 'Failed to create component.' },
      ],
    }
  }

  if (result.error !== undefined) {
    return {
      content: [
        { type: 'text', text: `Error: ${result.error}` },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}
```

**Run command (should pass):**
```bash
bun test packages/server/test/tools/create-component.test.ts
```

### 5.2 Create from SVG handler

**Test file:** `packages/server/test/tools/create-svg.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleCreateFromSvg } from '@figma-agent-bridge/server/tools/create-svg'

const createMockClient = (
  handler: (cmd: string, params: Record<string, unknown>) => unknown,
): FigmaClient => ({
  joinChannel: () => Promise.resolve(''),
  sendCommand: (cmd, params) =>
    Promise.resolve(handler(cmd, params ?? {})),
  disconnect: () => undefined,
  isConnected: () => true,
  currentChannel: () => 'test-ch',
})

describe('handleCreateFromSvg', () => {
  it('sends create_from_svg command', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_from_svg') {
        sentParams = params
        return {
          id: 'svg:1',
          name: 'Icon',
          type: 'FRAME',
          childCount: 2,
        }
      }
      return null
    })

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 2L2 22h20z"/></svg>'

    const result = await handleCreateFromSvg(
      { parentId: '1:2', svg, name: 'Icon' },
      client,
    )

    expect(result.content[0].text).toContain('svg:1')
    expect(sentParams.svg).toBe(svg)
    expect(sentParams.name).toBe('Icon')
    expect(sentParams.parentId).toBe('1:2')
  })

  it('sends with optional size', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_from_svg') {
        sentParams = params
        return { id: 'svg:2', name: 'Resized', type: 'FRAME', childCount: 1 }
      }
      return null
    })

    await handleCreateFromSvg(
      {
        parentId: '1:2',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
        size: [100, 100],
      },
      client,
    )

    expect(sentParams.size).toEqual([100, 100])
  })

  it('returns error when not connected', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleCreateFromSvg(
      { parentId: '1:2', svg: '<svg></svg>' },
      client,
    )

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

**Implementation file:** `packages/server/src/tools/create-svg.ts`

```typescript
import type { FigmaClient } from '../figma-client'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const handleCreateFromSvg = async (
  params: {
    parentId: string
    svg: string
    name?: string
    size?: [number, number]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Not connected to Figma. Use connect tool first.',
        },
      ],
    }
  }

  const result = (await client.sendCommand('create_from_svg', {
    parentId: params.parentId,
    svg: params.svg,
    name: params.name,
    size: params.size,
  })) as Record<string, unknown> | null

  if (result === null) {
    return {
      content: [
        { type: 'text', text: 'Failed to create from SVG.' },
      ],
    }
  }

  if (result.error !== undefined) {
    return {
      content: [
        { type: 'text', text: `Error: ${result.error}` },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}
```

**Run command (should pass):**
```bash
bun test packages/server/test/tools/create-component.test.ts packages/server/test/tools/create-svg.test.ts
```

**Commit message:**
```
feat(server): add create_component and create_from_svg handlers

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 6: Server Tool Registration

### 6.1 Register 4 new tools in index.ts

- [ ] Step 1: Write failing test (typecheck)
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Implementation** — update `packages/server/src/index.ts`:

Add imports:
```typescript
import {
  createNodeParamsSchema,
  createTreeParamsSchema,
  createComponentParamsSchema,
  createFromSvgParamsSchema,
} from '@figma-agent-bridge/shared'
import {
  handleCreateNode,
  handleCreateTree,
} from './tools/create'
import { handleCreateComponent } from './tools/create-component'
import { handleCreateFromSvg } from './tools/create-svg'
```

Add tool registrations (after existing tools):
```typescript
server.tool(
  'create_node',
  createNodeParamsSchema.shape,
  async params =>
    handleCreateNode(
      {
        parentId: params.parentId,
        node: params.node,
      },
      client,
    ),
)

server.tool(
  'create_tree',
  createTreeParamsSchema.shape,
  async params =>
    handleCreateTree(
      {
        parentId: params.parentId,
        node: params.node,
      },
      client,
    ),
)

server.tool(
  'create_component',
  createComponentParamsSchema.shape,
  async params =>
    handleCreateComponent(
      {
        nodeId: params.nodeId,
        nodeIds: params.nodeIds,
        combineAsVariants: params.combineAsVariants,
        slots: params.slots,
        componentProperties: params.componentProperties,
      },
      client,
    ),
)

server.tool(
  'create_from_svg',
  createFromSvgParamsSchema.shape,
  async params =>
    handleCreateFromSvg(
      {
        parentId: params.parentId,
        svg: params.svg,
        name: params.name,
        size: params.size,
      },
      client,
    ),
)
```

**Run command:**
```bash
bun run typecheck
```

**Expected output:**
```
No errors found.
```

**Commit message:**
```
feat(server): register create_node, create_tree, create_component, create_from_svg tools

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 7: Mock Plugin Update

### 7.1 Add create command handlers to mock plugin

- [ ] Step 1: Update mock plugin with create handlers (code shown in Task 4)
- [ ] Step 2: Run existing tests to verify no regressions
- [ ] Step 3: Commit

**Run command:**
```bash
bun test packages/server/test/
```

**Expected output:**
```
All tests passed.
```

**Commit message:**
```
test(server): add create command handlers to mock plugin

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 8: E2E Integration Tests

### 8.1 E2E create tools roundtrip

- [ ] Step 1: Write failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code (mock plugin handlers from Task 7)
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Test file:** `packages/server/test/integration/e2e-create.test.ts`

```typescript
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleConnect,
} from '@figma-agent-bridge/server/tools/session'
import {
  handleCreateNode,
  handleCreateTree,
} from '@figma-agent-bridge/server/tools/create'
import { handleCreateComponent } from '@figma-agent-bridge/server/tools/create-component'
import { handleCreateFromSvg } from '@figma-agent-bridge/server/tools/create-svg'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3099
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-create-test'

describe('M3 create tools e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null = null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)

    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Create Test Doc',
      pageName: 'Main Page',
    })

    await plugin.start()
    await handleConnect({ channel: TEST_CHANNEL }, client)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('create_node creates a RECTANGLE', async () => {
    const result = await handleCreateNode(
      {
        parentId: 'page:1',
        node: {
          type: 'RECTANGLE',
          name: 'Test Rect',
          size: [200, 100],
          fills: ['#3B82F6'],
          radius: 8,
        },
      },
      client,
    )

    expect(result.content).toHaveLength(1)
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('RECTANGLE')
    expect(data.name).toBe('Test Rect')
    expect(data.id).toBeDefined()
  })

  it('create_node creates a TEXT node', async () => {
    const result = await handleCreateNode(
      {
        parentId: 'page:1',
        node: {
          type: 'TEXT',
          name: 'Title',
          size: [300, 32],
          text: {
            content: 'Hello World',
            font: 'Inter/Bold/24',
            color: '#000000',
          },
        },
      },
      client,
    )

    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('TEXT')
  })

  it('create_tree creates a frame with children', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        node: {
          type: 'FRAME',
          name: 'Card',
          size: [320, 200],
          layout: {
            mode: 'V',
            spacing: 12,
            padding: [16, 16, 16, 16],
            align: ['MIN', 'MIN'],
          },
          fills: ['#FFFFFF'],
          effects: ['shadow(0,4,8,#00000040)'],
          children: [
            {
              type: 'TEXT',
              name: 'Title',
              size: [288, 24],
              text: {
                content: 'Card Title',
                font: 'Inter/SemiBold/18',
                color: '#1A1A1A',
              },
            },
            {
              type: 'RECTANGLE',
              name: 'Divider',
              size: [288, 1],
              fills: ['#E5E5E5'],
            },
          ],
        },
      },
      client,
    )

    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('FRAME')
    expect(data.name).toBe('Card')
    expect(data.totalNodes).toBe(3) // Card + Title + Divider
  })

  it('create_component promotes a node', async () => {
    const result = await handleCreateComponent(
      { nodeId: '1:42' },
      client,
    )

    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT')
    expect(data.key).toBeDefined()
  })

  it('create_component combines as variants', async () => {
    const result = await handleCreateComponent(
      {
        nodeIds: ['1:42', '1:43'],
        combineAsVariants: true,
      },
      client,
    )

    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('COMPONENT_SET')
  })

  it('create_from_svg creates a frame from SVG', async () => {
    const result = await handleCreateFromSvg(
      {
        parentId: 'page:1',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 2L2 22h20z"/></svg>',
        name: 'Triangle',
      },
      client,
    )

    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('FRAME')
    expect(data.name).toBe('Triangle')
    expect(data.childCount).toBeGreaterThan(0)
  })

  it('create_tree with gradient fills', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        node: {
          type: 'RECTANGLE',
          name: 'Gradient BG',
          size: [400, 300],
          fills: ['linear-gradient(135deg, #FF6B6B 0%, #4ECDC4 100%)'],
        },
      },
      client,
    )

    const data = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(data.type).toBe('RECTANGLE')
  })

  it('create_node returns error when not connected', async () => {
    client.disconnect()

    const result = await handleCreateNode(
      {
        parentId: 'page:1',
        node: { type: 'FRAME', name: 'Test', size: [100, 100] },
      },
      client,
    )

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

**Run command:**
```bash
bun test packages/server/test/integration/e2e-create.test.ts
```

**Expected output:**
```
 PASS  packages/server/test/integration/e2e-create.test.ts
```

**Commit message:**
```
test(server): add E2E integration tests for M3 create tools

Tests create_node, create_tree, create_component, and create_from_svg
through the full relay pipeline with mock plugin.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 9: Parser Fixes for Round-Trip

Fix `get_node` output gaps identified in the M3 checklist so that create_node receives complete data.

### 9.1 Add shadow spread to effect expression

- [ ] Step 1: Write failing test
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Review test
- [ ] Step 4: Implement minimal code
- [ ] Step 5: Run test to verify it passes
- [ ] Step 6: Commit

**Test file:** `packages/server/test/parser-roundtrip.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { parseNode } from '@figma-agent-bridge/server/parser'

describe('parser round-trip fixes', () => {
  it('includes shadow spread in effect expression', () => {
    const raw = {
      id: '1:1',
      name: 'Box',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [],
      effects: [
        {
          type: 'DROP_SHADOW',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 2,
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.effects).toBeDefined()
    expect(parsed.effects![0]).toBe('shadow(0,4,8,#00000040,2)')
  })

  it('omits spread from expression when spread is 0', () => {
    const raw = {
      id: '1:2',
      name: 'Box2',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [],
      effects: [
        {
          type: 'DROP_SHADOW',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 0,
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.effects![0]).toBe('shadow(0,4,8,#00000040)')
  })

  it('includes strokeAlign in parsed output', () => {
    const raw = {
      id: '1:3',
      name: 'Bordered',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }],
      strokes: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } }],
      strokeWeight: 2,
      strokeAlign: 'INSIDE',
      dashPattern: [4, 4],
    }

    const parsed = parseNode(raw)
    expect(parsed.strokeWeight).toBe(2)
    expect(parsed.strokeAlign).toBe('INSIDE')
    expect(parsed.strokeDash).toEqual([4, 4])
  })

  it('includes per-corner radius', () => {
    const raw = {
      id: '1:4',
      name: 'Rounded',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [],
      cornerRadius: null, // mixed
      rectangleCornerRadii: [8, 8, 0, 0],
    }

    const parsed = parseNode(raw)
    expect(parsed.radius).toEqual([8, 8, 0, 0])
  })

  it('includes text lineHeight and letterSpacing', () => {
    const raw = {
      id: '1:5',
      name: 'Styled Text',
      type: 'TEXT',
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 48 },
      fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } }],
      characters: 'Hello',
      style: {
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        fontSize: 16,
        textAlignHorizontal: 'LEFT',
        lineHeightPx: 24,
        lineHeightUnit: 'PIXELS',
        letterSpacing: 0.5,
      },
      textAutoResize: 'HEIGHT',
    }

    const parsed = parseNode(raw)
    expect(parsed.text).toBeDefined()
    expect(parsed.text!.lineHeight).toBe('24px')
    expect(parsed.text!.letterSpacing).toBe('0.5px')
    expect(parsed.textAutoResize).toBe('HEIGHT')
  })

  it('includes text decoration and case', () => {
    const raw = {
      id: '1:6',
      name: 'Decorated',
      type: 'TEXT',
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 24 },
      fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } }],
      characters: 'Hello',
      style: {
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        fontSize: 16,
        textAlignHorizontal: 'LEFT',
        textDecoration: 'UNDERLINE',
        textCase: 'UPPER',
      },
    }

    const parsed = parseNode(raw)
    expect(parsed.text!.decoration).toBe('UNDERLINE')
    expect(parsed.text!.case).toBe('UPPER')
  })

  it('includes layoutPositioning', () => {
    const raw = {
      id: '1:7',
      name: 'Badge',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
      fills: [],
      layoutPositioning: 'ABSOLUTE',
    }

    const parsed = parseNode(raw)
    expect(parsed.layoutPositioning).toBe('ABSOLUTE')
  })

  it('includes gradient fills as expressions', () => {
    const raw = {
      id: '1:8',
      name: 'Gradient',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          visible: true,
          gradientTransform: [[0, -1, 1], [1, 0, 0]],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.fills).toBeDefined()
    expect(parsed.fills![0]).toMatch(/^linear-gradient\(/)
    expect(parsed.fills![0]).toContain('#FF0000')
    expect(parsed.fills![0]).toContain('#0000FF')
  })
})
```

**Run command:**
```bash
bun test packages/server/test/parser-roundtrip.test.ts
```

**Expected output (some will fail):** Tests for spread, strokeAlign, strokeDash, per-corner radius, lineHeight, letterSpacing, decoration, case, layoutPositioning, textAutoResize, and gradient fills will fail because the parser doesn't include these yet.

**Implementation changes to `packages/server/src/parser.ts`:**

1. **Update `parseEffects`** to include spread:

```typescript
// In parseEffects function, update the shadow branch:
if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
  const colorHex = e.color !== null && e.color !== undefined ? rgbaToHex(e.color) : '?'
  const ox = e.offset !== null && e.offset !== undefined ? e.offset.x : 0
  const oy = e.offset !== null && e.offset !== undefined ? e.offset.y : 0
  const prefix = e.type === 'DROP_SHADOW' ? 'shadow' : 'inner-shadow'
  const spreadStr = e.spread !== undefined && e.spread !== 0 ? `,${e.spread}` : ''
  return `${prefix}(${ox},${oy},${e.radius ?? 0},${colorHex}${spreadStr})`
}
```

2. **Update `parseFills`** to handle gradients:

```typescript
const parseFills = (fills: FigmaFill[]): string[] | undefined => {
  const result = fills
    .filter(f => f.visible !== false)
    .map(f => {
      if (f.type === 'SOLID' && f.color !== null && f.color !== undefined) {
        return rgbaToHex(f.color as RGBA)
      }
      if (f.type === 'IMAGE') return 'image'
      if (f.gradientStops !== undefined) {
        const stops = f.gradientStops
          .map((s: { position: number; color: RGBA }) =>
            `${rgbaToHex(s.color)} ${Math.round(s.position * 100)}%`,
          )
          .join(', ')
        if (f.type === 'GRADIENT_LINEAR') {
          const transform = f.gradientTransform
          const angle = transform !== undefined
            ? Math.round((Math.atan2(transform[0][1], transform[0][0]) * 180) / Math.PI)
            : 0
          return `linear-gradient(${angle}deg, ${stops})`
        }
        if (f.type === 'GRADIENT_RADIAL') return `radial-gradient(${stops})`
        if (f.type === 'GRADIENT_ANGULAR') return `angular-gradient(${stops})`
        if (f.type === 'GRADIENT_DIAMOND') return `diamond-gradient(${stops})`
      }
      return f.type.toLowerCase()
    })
    .filter(Boolean)

  return result.length > 0 ? result : undefined
}
```

Update the `FigmaFill` type:
```typescript
type FigmaFill = {
  type: string
  visible?: boolean
  color?: RGBA
  gradientStops?: { position: number; color: RGBA }[]
  gradientTransform?: number[][]
}
```

3. **Update `parseNode`** to include new properties:

```typescript
// After existing radius parsing, add per-corner:
const perCornerRadii = raw.rectangleCornerRadii as [number, number, number, number] | undefined
const radiusValue = radius !== undefined && radius !== null && radius !== 0
  ? radius
  : perCornerRadii !== undefined
    ? perCornerRadii
    : undefined

// Add strokeWeight, strokeAlign, strokeDash:
const strokeWeight = raw.strokeWeight as number | undefined
const strokeAlign = raw.strokeAlign as string | undefined
const dashPattern = raw.dashPattern as number[] | undefined

// Add layoutPositioning:
const layoutPositioning = raw.layoutPositioning as string | undefined

// Add textAutoResize:
const textAutoResize = raw.textAutoResize as string | undefined

// In the text parsing section, add lineHeight, letterSpacing, decoration, case:
const text = textContent !== null && textContent !== undefined && textStyle !== null && textStyle !== undefined
  ? {
      content: textContent,
      ...parseTextStyle(textStyle, (raw.fills ?? []) as FigmaFill[]),
      ...(textStyle.lineHeightUnit === 'PIXELS' && textStyle.lineHeightPx
        ? { lineHeight: `${textStyle.lineHeightPx}px` }
        : textStyle.lineHeightUnit === 'PERCENT' && textStyle.lineHeightPercent
          ? { lineHeight: `${textStyle.lineHeightPercent}%` }
          : {}),
      ...(textStyle.letterSpacing !== undefined && textStyle.letterSpacing !== 0
        ? { letterSpacing: `${textStyle.letterSpacing}px` }
        : {}),
      ...(textStyle.textDecoration !== undefined && textStyle.textDecoration !== 'NONE'
        ? { decoration: textStyle.textDecoration }
        : {}),
      ...(textStyle.textCase !== undefined && textStyle.textCase !== 'ORIGINAL'
        ? { case: textStyle.textCase }
        : {}),
    }
  : undefined
```

Add these to the result:
```typescript
if (strokeWeight !== undefined && strokeWeight > 0) result.strokeWeight = strokeWeight
if (strokeAlign !== undefined && strokeAlign !== 'CENTER') result.strokeAlign = strokeAlign
if (dashPattern !== undefined && dashPattern.length > 0) result.strokeDash = dashPattern
if (layoutPositioning !== undefined && layoutPositioning !== 'AUTO') result.layoutPositioning = layoutPositioning
if (textAutoResize !== undefined && textAutoResize !== 'NONE') result.textAutoResize = textAutoResize
```

Update `ParsedNode` type in `packages/shared/src/types.ts` to include the new fields:
```typescript
export type ParsedNode = {
  // ... existing fields ...
  strokeWeight?: number
  strokeAlign?: string
  strokeDash?: number[]
  layoutPositioning?: string
  textAutoResize?: string
}
```

**Run command (should pass):**
```bash
bun test packages/server/test/parser-roundtrip.test.ts
```

**Commit message:**
```
fix(parser): add missing properties for round-trip fidelity

Adds shadow spread, strokeAlign, strokeDash, per-corner radius,
lineHeight, letterSpacing, text decoration/case, layoutPositioning,
textAutoResize, and gradient fill expressions to parser output.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Task 10: Full Test Suite Verification

### 10.1 Run all tests and typecheck

- [ ] Step 1: Run full test suite
- [ ] Step 2: Run typecheck
- [ ] Step 3: Fix any failures
- [ ] Step 4: Commit if fixes needed

**Run commands:**
```bash
bun test packages/server/test/
bun run typecheck
```

**Expected output:**
```
All tests passed.
No type errors found.
```

---

## Task Summary

| Task | Files Created | Files Modified | Tests |
|------|--------------|----------------|-------|
| 1. Schemas & Types | `create-schemas.ts`, `create-types.ts` | `shared/index.ts` | `create-schemas.test.ts` |
| 2. Expression Parser | `expression-parser.ts` | — | `expression-parser.test.ts` |
| 3. Server Handlers | `tools/create.ts` | — | `tools/create.test.ts` |
| 4. Plugin Handlers | — | `code.ts` | (via e2e) |
| 5. Component/SVG | `tools/create-component.ts`, `tools/create-svg.ts` | — | `create-component.test.ts`, `create-svg.test.ts` |
| 6. Tool Registration | — | `server/index.ts` | (typecheck) |
| 7. Mock Plugin | — | `mock-plugin.ts` | (existing tests) |
| 8. E2E Tests | `e2e-create.test.ts` | — | `e2e-create.test.ts` |
| 9. Parser Fixes | — | `parser.ts`, `types.ts` | `parser-roundtrip.test.ts` |
| 10. Verification | — | — | Full suite |

## Ordering Constraints Handled

The plugin implementation handles all ordering constraints from the M3 checklist:

1. **FILL sizing after appendChild** — `applyPostAppendProperties()` runs after `parent.appendChild(node)`
2. **layoutPositioning: ABSOLUTE after appendChild** — same as above
3. **loadFontAsync before text properties** — `applyTextProperties()` calls `figma.loadFontAsync()` first
4. **textAutoResize before resize** — set before `node.characters`
5. **GROUP: children first, then group** — `createTreeNode()` creates children, then calls `figma.group()`
6. **BOOLEAN_OPERATION: children first, then combine** — creates children, then calls `figma.union/subtract/intersect/exclude()`
7. **COMPONENT → INSTANCE for clone references** — detected in `createTreeNode()` when `{ id }` references a COMPONENT
8. **TRANSFORM_GROUP: children first, then wrap** — same pattern as GROUP with optional transform modifiers
9. **TEXT_PATH: requires existing VectorNode** — `figma.createTextPath(vectorNode, startSegment, startPosition)`
10. **IMAGE fill: async fetch** — `figma.createImageAsync(url)` before applying as ImagePaint
11. **Style IDs: resolved server-side** — `style(name)` → `styleId` lookup before sending to plugin
12. **SLOT: created as FRAME, promoted in create_component** — `component.createSlot(childName)` after promotion

## Smart Clone Logic

In `createTreeNode()`:
- `{ id }` where node is COMPONENT → `component.createInstance()`
- `{ id }` where node is INSTANCE → `instance.mainComponent.createInstance()`
- `{ id }` for any other type → `node.clone()`

## Additional Node Types Supported

- **TEXT_PATH** — Text along a vector path, created via `figma.createTextPath(vectorNode, startSegment, startPosition)`
- **TRANSFORM_GROUP** — Like GROUP but preserves transform modifiers (rotation, scale, skew)
- **SLOT** — Created as FRAME in `create_node`/`create_tree`; promoted to SLOT via `component.createSlot(childName)` in `create_component`

## Component Properties

The `create_component` tool supports:
- **slots** — Array of child names to promote to SLOT after component creation
- **componentProperties** — Array of `{ name, type, default }` to add via `component.addComponentProperty()`
  - Types: `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`, `SLOT`
  - For `INSTANCE_SWAP`, `default` must be a valid component key

## Style Resolution Pipeline

Style resolution is server-side:
1. Expression parser extracts `style(name)` prefix from fill/stroke/effect/font expressions
2. Server handler looks up `styleName` in the style cache → resolves to `styleId`
3. Resolved `fillStyleId`, `strokeStyleId`, `effectStyleId`, `textStyleId` are attached to the node spec
4. Plugin applies `node.fillStyleId = id` etc. when IDs are present

## Image Fill Pipeline

Image fills are handled in the expression parser and plugin:
1. `image(url)` / `image(url,scaleMode)` — Expression parser produces `{ type: 'IMAGE', imageUrl, scaleMode }`
2. `image-hash(hash)` — Expression parser produces `{ type: 'IMAGE', imageHash }`
3. Plugin: `imageUrl` → `figma.createImageAsync(url)` → get hash → apply as `ImagePaint`
4. Plugin: `imageHash` → apply directly as `ImagePaint` without fetching
