import { describe, expect, it } from 'bun:test'
import type { ParsedNode } from '@figma-agent-bridge/shared/types'
import {
  parseNode,
  computeSummary,
  toInspectYaml,
  toInspectTree,
  toFullJson,
  toPageLayoutYaml,
  toStylesYaml,
  toComponentsYaml,
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
