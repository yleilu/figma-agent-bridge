import { describe, expect, it } from 'bun:test'
import type { ParsedNode } from '@figma-agent-bridge/shared/types'
import {
  parseNode,
  computeSummary,
  toInspectYaml,
  toInspectTree,
  toInspectTreeMulti,
  toFullJson,
  toPageLayoutYaml,
  toPageLayoutTree,
  toStylesYaml,
  toStylesTree,
  toComponentsYaml,
  toComponentsTree,
} from '@figma-agent-bridge/server/parser'
import cardFixture from './fixtures/card-node-raw.json'
import pageLayoutFixture from './fixtures/page-layout-raw.json'
import stylesFixture from './fixtures/styles-raw.json'
import componentsFixture from './fixtures/components-raw.json'

// --- Task 2: parseNode, computeSummary, toInspectYaml ---

describe('parseNode', () => {
  it('transforms raw Figma node to ParsedNode', () => {
    const parsed = parseNode(cardFixture)
    expect(parsed.id).toBe('1:42')
    expect(parsed.name).toBe('Card')
    expect(parsed.type).toBe('FRAME')
    expect(parsed.size).toEqual([320, 200])
    expect(parsed.fills).toEqual(['#FFFFFF'])
    expect(parsed.radius).toBe(8)
    expect(parsed.effects).toEqual([
      'shadow(0,4,8,#00000040)',
    ])
    expect(parsed.layout).toEqual({
      mode: 'V',
      spacing: 12,
      padding: [16, 16, 16, 16],
      align: ['MIN', 'MIN'],
    })
  })

  it('parses text node with compact font', () => {
    const parsed = parseNode(cardFixture)
    const children = parsed.children as ParsedNode[]
    const title = children[0]
    expect(title.type).toBe('TEXT')
    expect(title.text).toEqual({
      content: 'Card Title',
      font: 'Inter/SemiBold/18',
      align: 'LEFT',
      color: '#1A1A1A',
    })
    expect(title.sizing).toEqual(['FILL', 'HUG'])
  })

  it('parses instance node with component info', () => {
    const parsed = parseNode(cardFixture)
    const button = (parsed.children as ParsedNode[])[2]
    expect(button.type).toBe('INSTANCE')
    expect(button.component).toEqual({
      name: 'Action Button',
      id: 'C:abc123',
      variant: { Size: 'Medium', Style: 'Primary' },
    })
  })

  it('omits empty arrays and default values', () => {
    const parsed = parseNode(cardFixture)
    expect(parsed.strokes).toBeUndefined()
    expect(parsed.opacity).toBeUndefined()
    expect(parsed.position).toBeUndefined()
  })

  it('converts RGBA to hex correctly', () => {
    const parsed = parseNode(cardFixture)
    const body = (parsed.children as ParsedNode[])[1]
    const textColor = (
      body.text as NonNullable<ParsedNode['text']>
    ).color
    expect(textColor).toBe('#666666')
  })
})

describe('computeSummary', () => {
  it('counts layers and depth', () => {
    const parsed = parseNode(cardFixture)
    const summary = computeSummary(parsed)
    expect(summary.totalLayers).toBe(4)
    expect(summary.maxDepth).toBe(1)
    expect(summary.typeBreakdown).toEqual({
      FRAME: 1,
      TEXT: 2,
      INSTANCE: 1,
    })
  })

  it('lists unique component names', () => {
    const parsed = parseNode(cardFixture)
    const summary = computeSummary(parsed)
    expect(summary.componentNames).toEqual([
      'Action Button',
    ])
  })

  it('extracts root layout mode', () => {
    const parsed = parseNode(cardFixture)
    const summary = computeSummary(parsed)
    expect(summary.layoutMode).toBe('V')
    expect(summary.rootFill).toBe('#FFFFFF')
  })
})

describe('toInspectYaml', () => {
  it('produces YAML with summary comments', () => {
    const parsed = parseNode(cardFixture)
    const yaml = toInspectYaml(parsed)
    expect(yaml).toContain('# Card [1:42]')
    expect(yaml).toContain('4 layers')
    expect(yaml).toContain('auto-layout: V')
    expect(yaml).toContain('320×200')
    expect(yaml).toContain('id: 1:42')
    expect(yaml).toContain('font: Inter/SemiBold/18')
  })

  it('omits undefined fields in YAML', () => {
    const parsed = parseNode(cardFixture)
    const yaml = toInspectYaml(parsed)
    expect(yaml).not.toContain('strokes:')
    expect(yaml).not.toContain('opacity:')
    expect(yaml).not.toContain('position:')
  })
})

// --- toInspectTree ---

describe('toInspectTree', () => {
  it('includes summary header with layers, depth, size, layout', () => {
    const parsed = parseNode(cardFixture)
    const tree = toInspectTree(parsed)
    expect(tree).toContain('# Card [1:42]')
    expect(tree).toContain('4 layers')
    expect(tree).toContain('depth 1')
    expect(tree).toContain('320×200')
    expect(tree).toContain('auto-layout: V')
  })

  it('renders root node as first YAML list item with layout direction', () => {
    const parsed = parseNode(cardFixture)
    const tree = toInspectTree(parsed)
    expect(tree).toContain('- Card [1:42] FRAME 320×200 V:')
  })

  it('renders children indented under parent', () => {
    const parsed = parseNode(cardFixture)
    const tree = toInspectTree(parsed)
    expect(tree).toContain(
      '  - Title [1:43] TEXT 288×24 "Card Title"',
    )
    expect(tree).toContain(
      '  - Body [1:44] TEXT 288×48 "Description text here..."',
    )
  })

  it('shows INSTANCE<component.name> for component instances', () => {
    const parsed = parseNode(cardFixture)
    const tree = toInspectTree(parsed)
    expect(tree).toContain(
      '  - Action Button [1:45] INSTANCE<Action Button> 100×40',
    )
  })

  it('leaf nodes have no trailing colon', () => {
    const parsed = parseNode(cardFixture)
    const tree = toInspectTree(parsed)
    const titleLine = tree
      .split('\n')
      .find(l => l.includes('Title [1:43]'))
    expect(titleLine).not.toMatch(/:$/)
  })

  it('omits layout direction for frames without auto-layout', () => {
    const noLayoutFrame: ParsedNode = {
      id: '1:50',
      name: 'Static Frame',
      type: 'FRAME',
      size: [400, 300],
      children: [
        {
          id: '1:51',
          name: 'Child',
          type: 'RECTANGLE',
          size: [100, 100],
        },
      ],
    }
    const tree = toInspectTree(noLayoutFrame)
    expect(tree).toContain(
      '- Static Frame [1:50] FRAME 400×300:',
    )
    expect(tree).not.toContain('H:')
    expect(tree).not.toContain('V:')
  })

  it('truncates long text content to 50 chars', () => {
    const longTextNode: ParsedNode = {
      id: '1:99',
      name: 'Long',
      type: 'TEXT',
      size: [200, 24],
      text: {
        content: 'A'.repeat(80),
        font: 'Inter/Regular/14',
      },
    }
    const wrapper: ParsedNode = {
      id: '1:98',
      name: 'Wrapper',
      type: 'FRAME',
      size: [200, 100],
      children: [longTextNode],
    }
    const tree = toInspectTree(wrapper)
    expect(tree).toContain('"' + 'A'.repeat(50) + '..."')
  })

  it('handles deeply nested indentation correctly', () => {
    const deep: ParsedNode = {
      id: '1:1',
      name: 'L0',
      type: 'FRAME',
      size: [100, 100],
      children: [
        {
          id: '1:2',
          name: 'L1',
          type: 'FRAME',
          size: [80, 80],
          children: [
            {
              id: '1:3',
              name: 'L2',
              type: 'RECTANGLE',
              size: [60, 60],
            },
          ],
        },
      ],
    }
    const tree = toInspectTree(deep)
    expect(tree).toContain('- L0 [1:1] FRAME 100×100:')
    expect(tree).toContain('  - L1 [1:2] FRAME 80×80:')
    expect(tree).toContain('    - L2 [1:3] RECTANGLE 60×60')
  })
})

// --- Task 3: toFullJson ---

describe('toFullJson', () => {
  it('returns full Figma data at default depth 3', () => {
    const result = toFullJson(cardFixture)
    const json = JSON.parse(result)
    expect(json.id).toBe('1:42')
    expect(json.absoluteBoundingBox).toBeDefined()
    expect(json.layoutMode).toBe('VERTICAL')
    expect(json.fills[0].color).toBeDefined()
    expect(json.children).toHaveLength(3)
  })

  it('filters out boundVariables, imageRef, relativeTransform', () => {
    const result = toFullJson(cardFixture)
    const json = JSON.parse(result)
    expect(json.fills[0].boundVariables).toBeUndefined()
    expect(json.relativeTransform).toBeUndefined()
    expect(json.exportSettings).toBeUndefined()
    expect(json.isMask).toBeUndefined()
  })

  it('depth 0 = root node with child stubs only', () => {
    const result = toFullJson(cardFixture, 0)
    const json = JSON.parse(result)
    expect(json.children).toHaveLength(3)
    expect(json.children[0]).toEqual({
      id: '1:43',
      name: 'Title',
      type: 'TEXT',
    })
  })

  it('depth 1 = root + full first-level children, grandchild stubs', () => {
    const result = toFullJson(cardFixture, 1)
    const json = JSON.parse(result)
    expect(json.children[0].characters).toBe('Card Title')
    expect(json.children[0].style).toBeDefined()
  })

  it('allows unlimited depth with -1', () => {
    const result = toFullJson(cardFixture, -1)
    const json = JSON.parse(result)
    expect(json.children[0].characters).toBe('Card Title')
  })
})

// --- Task 4: toPageLayoutYaml ---

describe('toPageLayoutYaml', () => {
  it('produces YAML with summary and frame list', () => {
    const yaml = toPageLayoutYaml(pageLayoutFixture)
    expect(yaml).toContain('# Homepage')
    expect(yaml).toContain('3 top-level frames')
    expect(yaml).toContain('name: Header')
    expect(yaml).toContain('size:\n')
    expect(yaml).toContain('children_count: 8')
  })

  it('includes canvas bounding box in summary', () => {
    const yaml = toPageLayoutYaml(pageLayoutFixture)
    expect(yaml).toContain('canvas: 1440×1080')
  })
})

// --- Task 5: toStylesYaml, toComponentsYaml ---

describe('toStylesYaml', () => {
  it('produces YAML grouped by type with summary', () => {
    const yaml = toStylesYaml(stylesFixture)
    expect(yaml).toContain(
      '# 5 styles: 2 paint, 2 text, 1 effect',
    )
    expect(yaml).toContain('name: Colors/Primary/500')
    expect(yaml).toContain('color: "#3B82F6"')
    expect(yaml).toContain('font: Inter/Bold/32')
  })

  it('omits empty style groups', () => {
    const yaml = toStylesYaml(stylesFixture)
    expect(yaml).not.toContain('grid:')
  })
})

describe('toComponentsYaml', () => {
  it('produces YAML with local and remote sections', () => {
    const yaml = toComponentsYaml(componentsFixture)
    expect(yaml).toContain(
      '# 2 local components, 1 remote in use',
    )
    expect(yaml).toContain('name: Button')
  })

  it('includes remote components from libraries', () => {
    const yaml = toComponentsYaml(componentsFixture)
    expect(yaml).toContain('remote_in_use:')
    expect(yaml).toContain('name: Input')
    expect(yaml).toContain('library: Design System v2')
  })
})

// --- Task 1: toInspectTreeMulti ---

describe('toInspectTreeMulti', () => {
  it('shows "N selected" header for multiple nodes', () => {
    const nodes: ParsedNode[] = [
      {
        id: '1:1',
        name: 'A',
        type: 'FRAME',
        size: [100, 100],
      },
      {
        id: '1:2',
        name: 'B',
        type: 'TEXT',
        size: [200, 24],
        text: {
          content: 'Hello',
          font: 'Inter/Regular/16',
        },
      },
    ]
    const tree = toInspectTreeMulti(nodes)
    expect(tree).toContain('# 2 selected')
    expect(tree).toContain('2 layers total')
  })

  it('shows aggregate type breakdown', () => {
    const nodes: ParsedNode[] = [
      {
        id: '1:1',
        name: 'A',
        type: 'FRAME',
        size: [100, 100],
        children: [
          {
            id: '1:3',
            name: 'C',
            type: 'TEXT',
            size: [80, 24],
            text: {
              content: 'Hi',
              font: 'Inter/Regular/16',
            },
          },
        ],
      },
      {
        id: '1:2',
        name: 'B',
        type: 'RECTANGLE',
        size: [50, 50],
      },
    ]
    const tree = toInspectTreeMulti(nodes)
    expect(tree).toContain(
      'types: 1 FRAME, 1 TEXT, 1 RECTANGLE',
    )
  })

  it('renders each selected node as root-level tree item', () => {
    const nodes: ParsedNode[] = [
      {
        id: '1:1',
        name: 'A',
        type: 'FRAME',
        size: [100, 100],
        children: [
          {
            id: '1:3',
            name: 'C',
            type: 'RECTANGLE',
            size: [50, 50],
          },
        ],
      },
      {
        id: '1:2',
        name: 'B',
        type: 'TEXT',
        size: [200, 24],
        text: {
          content: 'Hello',
          font: 'Inter/Regular/16',
        },
      },
    ]
    const tree = toInspectTreeMulti(nodes)
    expect(tree).toContain('- A [1:1] FRAME 100×100:')
    expect(tree).toContain('  - C [1:3] RECTANGLE 50×50')
    expect(tree).toContain('- B [1:2] TEXT 200×24 "Hello"')
  })

  it('aggregates component names across all selected nodes', () => {
    const nodes: ParsedNode[] = [
      {
        id: '1:1',
        name: 'Btn',
        type: 'INSTANCE',
        size: [100, 40],
        component: { name: 'Button', id: 'C:1' },
      },
      {
        id: '1:2',
        name: 'Av',
        type: 'INSTANCE',
        size: [48, 48],
        component: { name: 'Avatar', id: 'C:2' },
      },
    ]
    const tree = toInspectTreeMulti(nodes)
    expect(tree).toContain('components: Button, Avatar')
  })
})

// --- Task 2: toPageLayoutTree ---

describe('toPageLayoutTree', () => {
  it('includes page name and item count in header', () => {
    const tree = toPageLayoutTree(pageLayoutFixture)
    expect(tree).toContain('# Homepage')
    expect(tree).toContain('3 items')
  })

  it('includes canvas dimensions in header', () => {
    const tree = toPageLayoutTree(pageLayoutFixture)
    expect(tree).toContain('canvas: 1440×1080')
  })

  it('includes type breakdown in header', () => {
    const tree = toPageLayoutTree(pageLayoutFixture)
    expect(tree).toContain('types:')
    expect(tree).toContain('FRAME')
  })

  it('renders each frame as one line with type, size, and position', () => {
    const tree = toPageLayoutTree(pageLayoutFixture)
    expect(tree).toContain(
      '- Header [2:1] FRAME 1440×80 @ 0,0',
    )
    expect(tree).toContain(
      '- Hero [2:15] FRAME 1440×600 @ 0,80',
    )
    expect(tree).toContain(
      '- Features [2:42] FRAME 1440×400 @ 0,680',
    )
  })

  it('does not include children count', () => {
    const tree = toPageLayoutTree(pageLayoutFixture)
    expect(tree).not.toContain('children')
  })
})

// --- Task 3: toStylesTree ---

describe('toStylesTree', () => {
  // --- Header ---
  it('includes count by type in header', () => {
    const tree = toStylesTree(stylesFixture)
    expect(tree).toContain(
      '# 5 styles: 2 paint, 2 text, 1 effect',
    )
  })

  it('omits zero-count types from header', () => {
    const tree = toStylesTree(stylesFixture)
    expect(tree).not.toContain('grid')
  })

  // --- Paint: solid colors ---
  it('renders solid color as #RRGGBB', () => {
    const tree = toStylesTree(stylesFixture)
    expect(tree).toContain(
      '- Colors/Primary/500 [S:abc123] paint #3B82F6',
    )
  })

  it('renders solid color with alpha as #RRGGBBAA', () => {
    const fixture = {
      paint: [
        {
          id: 'S:a1',
          name: 'Overlay',
          paints: [
            {
              type: 'SOLID',
              color: { r: 0, g: 0, b: 0, a: 0.5 },
            },
          ],
        },
      ],
      text: [],
      effect: [],
      grid: [],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain('] paint #00000080')
  })

  // --- Paint: gradients ---
  it('renders linear gradient with angle and stop positions', () => {
    const fixture = {
      paint: [
        {
          id: 'S:g1',
          name: 'Gradient/Linear',
          paints: [
            {
              type: 'GRADIENT_LINEAR',
              gradientStops: [
                {
                  position: 0,
                  color: { r: 1, g: 0, b: 0, a: 1 },
                },
                {
                  position: 0.5,
                  color: { r: 0, g: 1, b: 0, a: 1 },
                },
                {
                  position: 1,
                  color: { r: 0, g: 0, b: 1, a: 1 },
                },
              ],
              gradientTransform: [
                [0.707, 0.707, 0],
                [-0.707, 0.707, 0],
              ],
            },
          ],
        },
      ],
      text: [],
      effect: [],
      grid: [],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toMatch(
      /- Gradient\/Linear \[S:g1\] paint linear-gradient\(\d+deg, #FF0000 0%, #00FF00 50%, #0000FF 100%\)/,
    )
  })

  it('renders radial gradient with stop positions', () => {
    const fixture = {
      paint: [
        {
          id: 'S:g2',
          name: 'Gradient/Radial',
          paints: [
            {
              type: 'GRADIENT_RADIAL',
              gradientStops: [
                {
                  position: 0,
                  color: { r: 1, g: 1, b: 1, a: 1 },
                },
                {
                  position: 1,
                  color: { r: 0, g: 0, b: 0, a: 0 },
                },
              ],
            },
          ],
        },
      ],
      text: [],
      effect: [],
      grid: [],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '] paint radial-gradient(#FFFFFF 0%, #00000000 100%)',
    )
  })

  it('renders angular gradient', () => {
    const fixture = {
      paint: [
        {
          id: 'S:g3',
          name: 'Gradient/Angular',
          paints: [
            {
              type: 'GRADIENT_ANGULAR',
              gradientStops: [
                {
                  position: 0,
                  color: { r: 1, g: 0, b: 0, a: 1 },
                },
                {
                  position: 1,
                  color: { r: 0, g: 0, b: 1, a: 1 },
                },
              ],
            },
          ],
        },
      ],
      text: [],
      effect: [],
      grid: [],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '] paint angular-gradient(#FF0000 0%, #0000FF 100%)',
    )
  })

  it('renders diamond gradient', () => {
    const fixture = {
      paint: [
        {
          id: 'S:g4',
          name: 'Gradient/Diamond',
          paints: [
            {
              type: 'GRADIENT_DIAMOND',
              gradientStops: [
                {
                  position: 0,
                  color: { r: 1, g: 0, b: 0, a: 1 },
                },
                {
                  position: 1,
                  color: { r: 0, g: 0, b: 1, a: 1 },
                },
              ],
            },
          ],
        },
      ],
      text: [],
      effect: [],
      grid: [],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '] paint diamond-gradient(#FF0000 0%, #0000FF 100%)',
    )
  })

  it('renders image paint style', () => {
    const fixture = {
      paint: [
        {
          id: 'S:img1',
          name: 'Pattern/Dots',
          paints: [{ type: 'IMAGE' }],
        },
      ],
      text: [],
      effect: [],
      grid: [],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '- Pattern/Dots [S:img1] paint image',
    )
  })

  // --- Text: font shorthand ---
  it('renders text style as Family/Style/Size', () => {
    const tree = toStylesTree(stylesFixture)
    expect(tree).toContain(
      '- Heading/H1 [S:def456] text Inter/Bold/32',
    )
    expect(tree).toContain(
      '- Body/Regular [S:def457] text Inter/Regular/16',
    )
  })

  // --- Effect: all types ---
  it('renders drop shadow effect', () => {
    const tree = toStylesTree(stylesFixture)
    expect(tree).toContain(
      '- Elevation/Medium [S:ghi789] effect shadow(0,4,12,#0000001A)',
    )
  })

  it('renders inner shadow effect', () => {
    const fixture = {
      paint: [],
      text: [],
      grid: [],
      effect: [
        {
          id: 'S:e1',
          name: 'InnerGlow',
          effects: [
            {
              type: 'INNER_SHADOW',
              color: { r: 1, g: 1, b: 1, a: 0.5 },
              offset: { x: 0, y: 2 },
              radius: 4,
              spread: 0,
            },
          ],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '] effect inner-shadow(0,2,4,#FFFFFF80)',
    )
  })

  it('renders blur effect', () => {
    const fixture = {
      paint: [],
      text: [],
      grid: [],
      effect: [
        {
          id: 'S:e2',
          name: 'Frosted',
          effects: [
            { type: 'BACKGROUND_BLUR', radius: 20 },
          ],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain('] effect bg-blur(20)')
  })

  it('renders layer blur effect', () => {
    const fixture = {
      paint: [],
      text: [],
      grid: [],
      effect: [
        {
          id: 'S:e3',
          name: 'Soft',
          effects: [{ type: 'LAYER_BLUR', radius: 10 }],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain('] effect blur(10)')
  })

  it('renders multiple effects joined', () => {
    const fixture = {
      paint: [],
      text: [],
      grid: [],
      effect: [
        {
          id: 'S:e4',
          name: 'Complex',
          effects: [
            {
              type: 'DROP_SHADOW',
              color: { r: 0, g: 0, b: 0, a: 0.25 },
              offset: { x: 0, y: 4 },
              radius: 8,
              spread: 0,
            },
            { type: 'LAYER_BLUR', radius: 2 },
          ],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '] effect shadow(0,4,8,#00000040)+blur(2)',
    )
  })

  // --- Grid ---
  it('renders grid style with columns', () => {
    const fixture = {
      paint: [],
      text: [],
      effect: [],
      grid: [
        {
          id: 'S:gr1',
          name: 'Layout/12col',
          grids: [
            {
              pattern: 'COLUMNS',
              count: 12,
              sectionSize: 32,
              gutterSize: 16,
              alignment: 'STRETCH',
              offset: 0,
            },
          ],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '- Layout/12col [S:gr1] grid columns(12,32,16)',
    )
  })

  it('renders grid style with rows', () => {
    const fixture = {
      paint: [],
      text: [],
      effect: [],
      grid: [
        {
          id: 'S:gr2',
          name: 'Layout/8row',
          grids: [
            {
              pattern: 'ROWS',
              count: 8,
              sectionSize: 40,
              gutterSize: 8,
              alignment: 'STRETCH',
              offset: 0,
            },
          ],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '- Layout/8row [S:gr2] grid rows(8,40,8)',
    )
  })

  it('renders uniform grid', () => {
    const fixture = {
      paint: [],
      text: [],
      effect: [],
      grid: [
        {
          id: 'S:gr3',
          name: 'Layout/Grid',
          grids: [{ pattern: 'GRID', sectionSize: 16 }],
        },
      ],
    }
    const tree = toStylesTree(fixture)
    expect(tree).toContain(
      '- Layout/Grid [S:gr3] grid grid(16)',
    )
  })

  // --- One line per style ---
  it('renders each style as one line', () => {
    const tree = toStylesTree(stylesFixture)
    const lines = tree
      .split('\n')
      .filter(l => l.startsWith('- '))
    expect(lines).toHaveLength(5)
  })
})

// --- Task 4: toComponentsTree ---

describe('toComponentsTree', () => {
  it('includes local and remote counts in header', () => {
    const tree = toComponentsTree(componentsFixture)
    expect(tree).toContain('# 2 local, 1 remote')
  })

  it('renders component with variant key=value pairs', () => {
    const tree = toComponentsTree(componentsFixture)
    expect(tree).toContain('- Button [')
    expect(tree).toMatch(/Size=/)
    expect(tree).toMatch(/Style=/)
  })

  it('renders component properties as name:TYPE', () => {
    const tree = toComponentsTree(componentsFixture)
    expect(tree).toMatch(/label:TEXT/)
    expect(tree).toMatch(/showIcon:BOOL/)
  })

  it('renders simple component with no extras', () => {
    const tree = toComponentsTree(componentsFixture)
    const avatarLine = tree
      .split('\n')
      .find(l => l.includes('Avatar'))
    expect(avatarLine).toMatch(/^- Avatar \[.+\]$/)
  })

  it('renders remote components with library and key', () => {
    const tree = toComponentsTree(componentsFixture)
    expect(tree).toContain(
      '- Input [remote:Design System v2] key:',
    )
  })

  it('each component is one line', () => {
    const tree = toComponentsTree(componentsFixture)
    const lines = tree
      .split('\n')
      .filter(l => l.startsWith('- '))
    expect(lines).toHaveLength(3)
  })
})
