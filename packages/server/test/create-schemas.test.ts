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

  it('rejects empty object (requires nodeId or nodeIds)', () => {
    const result = createComponentParamsSchema.safeParse({})
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
