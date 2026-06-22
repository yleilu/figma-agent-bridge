# M2: Read & Parse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side parsing layer and all read tools so the AI agent can understand any Figma design — inspect nodes (YAML), get full data (JSON), list pages, discover styles/components, search nodes, and export images.

**Architecture:** Two-tier read system. `inspect_*` tools return compact YAML via `parser.ts` (server-side). `get_*` tools return depth-limited JSON close to Figma's native format. Plugin handles raw Figma API calls; server transforms the data. All M2 tools are pure reads — no side effects on the Figma file.

**Tech Stack:**
- Runtime: Bun (workspaces, native TS, fast test runner)
- MCP SDK: `@modelcontextprotocol/sdk`
- YAML: `yaml` package (npm) for serialization
- Validation: Zod
- Testing: `bun:test`
- Plugin: Plain JS (Figma QuickJS sandbox)

**Coding Standards:** Follow @javascript-standards skill — arrow functions, destructuring, explicit null checks, no for loops (array methods), always braces for conditionals, blank line before return/throw.

**Notion spec:** https://www.notion.so/326de7ba506881d2a3c4ca3f13feda11

---

## File Structure

```
packages/
├── shared/src/
│   ├── types.ts                        # Add: ParsedNode, InspectResult, StyleInfo, ComponentInfo
│   └── schemas.ts                      # Add: M2 tool parameter schemas (Zod)
├── server/src/
│   ├── index.ts                        # Modify: register all M2 tools
│   ├── parser.ts                       # NEW: toInspectYaml(), toFullJson(), computeSummary()
│   └── tools/
│       ├── session.ts                  # Existing (connect, status)
│       ├── read.ts                     # NEW: inspect, inspect_page_layout, get_node_info, get_nodes_info, list_pages
│       ├── design-system.ts            # NEW: inspect_styles, inspect_components
│       ├── search.ts                   # NEW: search
│       └── export.ts                   # NEW: export
├── figma-plugin/
│   └── code.js                         # Modify: refactor handleCommand to async switch/case, add command handlers

test/
├── fixtures/
│   ├── card-node-raw.json              # NEW: raw Figma JSON_REST_V1 output
│   ├── page-layout-raw.json            # NEW: page-level frame data
│   ├── styles-raw.json                 # NEW: getLocalPaintStyles() etc. output
│   └── components-raw.json             # NEW: component data with variants
├── server/
│   ├── parser.test.ts                  # NEW: parser unit tests
│   └── tools/
│       ├── read.test.ts                # NEW: inspect/get tool tests
│       ├── design-system.test.ts       # NEW: inspect_styles/components tests
│       └── search.test.ts              # NEW: search tool tests
├── mocks/
│   └── mock-plugin.ts                  # Modify: handle all M2 commands
└── integration/
    └── e2e-roundtrip.test.ts           # Modify: add M2 roundtrip tests
```

---

## Phase 1: Parser Foundation

### Task 1: Fixture Files + Shared Types + Zod Schemas

**Files:**
- Create: `test/fixtures/card-node-raw.json`
- Create: `test/fixtures/page-layout-raw.json`
- Create: `test/fixtures/styles-raw.json`
- Create: `test/fixtures/components-raw.json`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create raw Figma node fixture**

Create `test/fixtures/card-node-raw.json` — a realistic raw Figma `exportAsync({ format: "JSON_REST_V1" })` output for a Card frame with 3 children (title text, body text, button instance). Include: `absoluteBoundingBox`, `layoutMode`, `fills` with RGBA, `effects`, `cornerRadius`, `style` for text nodes, `componentId` for instance nodes, all the verbose fields.

```json
{
  "id": "1:42",
  "name": "Card",
  "type": "FRAME",
  "visible": true,
  "locked": false,
  "opacity": 1,
  "blendMode": "PASS_THROUGH",
  "absoluteBoundingBox": { "x": 100, "y": 200, "width": 320, "height": 200 },
  "absoluteRenderBounds": { "x": 96, "y": 196, "width": 328, "height": 212 },
  "relativeTransform": [[1, 0, 100], [0, 1, 200]],
  "constraints": { "horizontal": "MIN", "vertical": "MIN" },
  "clipsContent": true,
  "layoutMode": "VERTICAL",
  "primaryAxisSizingMode": "AUTO",
  "counterAxisSizingMode": "FIXED",
  "primaryAxisAlignItems": "MIN",
  "counterAxisAlignItems": "MIN",
  "layoutSizingHorizontal": "FIXED",
  "layoutSizingVertical": "HUG",
  "paddingLeft": 16,
  "paddingRight": 16,
  "paddingTop": 16,
  "paddingBottom": 16,
  "itemSpacing": 12,
  "layoutWrap": "NO_WRAP",
  "fills": [
    {
      "type": "SOLID",
      "visible": true,
      "opacity": 1,
      "blendMode": "NORMAL",
      "color": { "r": 1, "g": 1, "b": 1, "a": 1 },
      "boundVariables": { "color": { "id": "var:123", "type": "VARIABLE_ALIAS" } }
    }
  ],
  "strokes": [],
  "strokeWeight": 0,
  "strokeAlign": "INSIDE",
  "cornerRadius": 8,
  "rectangleCornerRadii": [8, 8, 8, 8],
  "effects": [
    {
      "type": "DROP_SHADOW",
      "visible": true,
      "color": { "r": 0, "g": 0, "b": 0, "a": 0.25 },
      "offset": { "x": 0, "y": 4 },
      "radius": 8,
      "spread": 0,
      "blendMode": "NORMAL"
    }
  ],
  "exportSettings": [],
  "isMask": false,
  "children": [
    {
      "id": "1:43",
      "name": "Title",
      "type": "TEXT",
      "visible": true,
      "locked": false,
      "opacity": 1,
      "blendMode": "PASS_THROUGH",
      "absoluteBoundingBox": { "x": 116, "y": 216, "width": 288, "height": 24 },
      "constraints": { "horizontal": "MIN", "vertical": "MIN" },
      "layoutSizingHorizontal": "FILL",
      "layoutSizingVertical": "HUG",
      "fills": [
        {
          "type": "SOLID",
          "visible": true,
          "opacity": 1,
          "blendMode": "NORMAL",
          "color": { "r": 0.102, "g": 0.102, "b": 0.102, "a": 1 }
        }
      ],
      "strokes": [],
      "characters": "Card Title",
      "style": {
        "fontFamily": "Inter",
        "fontPostScriptName": "Inter-SemiBold",
        "fontStyle": "Semi Bold",
        "fontWeight": 600,
        "fontSize": 18,
        "textAlignHorizontal": "LEFT",
        "textAlignVertical": "TOP",
        "letterSpacing": 0,
        "lineHeightPx": 24,
        "lineHeightPercent": 133.33,
        "lineHeightUnit": "PIXELS"
      },
      "children": []
    },
    {
      "id": "1:44",
      "name": "Body",
      "type": "TEXT",
      "visible": true,
      "opacity": 1,
      "blendMode": "PASS_THROUGH",
      "absoluteBoundingBox": { "x": 116, "y": 252, "width": 288, "height": 48 },
      "layoutSizingHorizontal": "FILL",
      "layoutSizingVertical": "HUG",
      "fills": [
        {
          "type": "SOLID",
          "visible": true,
          "opacity": 1,
          "color": { "r": 0.4, "g": 0.4, "b": 0.4, "a": 1 }
        }
      ],
      "strokes": [],
      "characters": "Description text here...",
      "style": {
        "fontFamily": "Inter",
        "fontStyle": "Regular",
        "fontWeight": 400,
        "fontSize": 14,
        "textAlignHorizontal": "LEFT",
        "letterSpacing": 0,
        "lineHeightPx": 20
      },
      "children": []
    },
    {
      "id": "1:45",
      "name": "Action Button",
      "type": "INSTANCE",
      "visible": true,
      "opacity": 1,
      "absoluteBoundingBox": { "x": 116, "y": 312, "width": 100, "height": 40 },
      "layoutSizingHorizontal": "HUG",
      "layoutSizingVertical": "HUG",
      "fills": [],
      "componentId": "C:abc123",
      "componentProperties": {
        "Size": { "type": "VARIANT", "value": "Medium" },
        "Style": { "type": "VARIANT", "value": "Primary" }
      },
      "overrides": [
        { "id": "1:45:label", "overriddenFields": ["characters"] }
      ],
      "children": []
    }
  ]
}
```

- [ ] **Step 2: Create page layout fixture**

Create `test/fixtures/page-layout-raw.json` — object with `pageName` and `frames` array, as returned by the `get_page_layout` command:

```json
{
  "pageName": "Homepage",
  "frames": [
    {
      "id": "2:1",
      "name": "Header",
      "type": "FRAME",
      "x": 0,
      "y": 0,
      "width": 1440,
      "height": 80,
      "childCount": 8
    },
    {
      "id": "2:15",
      "name": "Hero",
      "type": "FRAME",
      "x": 0,
      "y": 80,
      "width": 1440,
      "height": 600,
      "childCount": 15
    },
    {
      "id": "2:42",
      "name": "Features",
      "type": "FRAME",
      "x": 0,
      "y": 680,
      "width": 1440,
      "height": 400,
      "childCount": 24
    }
  ]
}
```

- [ ] **Step 3: Create styles fixture**

Create `test/fixtures/styles-raw.json` — represents what the plugin returns for `get_styles`:

```json
{
  "paint": [
    { "id": "S:abc123", "name": "Colors/Primary/500", "paints": [{ "type": "SOLID", "color": { "r": 0.231, "g": 0.51, "b": 0.965, "a": 1 } }] },
    { "id": "S:abc124", "name": "Colors/Surface/Default", "paints": [{ "type": "SOLID", "color": { "r": 1, "g": 1, "b": 1, "a": 1 } }] }
  ],
  "text": [
    { "id": "S:def456", "name": "Heading/H1", "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 32, "lineHeight": 40 },
    { "id": "S:def457", "name": "Body/Regular", "fontFamily": "Inter", "fontStyle": "Regular", "fontSize": 16, "lineHeight": 24 }
  ],
  "effect": [
    { "id": "S:ghi789", "name": "Elevation/Medium", "effects": [{ "type": "DROP_SHADOW", "color": { "r": 0, "g": 0, "b": 0, "a": 0.1 }, "offset": { "x": 0, "y": 4 }, "radius": 12, "spread": 0 }] }
  ],
  "grid": []
}
```

- [ ] **Step 4: Create components fixture**

Create `test/fixtures/components-raw.json`:

```json
{
  "local": [
    {
      "id": "C:abc123",
      "name": "Button",
      "page": "Components",
      "variants": { "Size": ["Small", "Medium", "Large"], "Style": ["Primary", "Secondary", "Ghost"] },
      "properties": [
        { "name": "label", "type": "TEXT", "default": "Button" },
        { "name": "showIcon", "type": "BOOLEAN", "default": true }
      ]
    },
    {
      "id": "C:def456",
      "name": "Avatar",
      "page": "Components",
      "variants": null,
      "properties": []
    }
  ],
  "remote": [
    { "key": "xyz789", "name": "Input", "library": "Design System v2", "instancesCount": 12 }
  ]
}
```

- [ ] **Step 5: Add shared types for parsed output**

Add to `packages/shared/src/types.ts`:

```typescript
export type ParsedNode = {
  id: string
  name: string
  type: string
  size: [number, number]
  position?: [number, number]
  layout?: {
    mode: 'H' | 'V'
    spacing: number
    padding: [number, number, number, number]
    align: [string, string]
    wrap?: boolean
  }
  sizing?: [string, string]
  fills?: string[]
  strokes?: string[]
  radius?: number | [number, number, number, number]
  opacity?: number
  effects?: string[]
  text?: {
    content: string
    font: string
    align?: string
    color?: string
  }
  component?: {
    name: string
    id: string
    variant?: Record<string, string>
    overrides?: string[]
  }
  children?: ParsedNode[]
}

export type InspectSummary = {
  name: string
  id: string
  totalLayers: number
  maxDepth: number
  typeBreakdown: Record<string, number>
  componentNames: string[]
  layoutMode: 'H' | 'V' | null
  size: [number, number]
  rootFill: string | null
}

export type PageFrameInfo = {
  id: string
  name: string
  size: [number, number]
  position: [number, number]
  childrenCount: number
}

export type StyleInfo = {
  id: string
  name: string
  type: 'paint' | 'text' | 'effect' | 'grid'
  color?: string
  font?: string
  lineHeight?: number
  effects?: string[]
}

export type ComponentInfo = {
  id: string
  name: string
  page?: string
  variants?: Record<string, string[]>
  properties?: Array<{
    name: string
    type: string
    default?: string | boolean
  }>
}

export type SearchResult = {
  id: string
  name: string
  type: string
  page: string
  parent: string
  size: [number, number]
}
```

- [ ] **Step 6: Add M2 Zod schemas to shared/schemas.ts**

Add all M2 tool parameter schemas to `packages/shared/src/schemas.ts`, following the existing pattern (`connectParamsSchema`, `statusParamsSchema` are already there):

```typescript
// --- M2 tool schemas ---

export const inspectParamsSchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe('Node ID to inspect. If omitted, inspects current selection.'),
})

export const inspectPageLayoutParamsSchema = z.object({})

export const inspectStylesParamsSchema = z.object({
  type: z
    .enum(['paint', 'text', 'effect', 'grid'])
    .optional()
    .describe('Filter styles by type. If omitted, returns all styles.'),
})

export const inspectComponentsParamsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Filter components by name (case-insensitive substring match).'),
})

export const searchParamsSchema = z.object({
  name: z
    .string()
    .optional()
    .describe('Name pattern to search for. Supports * wildcards.'),
  type: z
    .string()
    .optional()
    .describe('Filter by node type (e.g. FRAME, TEXT, INSTANCE).'),
  pageId: z
    .string()
    .optional()
    .describe('Restrict search to a specific page by ID.'),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe('Max results to return (default 50). Truncates with truncated flag when exceeded.'),
})

export const getNodeInfoParamsSchema = z.object({
  nodeId: z
    .string()
    .describe('The node ID to retrieve.'),
  depth: z
    .number()
    .optional()
    .describe('Depth of children to include. 0 = stubs only, 3 = default, -1 = unlimited.'),
})

export const getNodesInfoParamsSchema = z.object({
  nodeIds: z
    .array(z.string())
    .describe('Array of node IDs to retrieve.'),
  depth: z
    .number()
    .optional()
    .describe('Depth of children to include. 0 = stubs only, 3 = default, -1 = unlimited.'),
})

export const listPagesParamsSchema = z.object({})

export const exportParamsSchema = z.object({
  nodeId: z
    .string()
    .describe('The node ID to export.'),
  format: z
    .enum(['PNG', 'SVG', 'PDF', 'JPG'])
    .optional()
    .describe('Export format. Defaults to PNG.'),
  scale: z
    .number()
    .optional()
    .describe('Scale factor for raster exports. Defaults to 1.'),
})
```

- [ ] **Step 7: Export new types and schemas from shared index**

Add exports to `packages/shared/src/index.ts`.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/ packages/shared/src/types.ts packages/shared/src/schemas.ts packages/shared/src/index.ts
git commit -m "feat(shared): add M2 fixture files, parsed output types, and Zod schemas"
```

---

### Task 2: Parser — toInspectYaml (RED → GREEN)

**Files:**
- Create: `packages/server/src/parser.ts`
- Create: `test/server/parser.test.ts`

- [ ] **Step 0: Install yaml package**

```bash
cd packages/server && bun add yaml
```

This adds the `yaml` npm package for YAML serialization. Include `packages/server/package.json` in the commit.

- [ ] **Step 1: Write parser test — parseNode transforms raw to ParsedNode**

```typescript
import { describe, expect, it } from 'bun:test'
import { parseNode, computeSummary, toInspectYaml } from '../../../packages/server/src/parser'
import cardFixture from '../../fixtures/card-node-raw.json'

describe('parseNode', () => {
  it('transforms raw Figma node to ParsedNode', () => {
    const parsed = parseNode(cardFixture)

    expect(parsed.id).toBe('1:42')
    expect(parsed.name).toBe('Card')
    expect(parsed.type).toBe('FRAME')
    expect(parsed.size).toEqual([320, 200])
    expect(parsed.fills).toEqual(['#FFFFFF'])
    expect(parsed.radius).toBe(8)
    expect(parsed.effects).toEqual(['shadow(0,4,8,#00000040)'])
    expect(parsed.layout).toEqual({
      mode: 'V',
      spacing: 12,
      padding: [16, 16, 16, 16],
      align: ['MIN', 'MIN'],
    })
  })

  it('parses text node with compact font', () => {
    const parsed = parseNode(cardFixture)
    const title = parsed.children![0]

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
    const button = parsed.children![2]

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
    const body = parsed.children![1]

    expect(body.text!.color).toBe('#666666')
  })
})
```

- [ ] **Step 2: Write parser test — computeSummary**

```typescript
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

    expect(summary.componentNames).toEqual(['Action Button'])
  })

  it('extracts root layout mode', () => {
    const parsed = parseNode(cardFixture)
    const summary = computeSummary(parsed)

    expect(summary.layoutMode).toBe('V')
    expect(summary.rootFill).toBe('#FFFFFF')
  })
})
```

- [ ] **Step 3: Write parser test — toInspectYaml**

```typescript
describe('toInspectYaml', () => {
  it('produces YAML with summary comments', () => {
    const parsed = parseNode(cardFixture)
    const yaml = toInspectYaml(parsed)

    expect(yaml).toContain('# Card [1:42]')
    expect(yaml).toContain('4 layers')
    expect(yaml).toContain('auto-layout: V')
    expect(yaml).toContain('320×200')
    expect(yaml).toContain('id: "1:42"')
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
```

- [ ] **Step 4: Run tests — verify RED**

Run: `bun test test/server/parser.test.ts`
Expected: FAIL — `parser.ts` does not exist

- [ ] **Step 5: Implement rgbaToHex, parseNode, computeSummary, toInspectYaml**

Create `packages/server/src/parser.ts` with:

```typescript
import YAML from 'yaml'
import type { ParsedNode, InspectSummary, PageFrameInfo } from '@figma-agent-bridge/shared'

// --- Helpers ---

const rgbaToHex = (color: { r: number; g: number; b: number; a: number }): string => {
  const toHex = (v: number): string => {
    const hex = Math.round(v * 255).toString(16).padStart(2, '0')

    return hex
  }

  const rgb = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
  if (color.a !== null && color.a !== undefined && color.a < 1) {
    return `${rgb}${toHex(color.a)}`
  }

  return rgb.toUpperCase()
}

const parseFills = (fills: Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number } }>): string[] | undefined => {
  const result = fills
    .filter((f) => f.visible !== false && f.type === 'SOLID' && f.color !== null && f.color !== undefined)
    .map((f) => rgbaToHex(f.color!))

  return result.length > 0 ? result : undefined
}

const parseEffects = (effects: Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; offset?: { x: number; y: number }; radius?: number; spread?: number }>): string[] | undefined => {
  const result = effects
    .filter((e) => e.visible !== false)
    .map((e) => {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const colorHex = e.color !== null && e.color !== undefined ? rgbaToHex(e.color) : '?'
        const ox = e.offset !== null && e.offset !== undefined ? e.offset.x : 0
        const oy = e.offset !== null && e.offset !== undefined ? e.offset.y : 0

        return `shadow(${ox},${oy},${e.radius ?? 0},${colorHex})`
      }
      if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
        return `blur(${e.radius ?? 0})`
      }

      return e.type.toLowerCase()
    })

  return result.length > 0 ? result : undefined
}

const parseTextStyle = (
  style: { fontFamily?: string; fontStyle?: string; fontSize?: number; textAlignHorizontal?: string },
  fills: Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number } }>,
): { font: string; align?: string; color?: string } => {
  const family = style.fontFamily ?? 'Unknown'
  const weight = (style.fontStyle ?? 'Regular').replace(/\s+/g, '')
  const size = style.fontSize ?? 0
  const font = `${family}/${weight}/${size}`
  const align = style.textAlignHorizontal ?? undefined
  const colorFills = fills.filter((f) => f.visible !== false && f.type === 'SOLID' && f.color !== null && f.color !== undefined)
  const color = colorFills.length > 0 ? rgbaToHex(colorFills[0].color!) : undefined

  return { font, ...(align !== undefined ? { align } : {}), ...(color !== undefined ? { color } : {}) }
}

const parseLayout = (node: Record<string, unknown>): ParsedNode['layout'] | undefined => {
  const mode = node.layoutMode as string | undefined
  if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') {
    return undefined
  }

  return {
    mode: mode === 'HORIZONTAL' ? 'H' : 'V',
    spacing: (node.itemSpacing as number) ?? 0,
    padding: [
      (node.paddingTop as number) ?? 0,
      (node.paddingRight as number) ?? 0,
      (node.paddingBottom as number) ?? 0,
      (node.paddingLeft as number) ?? 0,
    ],
    align: [
      (node.primaryAxisAlignItems as string) ?? 'MIN',
      (node.counterAxisAlignItems as string) ?? 'MIN',
    ],
    ...((node.layoutWrap as string) === 'WRAP' ? { wrap: true } : {}),
  }
}

const parseComponentInfo = (node: Record<string, unknown>): ParsedNode['component'] | undefined => {
  if (node.type !== 'INSTANCE') {
    return undefined
  }

  const props = node.componentProperties as Record<string, { type: string; value: string }> | undefined
  const variant = props !== null && props !== undefined
    ? Object.fromEntries(
        Object.entries(props)
          .filter(([, v]) => v.type === 'VARIANT')
          .map(([k, v]) => [k, v.value]),
      )
    : undefined

  return {
    name: (node.name as string) ?? '',
    id: (node.componentId as string) ?? '',
    ...(variant !== undefined && Object.keys(variant).length > 0 ? { variant } : {}),
  }
}

// --- Main exports ---

export const parseNode = (raw: Record<string, unknown>): ParsedNode => {
  const bbox = raw.absoluteBoundingBox as { x: number; y: number; width: number; height: number } | undefined
  const size: [number, number] = bbox !== null && bbox !== undefined ? [bbox.width, bbox.height] : [0, 0]
  const fills = raw.fills !== null && raw.fills !== undefined ? parseFills(raw.fills as Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number } }>) : undefined
  const strokes = raw.strokes !== null && raw.strokes !== undefined ? parseFills(raw.strokes as Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number } }>) : undefined
  const effects = raw.effects !== null && raw.effects !== undefined ? parseEffects(raw.effects as Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; offset?: { x: number; y: number }; radius?: number; spread?: number }>) : undefined
  const layout = parseLayout(raw)
  const component = parseComponentInfo(raw)

  const sizingH = raw.layoutSizingHorizontal as string | undefined
  const sizingV = raw.layoutSizingVertical as string | undefined
  const sizing: [string, string] | undefined = sizingH !== null && sizingH !== undefined && sizingV !== null && sizingV !== undefined ? [sizingH, sizingV] : undefined

  const radius = raw.cornerRadius as number | undefined
  const opacity = raw.opacity as number | undefined

  const children = (raw.children as Array<Record<string, unknown>> | undefined)?.map((c) => parseNode(c))

  const textContent = raw.characters as string | undefined
  const textStyle = raw.style as { fontFamily?: string; fontStyle?: string; fontSize?: number; textAlignHorizontal?: string } | undefined
  const text = textContent !== null && textContent !== undefined && textStyle !== null && textStyle !== undefined
    ? {
        content: textContent,
        ...parseTextStyle(textStyle, (raw.fills ?? []) as Array<{ type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number } }>),
      }
    : undefined

  const result: ParsedNode = {
    id: raw.id as string,
    name: raw.name as string,
    type: raw.type as string,
    size,
  }

  // Only include non-default/non-empty fields
  if (layout !== undefined) { result.layout = layout }
  if (sizing !== undefined) { result.sizing = sizing }
  if (fills !== undefined) { result.fills = fills }
  if (strokes !== undefined && strokes.length > 0) { result.strokes = strokes }
  if (radius !== undefined && radius !== 0) { result.radius = radius }
  if (opacity !== undefined && opacity < 1) { result.opacity = opacity }
  if (effects !== undefined) { result.effects = effects }
  if (text !== undefined) { result.text = text }
  if (component !== undefined) { result.component = component }
  if (children !== undefined && children.length > 0) { result.children = children }

  return result
}

export const computeSummary = (parsed: ParsedNode): InspectSummary => {
  const typeBreakdown: Record<string, number> = {}
  const componentNames: string[] = []
  let totalLayers = 0
  let maxDepth = 0

  const walk = (node: ParsedNode, depth: number): void => {
    totalLayers++
    if (depth > maxDepth) { maxDepth = depth }
    typeBreakdown[node.type] = (typeBreakdown[node.type] ?? 0) + 1

    if (node.component !== null && node.component !== undefined && !componentNames.includes(node.component.name)) {
      componentNames.push(node.component.name)
    }

    if (node.children !== null && node.children !== undefined) {
      node.children.forEach((child) => { walk(child, depth + 1) })
    }
  }

  walk(parsed, 0)

  return {
    name: parsed.name,
    id: parsed.id,
    totalLayers,
    maxDepth,
    typeBreakdown,
    componentNames,
    layoutMode: parsed.layout?.mode ?? null,
    size: parsed.size,
    rootFill: parsed.fills !== null && parsed.fills !== undefined && parsed.fills.length > 0 ? parsed.fills[0] : null,
  }
}

export const toInspectYaml = (parsed: ParsedNode): string => {
  const summary = computeSummary(parsed)
  const sizeStr = `${summary.size[0]}×${summary.size[1]}`
  const typeCounts = Object.entries(summary.typeBreakdown)
    .map(([t, c]) => `${c} ${t}`)
    .join(', ')
  const alStr = summary.layoutMode !== null ? `auto-layout: ${summary.layoutMode}` : 'no auto-layout'

  const header = [
    `# ${summary.name} [${summary.id}]`,
    `# ${summary.totalLayers} layers, depth ${summary.maxDepth} | ${sizeStr} | ${alStr}`,
    `# types: ${typeCounts}`,
    ...(summary.componentNames.length > 0 ? [`# components: ${summary.componentNames.join(', ')}`] : []),
    '',
  ].join('\n')

  const yamlStr = YAML.stringify(parsed, { lineWidth: 120 })

  return header + yamlStr
}
```

- [ ] **Step 6: Run tests — verify GREEN**

Run: `bun test test/server/parser.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Run linter**

Run: `bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/parser.ts test/server/parser.test.ts packages/server/package.json
git commit -m "feat(server): add parser with toInspectYaml and computeSummary"
```

---

### Task 3: Parser — toFullJson with Depth Control (RED → GREEN)

**Files:**
- Modify: `packages/server/src/parser.ts`
- Modify: `test/server/parser.test.ts`

> **Depth semantics:**
> - depth 0 = root node with child stubs only (children shown as `{ id, name, type }`)
> - depth 1 = root + full first-level children, grandchild stubs
> - depth 3 (default) = 3 levels of full data
> - depth -1 = unlimited (no truncation)

- [ ] **Step 1: Write tests for toFullJson**

```typescript
import { toFullJson } from '../../../packages/server/src/parser'

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

    // First-level children should have full data
    expect(json.children[0].characters).toBe('Card Title')
    expect(json.children[0].style).toBeDefined()
  })

  it('allows unlimited depth with -1', () => {
    const result = toFullJson(cardFixture, -1)
    const json = JSON.parse(result)

    expect(json.children[0].characters).toBe('Card Title')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

Run: `bun test test/server/parser.test.ts`
Expected: FAIL — `toFullJson` not defined

- [ ] **Step 3: Implement toFullJson**

Add to `packages/server/src/parser.ts`:

```typescript
const FILTERED_KEYS = new Set([
  'boundVariables', 'imageRef', 'relativeTransform', 'exportSettings', 'isMask',
  'absoluteRenderBounds',
])

const filterNode = (raw: Record<string, unknown>, maxDepth: number, currentDepth: number): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  Object.entries(raw).forEach(([key, value]) => {
    if (FILTERED_KEYS.has(key)) {
      return
    }

    if (key === 'children' && Array.isArray(value)) {
      if (maxDepth !== -1 && currentDepth >= maxDepth) {
        result.children = value.map((child: Record<string, unknown>) => ({
          id: child.id,
          name: child.name,
          type: child.type,
        }))
      } else {
        result.children = value.map((child: Record<string, unknown>) =>
          filterNode(child, maxDepth, currentDepth + 1),
        )
      }

      return
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const filtered = filterNode(value as Record<string, unknown>, maxDepth, currentDepth)
      if (Object.keys(filtered).length > 0) {
        result[key] = filtered
      }

      return
    }

    if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return filterNode(item as Record<string, unknown>, maxDepth, currentDepth)
        }

        return item
      })

      return
    }

    result[key] = value
  })

  return result
}

/**
 * Depth semantics:
 * - depth 0 = root node with child stubs only (children shown as { id, name, type })
 * - depth 1 = root + full first-level children, grandchild stubs
 * - depth 3 (default) = 3 levels of full data
 * - depth -1 = unlimited (no truncation)
 */
export const toFullJson = (raw: Record<string, unknown>, depth: number = 3): string => {
  const filtered = filterNode(raw, depth, 0)

  return JSON.stringify(filtered, null, 2)
}
```

- [ ] **Step 4: Run tests — verify GREEN**

Run: `bun test test/server/parser.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/parser.ts test/server/parser.test.ts
git commit -m "feat(server): add toFullJson with depth control (default 3)"
```

---

### Task 4: Parser — toPageLayoutYaml (RED → GREEN)

**Files:**
- Modify: `packages/server/src/parser.ts`
- Modify: `test/server/parser.test.ts`

- [ ] **Step 1: Write tests for toPageLayoutYaml**

```typescript
import pageLayoutFixture from '../../fixtures/page-layout-raw.json'

describe('toPageLayoutYaml', () => {
  it('produces YAML with summary and frame list', () => {
    const yaml = toPageLayoutYaml(pageLayoutFixture)

    expect(yaml).toContain('# Homepage')
    expect(yaml).toContain('3 top-level frames')
    expect(yaml).toContain('name: Header')
    expect(yaml).toContain('size: [1440, 80]')
    expect(yaml).toContain('position: [0, 0]')
    expect(yaml).toContain('children_count: 8')
  })

  it('includes canvas bounding box in summary', () => {
    const yaml = toPageLayoutYaml(pageLayoutFixture)

    expect(yaml).toContain('canvas: 1440×1080')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

- [ ] **Step 3: Implement toPageLayoutYaml**

Add to `parser.ts`:

```typescript
export const toPageLayoutYaml = (raw: { pageName: string; frames: Array<Record<string, unknown>> }): string => {
  const { pageName, frames } = raw
  const mapped: PageFrameInfo[] = frames.map((f) => ({
    id: f.id as string,
    name: f.name as string,
    size: [f.width as number, f.height as number] as [number, number],
    position: [f.x as number, f.y as number] as [number, number],
    childrenCount: (f.childCount as number) ?? 0,
  }))

  const maxX = Math.max(...mapped.map((f) => f.position[0] + f.size[0]))
  const maxY = Math.max(...mapped.map((f) => f.position[1] + f.size[1]))

  const header = [
    `# ${pageName}`,
    `# ${mapped.length} top-level frames | canvas: ${maxX}×${maxY}`,
    '',
  ].join('\n')

  const yamlData = mapped.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    position: f.position,
    children_count: f.childrenCount,
  }))

  return header + YAML.stringify(yamlData, { lineWidth: 120 })
}
```

- [ ] **Step 4: Run tests — verify GREEN**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/parser.ts test/server/parser.test.ts
git commit -m "feat(server): add toPageLayoutYaml for inspect_page_layout"
```

---

### Task 5: Parser — toStylesYaml and toComponentsYaml (RED → GREEN)

**Files:**
- Modify: `packages/server/src/parser.ts`
- Modify: `test/server/parser.test.ts`

- [ ] **Step 1: Write tests for toStylesYaml**

```typescript
import stylesFixture from '../../fixtures/styles-raw.json'

describe('toStylesYaml', () => {
  it('produces YAML grouped by type with summary', () => {
    const yaml = toStylesYaml(stylesFixture)

    expect(yaml).toContain('# 5 styles: 2 paint, 2 text, 1 effect')
    expect(yaml).toContain('name: "Colors/Primary/500"')
    expect(yaml).toContain('color: "#3B82F6"')
    expect(yaml).toContain('font: Inter/Bold/32')
    expect(yaml).toContain('effects: ["shadow(0,4,12,#0000001A)"]')
  })

  it('omits empty style groups', () => {
    const yaml = toStylesYaml(stylesFixture)

    expect(yaml).not.toContain('grid:')
  })
})
```

- [ ] **Step 2: Write tests for toComponentsYaml**

```typescript
import componentsFixture from '../../fixtures/components-raw.json'

describe('toComponentsYaml', () => {
  it('produces YAML with local and remote sections', () => {
    const yaml = toComponentsYaml(componentsFixture)

    expect(yaml).toContain('# 2 local components, 1 remote in use')
    expect(yaml).toContain('name: "Button"')
    expect(yaml).toContain('Size: [Small, Medium, Large]')
    expect(yaml).toContain('name: label')
    expect(yaml).toContain('type: TEXT')
  })

  it('includes remote components from libraries', () => {
    const yaml = toComponentsYaml(componentsFixture)

    expect(yaml).toContain('remote_in_use:')
    expect(yaml).toContain('name: "Input"')
    expect(yaml).toContain('library: "Design System v2"')
  })
})
```

- [ ] **Step 3: Run tests — verify RED**

- [ ] **Step 4: Implement toStylesYaml and toComponentsYaml**

Add to `parser.ts`:

```typescript
export const toStylesYaml = (raw: {
  paint: Array<Record<string, unknown>>
  text: Array<Record<string, unknown>>
  effect: Array<Record<string, unknown>>
  grid: Array<Record<string, unknown>>
}): string => {
  const counts: string[] = []
  const sections: Record<string, unknown>[] = []

  if (raw.paint.length > 0) {
    counts.push(`${raw.paint.length} paint`)
    const paintEntries = raw.paint.map((s) => {
      const paints = s.paints as Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>
      const solidFill = paints.find((p) => p.type === 'SOLID' && p.color !== null && p.color !== undefined)

      return {
        id: s.id,
        name: s.name,
        ...(solidFill !== undefined ? { color: rgbaToHex(solidFill.color!) } : {}),
      }
    })
    sections.push({ paint: paintEntries })
  }

  if (raw.text.length > 0) {
    counts.push(`${raw.text.length} text`)
    const textEntries = raw.text.map((s) => ({
      id: s.id,
      name: s.name,
      font: `${s.fontFamily}/${s.fontStyle}/${s.fontSize}`,
      ...(s.lineHeight !== null && s.lineHeight !== undefined ? { lineHeight: s.lineHeight } : {}),
    }))
    sections.push({ text: textEntries })
  }

  if (raw.effect.length > 0) {
    counts.push(`${raw.effect.length} effect`)
    const effectEntries = raw.effect.map((s) => {
      const effects = (s.effects as Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; offset?: { x: number; y: number }; radius?: number; spread?: number }>)
      const parsed = parseEffects(effects)

      return {
        id: s.id,
        name: s.name,
        ...(parsed !== undefined ? { effects: parsed } : {}),
      }
    })
    sections.push({ effect: effectEntries })
  }

  const total = raw.paint.length + raw.text.length + raw.effect.length + raw.grid.length
  const header = `# ${total} styles: ${counts.join(', ')}\n\n`
  const body = sections.map((sec) => YAML.stringify(sec, { lineWidth: 120 })).join('\n')

  return header + body
}

export const toComponentsYaml = (raw: {
  local: Array<Record<string, unknown>>
  remote: Array<Record<string, unknown>>
}): string => {
  const header = `# ${raw.local.length} local components, ${raw.remote.length} remote in use\n\n`

  const localEntries = raw.local.map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.page !== null && c.page !== undefined ? { page: c.page } : {}),
    ...(c.variants !== null && c.variants !== undefined ? { variants: c.variants } : {}),
    ...(Array.isArray(c.properties) && c.properties.length > 0 ? { properties: c.properties } : {}),
  }))

  const remoteEntries = raw.remote.map((r) => ({
    name: r.name,
    library: r.library,
    ...(r.key !== null && r.key !== undefined ? { key: r.key } : {}),
    ...(r.instancesCount !== null && r.instancesCount !== undefined ? { instances: r.instancesCount } : {}),
  }))

  const data: Record<string, unknown> = { local: localEntries }
  if (remoteEntries.length > 0) {
    data.remote_in_use = remoteEntries
  }

  return header + YAML.stringify(data, { lineWidth: 120 })
}
```

Note: `parseEffects` is already defined as a module-level helper from Task 2. Ensure it is accessible to `toStylesYaml`.

- [ ] **Step 5: Run tests — verify GREEN**

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/parser.ts test/server/parser.test.ts
git commit -m "feat(server): add toStylesYaml and toComponentsYaml parsers"
```

---

## Phase 2: Plugin Commands

### Task 6: Plugin — Refactor handleCommand + Read Commands (code.js)

**Files:**
- Modify: `packages/figma-plugin/code.js`

- [ ] **Step 1: Refactor handleCommand to async switch/case**

The existing `handleCommand` is a sync function using if/else. Refactor it to an async function using switch/case, and update `figma.ui.onmessage` to `await` it:

```javascript
async function handleCommand(command, params) {
  switch (command) {
    case 'get_document_info': {
      return {
        name: figma.root.name,
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
      };
    }
    // new cases added below
    default: {
      return { error: 'Unknown command: ' + command };
    }
  }
}
```

Update `figma.ui.onmessage` to await the result, preserving all existing storage handlers:

```javascript
figma.ui.onmessage = async function (msg) {
  if (msg.type === 'execute-command') {
    var result = await handleCommand(msg.command, msg.params);

    figma.ui.postMessage({
      type: 'command-result',
      id: msg.id,
      result: result,
    });
  }

  if (msg.type === 'storage-get') {
    var value = await figma.clientStorage.getAsync(msg.key);
    figma.ui.postMessage({
      type: 'storage-result',
      key: msg.key,
      value: value !== undefined ? value : null,
    });
  }

  if (msg.type === 'storage-set') {
    await figma.clientStorage.setAsync(msg.key, msg.value);
  }

  if (msg.type === 'storage-delete') {
    await figma.clientStorage.deleteAsync(msg.key);
  }
};
```

- [ ] **Step 2: Add get_selection command**

Returns current selection info — array of `{ id, name, type }` for each selected node:

```javascript
case 'get_selection': {
  var selection = figma.currentPage.selection;
  var mapped = selection.map(function(node) {
    return { id: node.id, name: node.name, type: node.type };
  });
  return mapped;
}
```

- [ ] **Step 3: Add get_node command**

Returns full node data via `exportAsync({ format: "JSON_REST_V1" })`:

```javascript
case 'get_node': {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error('Node not found: ' + params.nodeId);
  }
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      children: node.children.map(function(c) {
        return { id: c.id, name: c.name, type: c.type };
      })
    };
  }
  var response = await node.exportAsync({ format: 'JSON_REST_V1' });
  return response.document;
}
```

- [ ] **Step 4: Add get_nodes command**

Same as get_node but batched:

```javascript
case 'get_nodes': {
  var nodeIds = params.nodeIds || [];
  var results = await Promise.all(nodeIds.map(async function(nodeId) {
    var n = await figma.getNodeByIdAsync(nodeId);
    if (!n) {
      return { id: nodeId, error: 'Node not found' };
    }
    if (n.type === 'DOCUMENT' || n.type === 'PAGE') {
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        children: n.children.map(function(c) {
          return { id: c.id, name: c.name, type: c.type };
        })
      };
    }
    var resp = await n.exportAsync({ format: 'JSON_REST_V1' });
    return resp.document;
  }));
  return results;
}
```

- [ ] **Step 5: Add get_page_layout command**

Returns page name plus all top-level frames on the current page as `{ pageName, frames }`:

```javascript
case 'get_page_layout': {
  await figma.currentPage.loadAsync();
  var frames = figma.currentPage.children.map(function(node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      childCount: node.children ? node.children.length : 0
    };
  });
  return {
    pageName: figma.currentPage.name,
    frames: frames
  };
}
```

- [ ] **Step 6: Add get_pages command**

Returns all pages in the document:

```javascript
case 'get_pages': {
  var pages = figma.root.children.map(function(page) {
    return {
      id: page.id,
      name: page.name,
      isCurrent: page.id === figma.currentPage.id,
      childCount: page.children.length
    };
  });
  return pages;
}
```

- [ ] **Step 7: Add export_node command**

Uses manual base64 encoding (QuickJS sandbox does not have `btoa`):

```javascript
case 'export_node': {
  var exportNode = await figma.getNodeByIdAsync(params.nodeId);
  if (!exportNode) {
    throw new Error('Node not found: ' + params.nodeId);
  }
  var format = (params.format || 'PNG').toUpperCase();
  var scale = params.scale || 1;
  var bytes = await exportNode.exportAsync({
    format: format,
    constraint: { type: 'SCALE', value: scale }
  });
  // SVG returns raw string — skip base64 encoding
  if (format === 'SVG') {
    var decoder = '';
    for (var i = 0; i < bytes.length; i++) {
      decoder += String.fromCharCode(bytes[i]);
    }
    return {
      format: format,
      scale: scale,
      data: decoder
    };
  }
  // PNG, JPG, PDF — manual base64 encoding (QuickJS sandbox has no btoa)
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var base64 = '';
  var i;
  for (i = 0; i < bytes.length; i += 3) {
    var b1 = bytes[i];
    var b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    base64 += CHARS[b1 >> 2];
    base64 += CHARS[((b1 & 3) << 4) | (b2 >> 4)];
    base64 += i + 1 < bytes.length ? CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    base64 += i + 2 < bytes.length ? CHARS[b3 & 63] : '=';
  }
  return {
    format: format,
    scale: scale,
    data: base64
  };
}
```

- [ ] **Step 8: Commit**

```bash
git add packages/figma-plugin/code.js
git commit -m "feat(plugin): refactor handleCommand to async switch/case, add read commands"
```

---

### Task 7: Plugin — Design System + Search Commands

**Files:**
- Modify: `packages/figma-plugin/code.js`

- [ ] **Step 1: Add get_styles command**

```javascript
case 'get_styles': {
  var paintStyles = figma.getLocalPaintStyles().map(function(s) {
    return {
      id: s.id,
      name: s.name,
      paints: s.paints.map(function(p) {
        return { type: p.type, color: p.color, opacity: p.opacity };
      })
    };
  });
  var textStyles = figma.getLocalTextStyles().map(function(s) {
    return {
      id: s.id,
      name: s.name,
      fontFamily: s.fontName.family,
      fontStyle: s.fontName.style,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight.unit === 'PIXELS' ? s.lineHeight.value : null
    };
  });
  var effectStyles = figma.getLocalEffectStyles().map(function(s) {
    return {
      id: s.id,
      name: s.name,
      effects: s.effects.map(function(e) {
        return { type: e.type, color: e.color, offset: e.offset, radius: e.radius, spread: e.spread };
      })
    };
  });
  var gridStyles = figma.getLocalGridStyles().map(function(s) {
    return { id: s.id, name: s.name };
  });
  return { paint: paintStyles, text: textStyles, effect: effectStyles, grid: gridStyles };
}
```

- [ ] **Step 2: Add get_local_components command**

```javascript
case 'get_local_components': {
  var components = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
  var componentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });
  var setMap = {};
  componentSets.forEach(function(cs) {
    var variantKeys = {};
    cs.children.forEach(function(variant) {
      var props = variant.variantProperties;
      if (props) {
        Object.keys(props).forEach(function(key) {
          if (!variantKeys[key]) { variantKeys[key] = []; }
          if (variantKeys[key].indexOf(props[key]) === -1) {
            variantKeys[key].push(props[key]);
          }
        });
      }
    });
    setMap[cs.id] = {
      id: cs.id,
      name: cs.name,
      page: cs.parent && cs.parent.type === 'PAGE' ? cs.parent.name : null,
      variants: variantKeys,
      properties: Object.keys(cs.componentPropertyDefinitions || {}).map(function(key) {
        var def = cs.componentPropertyDefinitions[key];
        return { name: key, type: def.type, default: def.defaultValue };
      })
    };
  });
  var standaloneComponents = components.filter(function(c) {
    return !c.parent || c.parent.type !== 'COMPONENT_SET';
  }).map(function(c) {
    return {
      id: c.id,
      name: c.name,
      page: c.parent && c.parent.type === 'PAGE' ? c.parent.name : null,
      variants: null,
      properties: Object.keys(c.componentPropertyDefinitions || {}).map(function(key) {
        var def = c.componentPropertyDefinitions[key];
        return { name: key, type: def.type, default: def.defaultValue };
      })
    };
  });
  var instances = figma.root.findAllWithCriteria({ types: ['INSTANCE'] });
  var remoteMap = {};
  instances.forEach(function(inst) {
    var main = inst.mainComponent;
    if (main && main.remote) {
      var key = main.key;
      if (!remoteMap[key]) {
        remoteMap[key] = {
          key: key,
          name: main.name,
          library: main.parent && main.parent.name ? main.parent.name : 'Unknown',
          instancesCount: 0
        };
      }
      remoteMap[key].instancesCount++;
    }
  });
  var localAll = Object.values(setMap).concat(standaloneComponents);
  var remoteAll = Object.values(remoteMap);
  return {
    local: localAll,
    remote: remoteAll
  };
}
```

- [ ] **Step 3: Add search_nodes command with limit parameter**

Includes a `limit` parameter (default 50). When results exceed the limit, truncate and add `truncated: true`:

```javascript
case 'search_nodes': {
  var namePattern = params.name || null;
  var typeFilter = params.type || null;
  var pageFilter = params.pageId || null;
  var searchLimit = params.limit || 50;
  var searchPages = pageFilter
    ? [await figma.getNodeByIdAsync(pageFilter)].filter(Boolean)
    : figma.root.children;
  var matches = [];
  var stopped = false;
  searchPages.forEach(function(page) {
    if (stopped) { return; }
    if (page.type !== 'PAGE') { return; }
    var nodes = page.findAll(function(node) {
      if (typeFilter && node.type !== typeFilter) { return false; }
      if (namePattern) {
        var regex = new RegExp(namePattern.replace(/\*/g, '.*'), 'i');
        if (!regex.test(node.name)) { return false; }
      }
      return true;
    });
    nodes.forEach(function(node) {
      if (stopped) { return; }
      matches.push({
        id: node.id,
        name: node.name,
        type: node.type,
        page: page.name,
        parent: node.parent ? node.parent.name + ' [' + node.parent.id + ']' : null,
        width: node.width,
        height: node.height
      });
      if (matches.length > searchLimit) {
        stopped = true;
      }
    });
  });
  var truncated = matches.length > searchLimit;
  if (truncated) {
    matches = matches.slice(0, searchLimit);
  }
  return { results: matches, truncated: truncated };
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/figma-plugin/code.js
git commit -m "feat(plugin): add design system + search commands — get_styles, get_local_components, search_nodes"
```

---

### Task 8: Mock Plugin — Handle M2 Commands

**Files:**
- Modify: `test/mocks/mock-plugin.ts`

- [ ] **Step 1: Add M2 command handlers to mock plugin**

Add fixture imports and extend the `handleBroadcast` function's if/else chain with all M2 commands. The mock plugin uses `handleBroadcast` with if/else on `cmd.command` (not switch/case).

Add these imports at the top of the file:

```typescript
import cardFixture from '../fixtures/card-node-raw.json'
import pageLayoutFixture from '../fixtures/page-layout-raw.json'
import stylesFixture from '../fixtures/styles-raw.json'
import componentsFixture from '../fixtures/components-raw.json'
```

Replace the existing `handleBroadcast` function body to add all M2 handlers while preserving the existing `get_document_info` handler:

```typescript
  const handleBroadcast = (
    socket: WebSocket,
    cmd: CommandMessage,
  ): void => {
    let result: unknown

    if (cmd.command === 'get_document_info') {
      result = {
        name: documentName,
        currentPage: {
          id: 'page:1',
          name: pageName,
        },
      }
    } else if (cmd.command === 'get_selection') {
      result = [{ id: '1:42', name: 'Card', type: 'FRAME' }]
    } else if (cmd.command === 'get_node') {
      result = cardFixture
    } else if (cmd.command === 'get_nodes') {
      result = [cardFixture]
    } else if (cmd.command === 'get_page_layout') {
      result = { pageName: 'Page 1', frames: pageLayoutFixture.frames }
    } else if (cmd.command === 'get_pages') {
      result = [
        { id: '0:1', name: 'Homepage', isCurrent: true, childCount: 3 },
        { id: '0:2', name: 'Components', isCurrent: false, childCount: 15 },
      ]
    } else if (cmd.command === 'get_styles') {
      result = stylesFixture
    } else if (cmd.command === 'get_local_components') {
      result = componentsFixture
    } else if (cmd.command === 'search_nodes') {
      result = {
        results: [
          { id: '1:42', name: 'Card', type: 'FRAME', page: 'Homepage', parent: 'Root [0:1]', width: 320, height: 200 },
        ],
        truncated: false,
      }
    } else if (cmd.command === 'export_node') {
      result = { format: 'PNG', scale: 1, data: 'mockbase64data' }
    } else {
      const reply: ChannelMessage = {
        type: 'message',
        channel,
        message: { id: cmd.id, command: cmd.command, error: 'Unknown command' },
      }
      socket.send(JSON.stringify(reply))

      return
    }

    const resolved: CommandMessage = {
      id: cmd.id,
      command: cmd.command,
      result,
    }

    const reply: ChannelMessage = {
      type: 'message',
      channel,
      message: resolved,
    }

    socket.send(JSON.stringify(reply))
  }
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add test/mocks/mock-plugin.ts
git commit -m "test(mocks): add M2 command handlers to mock plugin"
```

---

## Phase 3: MCP Tools

### Task 9: MCP Tools — inspect + inspect_page_layout (RED → GREEN)

**Files:**
- Create: `packages/server/src/tools/read.ts`
- Create: `test/server/tools/read.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write test for handleInspect**

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import type { Server } from 'bun'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import { startRelay, stopRelay } from '../../../packages/relay/src/relay'
import { handleInspect, handleInspectPageLayout } from '../../../packages/server/src/tools/read'
import cardFixture from '../../fixtures/card-node-raw.json'
import pageLayoutFixture from '../../fixtures/page-layout-raw.json'

describe('handleInspect', () => {
  it('returns YAML for a specific node', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_node') { return Promise.resolve(cardFixture) }
        if (cmd === 'get_selection') { return Promise.resolve([{ id: '1:42', name: 'Card', type: 'FRAME' }]) }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspect({ nodeId: '1:42' }, mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('# Card [1:42]')
    expect(result.content[0].text).toContain('auto-layout: V')
    expect(result.content[0].text).toContain('font: Inter/SemiBold/18')
  })

  it('uses current selection when no nodeId', async () => {
    const calls: string[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        calls.push(cmd)
        if (cmd === 'get_selection') {
          return Promise.resolve([{ id: '1:42', name: 'Card', type: 'FRAME' }])
        }
        if (cmd === 'get_node') { return Promise.resolve(cardFixture) }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    await handleInspect({}, mockClient)

    expect(calls).toContain('get_selection')
    expect(calls).toContain('get_node')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleInspect({}, mockClient)

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

- [ ] **Step 2: Write test for handleInspectPageLayout**

```typescript
describe('handleInspectPageLayout', () => {
  it('returns YAML with page name and frames', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_page_layout') { return Promise.resolve(pageLayoutFixture) }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectPageLayout(mockClient)

    expect(result.content[0].text).toContain('# Homepage')
    expect(result.content[0].text).toContain('3 top-level frames')
    expect(result.content[0].text).toContain('name: Header')
    expect(result.content[0].text).toContain('position: [0, 0]')
  })
})
```

- [ ] **Step 3: Run tests — verify RED**

Run: `bun test test/server/tools/read.test.ts`
Expected: FAIL — `read.ts` does not exist

- [ ] **Step 4: Implement handleInspect and handleInspectPageLayout**

Create `packages/server/src/tools/read.ts`:

```typescript
import type { FigmaClient } from '../figma-client'
import { parseNode, toInspectYaml, toPageLayoutYaml, toFullJson } from '../parser'
import YAML from 'yaml'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

export const handleInspect = async (
  { nodeId }: { nodeId?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  let targetId = nodeId

  if (targetId === undefined) {
    const selection = await client.sendCommand('get_selection', {}) as Array<{ id: string; name: string; type: string }> | null
    if (selection === null || selection.length === 0) {
      return { content: [{ type: 'text', text: 'No node selected. Select a node in Figma or provide a nodeId.' }] }
    }
    targetId = selection[0].id
  }

  const raw = await client.sendCommand('get_node', { nodeId: targetId }) as Record<string, unknown> | null
  if (raw === null) {
    return { content: [{ type: 'text', text: `Node not found: ${targetId}` }] }
  }

  const parsed = parseNode(raw)
  const yaml = toInspectYaml(parsed)

  return { content: [{ type: 'text', text: yaml }] }
}

export const handleInspectPageLayout = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const raw = await client.sendCommand('get_page_layout', {}) as { pageName: string; frames: Array<Record<string, unknown>> } | null
  if (raw === null) {
    return { content: [{ type: 'text', text: 'Failed to get page layout from plugin.' }] }
  }

  const yaml = toPageLayoutYaml(raw)

  return { content: [{ type: 'text', text: yaml }] }
}

export const handleGetNodeInfo = async (
  { nodeId, depth }: { nodeId: string; depth?: number },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const raw = await client.sendCommand('get_node', { nodeId }) as Record<string, unknown> | null
  if (raw === null) {
    return { content: [{ type: 'text', text: `Node not found: ${nodeId}` }] }
  }

  const json = toFullJson(raw, depth)

  return { content: [{ type: 'text', text: json }] }
}

export const handleGetNodesInfo = async (
  { nodeIds, depth }: { nodeIds: string[]; depth?: number },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const raw = await client.sendCommand('get_nodes', { nodeIds }) as Array<Record<string, unknown>> | null
  if (raw === null) {
    return { content: [{ type: 'text', text: 'Failed to get nodes from plugin.' }] }
  }

  const json = JSON.stringify(raw.map((node) => JSON.parse(toFullJson(node, depth))), null, 2)

  return { content: [{ type: 'text', text: json }] }
}

export const handleListPages = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const raw = await client.sendCommand('get_pages', {}) as Array<{ id: string; name: string; isCurrent: boolean; childCount: number }> | null
  if (raw === null) {
    return { content: [{ type: 'text', text: 'Failed to get pages from plugin.' }] }
  }

  const header = `# ${raw.length} pages\n\n`
  const yamlStr = YAML.stringify(raw.map((p) => ({
    id: p.id,
    name: p.name,
    current: p.isCurrent,
    frames: p.childCount,
  })))

  return { content: [{ type: 'text', text: header + yamlStr }] }
}
```

- [ ] **Step 5: Run tests — verify GREEN**

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/tools/read.ts test/server/tools/read.test.ts
git commit -m "feat(server): add inspect and inspect_page_layout tools"
```

---

### Task 10: MCP Tools — get_node_info, get_nodes_info, list_pages (RED → GREEN)

**Files:**
- Modify: `packages/server/src/tools/read.ts`
- Modify: `test/server/tools/read.test.ts`

- [ ] **Step 1: Write tests for handleGetNodeInfo, handleGetNodesInfo, handleListPages**

```typescript
import { handleGetNodeInfo, handleGetNodesInfo, handleListPages } from '../../../packages/server/src/tools/read'

describe('handleGetNodeInfo', () => {
  it('sends get_node command and returns JSON via toFullJson', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_node') { return Promise.resolve(cardFixture) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleGetNodeInfo({ nodeId: '1:42' }, mockClient)

    expect(result.content[0].type).toBe('text')
    const json = JSON.parse(result.content[0].text)
    expect(json.id).toBe('1:42')
    expect(json.layoutMode).toBe('VERTICAL')
  })

  it('respects depth parameter', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_node') { return Promise.resolve(cardFixture) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleGetNodeInfo({ nodeId: '1:42', depth: 0 }, mockClient)
    const json = JSON.parse(result.content[0].text)

    expect(json.children[0]).toEqual({ id: '1:43', name: 'Title', type: 'TEXT' })
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleGetNodeInfo({ nodeId: '1:42' }, mockClient)

    expect(result.content[0].text).toContain('Not connected')
  })
})

describe('handleGetNodesInfo', () => {
  it('sends get_nodes command and returns JSON array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_nodes') { return Promise.resolve([cardFixture]) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleGetNodesInfo({ nodeIds: ['1:42'] }, mockClient)

    expect(result.content[0].type).toBe('text')
    const json = JSON.parse(result.content[0].text)
    expect(Array.isArray(json)).toBe(true)
    expect(json[0].id).toBe('1:42')
  })
})

describe('handleListPages', () => {
  it('sends get_pages command and returns YAML', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_pages') {
          return Promise.resolve([
            { id: '0:1', name: 'Homepage', isCurrent: true, childCount: 3 },
            { id: '0:2', name: 'Components', isCurrent: false, childCount: 15 },
          ])
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleListPages(mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Homepage')
    expect(result.content[0].text).toContain('Components')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

Run: `bun test test/server/tools/read.test.ts`
Expected: FAIL — handlers not yet defined

- [ ] **Step 3: Implement handlers**

These handlers are already implemented in `read.ts` from Task 9 Step 4 (`handleGetNodeInfo`, `handleGetNodesInfo`, `handleListPages` are included in the full file).

- [ ] **Step 4: Run tests — verify GREEN**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/read.ts test/server/tools/read.test.ts
git commit -m "feat(server): add get_node_info, get_nodes_info, list_pages tools"
```

---

### Task 11: MCP Tools — inspect_styles + inspect_components (RED → GREEN)

**Files:**
- Create: `packages/server/src/tools/design-system.ts`
- Create: `test/server/tools/design-system.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import { handleInspectStyles, handleInspectComponents } from '../../../packages/server/src/tools/design-system'
import stylesFixture from '../../fixtures/styles-raw.json'
import componentsFixture from '../../fixtures/components-raw.json'

describe('handleInspectStyles', () => {
  it('sends get_styles and returns YAML via toStylesYaml', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_styles') { return Promise.resolve(stylesFixture) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectStyles({}, mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('# 5 styles')
    expect(result.content[0].text).toContain('color: "#3B82F6"')
  })

  it('filters by type when provided', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_styles') { return Promise.resolve(stylesFixture) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectStyles({ type: 'text' }, mockClient)

    expect(result.content[0].text).toContain('font: Inter/Bold/32')
    expect(result.content[0].text).not.toContain('color: "#3B82F6"')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleInspectStyles({}, mockClient)

    expect(result.content[0].text).toContain('Not connected')
  })
})

describe('handleInspectComponents', () => {
  it('sends get_local_components and returns YAML via toComponentsYaml', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_local_components') { return Promise.resolve(componentsFixture) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectComponents({}, mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('# 2 local components')
    expect(result.content[0].text).toContain('name: "Button"')
  })

  it('filters by query when provided', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'get_local_components') { return Promise.resolve(componentsFixture) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectComponents({ query: 'Button' }, mockClient)

    expect(result.content[0].text).toContain('name: "Button"')
    expect(result.content[0].text).not.toContain('name: "Avatar"')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleInspectComponents({}, mockClient)

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

Run: `bun test test/server/tools/design-system.test.ts`
Expected: FAIL — `design-system.ts` does not exist

- [ ] **Step 3: Implement handlers**

Create `packages/server/src/tools/design-system.ts`:

```typescript
import type { FigmaClient } from '../figma-client'
import { toStylesYaml, toComponentsYaml } from '../parser'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

export const handleInspectStyles = async (
  { type }: { type?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const raw = await client.sendCommand('get_styles', {}) as {
    paint: Array<Record<string, unknown>>
    text: Array<Record<string, unknown>>
    effect: Array<Record<string, unknown>>
    grid: Array<Record<string, unknown>>
  } | null

  if (raw === null) {
    return { content: [{ type: 'text', text: 'Failed to get styles from plugin.' }] }
  }

  if (type !== undefined) {
    // zero out non-matching style groups
    const filtered = { paint: [], text: [], effect: [], grid: [], ...{ [type]: raw[type as keyof typeof raw] } }

    return { content: [{ type: 'text', text: toStylesYaml(filtered) }] }
  }

  return { content: [{ type: 'text', text: toStylesYaml(raw) }] }
}

export const handleInspectComponents = async (
  { query }: { query?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const raw = await client.sendCommand('get_local_components', {}) as {
    local: Array<Record<string, unknown>>
    remote: Array<Record<string, unknown>>
  } | null

  if (raw === null) {
    return { content: [{ type: 'text', text: 'Failed to get components from plugin.' }] }
  }

  if (query !== undefined) {
    const regex = new RegExp(query.replace(/\*/g, '.*'), 'i')
    const filtered = {
      local: raw.local.filter((c) => regex.test(c.name as string)),
      remote: raw.remote.filter((c) => regex.test(c.name as string)),
    }

    return { content: [{ type: 'text', text: toComponentsYaml(filtered) }] }
  }

  return { content: [{ type: 'text', text: toComponentsYaml(raw) }] }
}
```

- [ ] **Step 4: Run tests — verify GREEN**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/design-system.ts test/server/tools/design-system.test.ts
git commit -m "feat(server): add inspect_styles and inspect_components tools"
```

---

### Task 12: MCP Tools — search (RED → GREEN)

**Files:**
- Create: `packages/server/src/tools/search.ts`
- Create: `test/server/tools/search.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import { handleSearch } from '../../../packages/server/src/tools/search'

describe('handleSearch', () => {
  it('sends search_nodes with name/type/pageId params', async () => {
    const sentParams: Record<string, unknown>[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'search_nodes') {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({
            results: [
              { id: '1:42', name: 'Card', type: 'FRAME', page: 'Homepage', parent: 'Root [0:1]', width: 320, height: 200 },
            ],
            truncated: false,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleSearch({ name: 'Card', type: 'FRAME' }, mockClient)

    expect(sentParams[0]).toEqual({ name: 'Card', type: 'FRAME', limit: 50 })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Card')
  })

  it('passes limit param to plugin command', async () => {
    const sentParams: Record<string, unknown>[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'search_nodes') {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({ results: [], truncated: false })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    await handleSearch({ name: '*', limit: 10 }, mockClient)

    expect(sentParams[0]).toEqual({ name: '*', limit: 10 })
  })

  it('includes truncated warning in output when results truncated', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'search_nodes') {
          return Promise.resolve({
            results: [
              { id: '1:1', name: 'Node', type: 'FRAME', page: 'Page', parent: 'Root [0:1]', width: 100, height: 100 },
            ],
            truncated: true,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleSearch({ name: '*' }, mockClient)

    expect(result.content[0].text).toContain('truncated')
  })

  it('handles empty results gracefully', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'search_nodes') { return Promise.resolve({ results: [], truncated: false }) }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleSearch({ name: 'nonexistent' }, mockClient)

    expect(result.content[0].text).toContain('0')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleSearch({ name: 'Card' }, mockClient)

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

Run: `bun test test/server/tools/search.test.ts`
Expected: FAIL — `search.ts` does not exist

- [ ] **Step 3: Implement toSearchYaml in parser and handleSearch**

Add `toSearchYaml` to `packages/server/src/parser.ts`:

```typescript
export const toSearchYaml = (
  results: SearchResult[],
  truncated: boolean,
): string => {
  const summary = `# ${results.length} results${truncated ? ' (truncated)' : ''}`
  const data = { results: results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    page: r.page,
    parent: r.parent,
    size: r.size,
  })) }

  return `${summary}\n\n${YAML.stringify(data)}`
}
```

Also add the import for `SearchResult` at the top of `parser.ts`:

```typescript
import type { ParsedNode, InspectSummary, PageFrameInfo, SearchResult } from '@figma-agent-bridge/shared'
```

Create `packages/server/src/tools/search.ts`:

```typescript
import type { FigmaClient } from '../figma-client'
import { toSearchYaml } from '../parser'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

export const handleSearch = async (
  params: { name?: string; type?: string; pageId?: string; limit?: number },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text', text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const pluginParams: Record<string, unknown> = {}
  if (params.name !== undefined) { pluginParams.name = params.name }
  if (params.type !== undefined) { pluginParams.type = params.type }
  if (params.pageId !== undefined) { pluginParams.pageId = params.pageId }
  pluginParams.limit = params.limit ?? 50

  const raw = await client.sendCommand('search_nodes', pluginParams) as {
    results: Array<{ id: string; name: string; type: string; page: string; parent: string; width: number; height: number }>
    truncated: boolean
  } | null

  if (raw === null) {
    return { content: [{ type: 'text', text: 'Search failed: no response from plugin.' }] }
  }

  const mapped = raw.results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    page: r.page,
    parent: r.parent,
    size: [r.width, r.height] as [number, number],
  }))

  return { content: [{ type: 'text', text: toSearchYaml(mapped, raw.truncated) }] }
}
```

- [ ] **Step 4: Run tests — verify GREEN**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/search.ts test/server/tools/search.test.ts packages/server/src/parser.ts
git commit -m "feat(server): add search tool with YAML output and result limit"
```

---

### Task 13: MCP Tools — export (RED → GREEN)

**Files:**
- Create: `packages/server/src/tools/export.ts`
- Create: `test/server/tools/export.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import { handleExport } from '../../../packages/server/src/tools/export'

describe('handleExport', () => {
  it('sends export_node and returns MCP image content for PNG', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'export_node') {
          return Promise.resolve({
            format: 'PNG',
            scale: 1,
            data: 'iVBORw0KGgoAAAANS',
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleExport({ nodeId: '1:42' }, mockClient)

    expect(result.content[0].type).toBe('image')
    expect(result.content[0].data).toBe('iVBORw0KGgoAAAANS')
    expect(result.content[0].mimeType).toBe('image/png')
  })

  it('returns MCP image content for JPG', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'export_node') {
          return Promise.resolve({
            format: 'JPG',
            scale: 2,
            data: '/9j/4AAQSkZJRg',
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleExport({ nodeId: '1:42', format: 'JPG', scale: 2 }, mockClient)

    expect(result.content[0].type).toBe('image')
    expect(result.content[0].data).toBe('/9j/4AAQSkZJRg')
    expect(result.content[0].mimeType).toBe('image/jpeg')
  })

  it('returns MCP text content for SVG', async () => {
    const svgString = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red"/></svg>'
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd) => {
        if (cmd === 'export_node') {
          return Promise.resolve({
            format: 'SVG',
            scale: 1,
            data: svgString,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleExport({ nodeId: '1:42', format: 'SVG' }, mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe(svgString)
  })

  it('defaults to PNG format and scale 1', async () => {
    const sentParams: Record<string, unknown>[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'export_node') {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({ format: 'PNG', scale: 1, data: 'abc' })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    await handleExport({ nodeId: '1:42' }, mockClient)

    expect(sentParams[0].format).toBe('PNG')
    expect(sentParams[0].scale).toBe(1)
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleExport({ nodeId: '1:42' }, mockClient)

    expect(result.content[0].text).toContain('Not connected')
  })
})
```

- [ ] **Step 2: Run tests — verify RED**

Run: `bun test test/server/tools/export.test.ts`
Expected: FAIL — `export.ts` does not exist

- [ ] **Step 3: Implement handleExport**

Create `packages/server/src/tools/export.ts`:

```typescript
import type { FigmaClient } from '../figma-client'

type ExportParams = {
  nodeId: string
  format?: 'PNG' | 'SVG' | 'PDF' | 'JPG'
  scale?: number
}

const MIME_MAP: Record<string, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
}

export const handleExport = async (params: ExportParams, client: FigmaClient) => {
  if (!client.isConnected()) {
    return { content: [{ type: 'text' as const, text: 'Not connected to Figma. Use connect tool first.' }] }
  }

  const format = params.format ?? 'PNG'
  const scale = params.scale ?? 1

  const result = await client.sendCommand('export_node', {
    nodeId: params.nodeId,
    format,
    scale,
  }) as { format: string; scale: number; data: string } | null

  if (result === null) {
    return { content: [{ type: 'text' as const, text: 'Export failed: no response from plugin.' }] }
  }

  // SVG returns text content
  if (format === 'SVG') {
    return {
      content: [{ type: 'text' as const, text: result.data }],
    }
  }

  // PNG, JPG, PDF return binary as base64 with MCP image content type
  const mimeType = MIME_MAP[format] ?? 'application/octet-stream'

  return {
    content: [{ type: 'image' as const, data: result.data, mimeType }],
  }
}
```

- [ ] **Step 4: Run tests — verify GREEN**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/export.ts test/server/tools/export.test.ts
git commit -m "feat(server): add export tool with MCP image content type"
```

---

### Task 14: Register All Tools in MCP Server

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Register all M2 tools using schemas from shared/schemas.ts**

```typescript
import { handleInspect, handleInspectPageLayout, handleGetNodeInfo, handleGetNodesInfo, handleListPages } from './tools/read'
import { handleInspectStyles, handleInspectComponents } from './tools/design-system'
import { handleSearch } from './tools/search'
import { handleExport } from './tools/export'
import {
  inspectParamsSchema,
  inspectPageLayoutParamsSchema,
  inspectStylesParamsSchema,
  inspectComponentsParamsSchema,
  searchParamsSchema,
  getNodeInfoParamsSchema,
  getNodesInfoParamsSchema,
  listPagesParamsSchema,
  exportParamsSchema,
} from '@figma-agent-bridge/shared'

server.tool(
  'inspect',
  inspectParamsSchema.shape,
  async ({ nodeId }) => handleInspect({ nodeId }, client),
)

server.tool(
  'inspect_page_layout',
  inspectPageLayoutParamsSchema.shape,
  async () => handleInspectPageLayout(client),
)

server.tool(
  'inspect_styles',
  inspectStylesParamsSchema.shape,
  async ({ type }) => handleInspectStyles({ type }, client),
)

server.tool(
  'inspect_components',
  inspectComponentsParamsSchema.shape,
  async ({ query }) => handleInspectComponents({ query }, client),
)

server.tool(
  'search',
  searchParamsSchema.shape,
  async (params) => handleSearch(params, client),
)

server.tool(
  'get_node_info',
  getNodeInfoParamsSchema.shape,
  async ({ nodeId, depth }) => handleGetNodeInfo({ nodeId, depth }, client),
)

server.tool(
  'get_nodes_info',
  getNodesInfoParamsSchema.shape,
  async ({ nodeIds, depth }) => handleGetNodesInfo({ nodeIds, depth }, client),
)

server.tool(
  'list_pages',
  listPagesParamsSchema.shape,
  async () => handleListPages(client),
)

server.tool(
  'export',
  exportParamsSchema.shape,
  async (params) => handleExport(params, client),
)
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): register all M2 tools in MCP server using shared schemas"
```

---

## Phase 4: Integration

### Task 15: E2E Roundtrip Tests

**Files:**
- Modify: `test/integration/e2e-roundtrip.test.ts`

- [ ] **Step 1: Add M2 e2e tests**

Test the full roundtrip: relay -> mock plugin -> MCP tool handler:

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import type { Server } from 'bun'
import type { FigmaClient } from '../../packages/server/src/figma-client'
import { startRelay, stopRelay } from '../../packages/relay/src/relay'
import { createFigmaClient } from '../../packages/server/src/figma-client'
import { createMockPlugin } from '../mocks/mock-plugin'
import { handleConnect } from '../../packages/server/src/tools/session'
import { handleInspect, handleInspectPageLayout, handleGetNodeInfo, handleListPages } from '../../packages/server/src/tools/read'
import { handleInspectStyles, handleInspectComponents } from '../../packages/server/src/tools/design-system'
import { handleSearch } from '../../packages/server/src/tools/search'

const M2_TEST_PORT = 3098
const M2_RELAY_URL = `ws://localhost:${M2_TEST_PORT}`
const M2_TEST_CHANNEL = 'e2e-m2-test-channel'

describe('M2 read tools e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null = null

  beforeEach(async () => {
    server = startRelay(M2_TEST_PORT)
    client = createFigmaClient(M2_RELAY_URL)

    plugin = createMockPlugin({
      relayUrl: M2_RELAY_URL,
      channel: M2_TEST_CHANNEL,
      documentName: 'Mock Design',
    })

    await plugin.start()
    await handleConnect({ channel: M2_TEST_CHANNEL }, client)
  })

  afterEach(async () => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('inspect returns YAML for mock document', async () => {
    const result = await handleInspect({ nodeId: '1:42' }, client)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('# Card')
    expect(result.content[0].text).toContain('auto-layout: V')
  })

  it('get_node_info returns JSON with depth control', async () => {
    const result = await handleGetNodeInfo({ nodeId: '1:42', depth: 0 }, client)
    const json = JSON.parse(result.content[0].text)

    expect(json.id).toBe('1:42')
    expect(json.children[0]).toEqual({ id: '1:43', name: 'Title', type: 'TEXT' })
  })

  it('inspect_styles returns design system YAML', async () => {
    const result = await handleInspectStyles({}, client)

    expect(result.content[0].text).toContain('styles')
  })

  it('inspect_components returns component catalog', async () => {
    const result = await handleInspectComponents({}, client)

    expect(result.content[0].text).toContain('local')
  })

  it('search finds nodes by name pattern', async () => {
    const result = await handleSearch({ name: 'Card' }, client)

    expect(result.content[0].text).toContain('Card')
  })

  it('list_pages returns all pages in YAML', async () => {
    const result = await handleListPages(client)

    expect(result.content[0].text).toContain('Homepage')
  })
})
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS (existing + new)

- [ ] **Step 3: Run linter and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add test/integration/e2e-roundtrip.test.ts
git commit -m "test(e2e): add M2 read tools roundtrip tests"
```

---

### Task 16: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Run linter + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 3: Verify test count**

Count total tests. M2 should add approximately:
- ~15 parser tests (Task 2-5)
- ~6 read tool tests (Task 9-10)
- ~4 design system tool tests (Task 11)
- ~3 search tool tests (Task 12)
- ~3 export tool tests (Task 13)
- ~6 e2e tests (Task 15)
- Total: ~37 new tests

---

## Task Dependency Graph

```
Task 1 (types + fixtures + schemas) ──── must be first
    │
    ├── Task 2 (parseNode + toInspectYaml) ──┐
    ├── Task 3 (toFullJson)                  ├── parser complete
    ├── Task 4 (toPageLayoutYaml)            │
    └── Task 5 (toStylesYaml + toComponentsYaml) ──┘
                                                │
    Task 6 (plugin refactor + read commands) ───┤── can parallel with parser
    Task 7 (plugin design system + search) ─────┤
                                                │
    Task 8 (mock plugin) ──────────────────── after Tasks 6-7
                                                │
    ├── Task 9 (inspect tools) ──────────── after parser + mock
    ├── Task 10 (get tools + list_pages) ── after parser + mock
    ├── Task 11 (design system tools) ──── after parser + mock
    ├── Task 12 (search tool) ──────────── after parser + mock
    └── Task 13 (export tool) ──────────── after mock
                                                │
    Task 14 (register tools) ──────────────── after Tasks 9-13
    Task 15 (e2e tests) ──────────────────── after Task 14
    Task 16 (final verification) ──────────── last
```

**Parallelizable groups:**
- Tasks 2-5 (parser functions) can run in parallel
- Tasks 6-7 (plugin commands) can run in parallel with Tasks 2-5
- Tasks 9-13 (MCP tools) can run in parallel after parser + mock are done
