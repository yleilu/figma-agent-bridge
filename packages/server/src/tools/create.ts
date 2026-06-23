import type { FigmaClient } from '../figma-client'
import type {
  CreateNodeSpec,
  CreateTreeNodeSpec,
} from '@figma-agent-bridge/shared'
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
  const fills = converted.fills as
    | { styleName?: string }[]
    | undefined
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
  const strokes = converted.strokes as
    | { styleName?: string }[]
    | undefined
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
  const effects = converted.effects as
    | { styleName?: string }[]
    | undefined
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
  const text = converted.text as
    | { font?: { styleName?: string } }
    | undefined
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
  if (spec.minWidth !== undefined) {
    result.minWidth = spec.minWidth
  }
  if (spec.maxWidth !== undefined) {
    result.maxWidth = spec.maxWidth
  }
  if (spec.minHeight !== undefined) {
    result.minHeight = spec.minHeight
  }
  if (spec.maxHeight !== undefined) {
    result.maxHeight = spec.maxHeight
  }

  // Parse fills from expressions to paint objects
  if (spec.fills !== undefined) {
    result.fills = parseFillExpressions(spec.fills)
  }

  // Parse strokes from expressions to paint objects
  if (spec.strokes !== undefined) {
    result.strokes = parseFillExpressions(spec.strokes)
  }

  // Stroke properties
  if (spec.strokeWeight !== undefined) {
    result.strokeWeight = spec.strokeWeight
  }
  if (spec.strokeAlign !== undefined) {
    result.strokeAlign = spec.strokeAlign
  }
  if (spec.strokeDash !== undefined) {
    result.strokeDash = spec.strokeDash
  }

  // Radius
  if (spec.radius !== undefined) {
    result.radius = spec.radius
  }

  // Scalar visual properties
  if (spec.opacity !== undefined) {
    result.opacity = spec.opacity
  }
  if (spec.blendMode !== undefined) {
    result.blendMode = spec.blendMode
  }
  if (spec.rotation !== undefined) {
    result.rotation = spec.rotation
  }
  if (spec.visible !== undefined) {
    result.visible = spec.visible
  }
  if (spec.clipsContent !== undefined) {
    result.clipsContent = spec.clipsContent
  }

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
    if (spec.text.align !== undefined) {
      text.align = spec.text.align
    }
    if (spec.text.valign !== undefined) {
      text.valign = spec.text.valign
    }
    if (spec.text.color !== undefined) {
      const parsed = parseColorExpression(spec.text.color)
      if (parsed) {
        text.color = parsed
      }
    }
    if (spec.text.lineHeight !== undefined) {
      text.lineHeight = parseLineHeightExpression(
        spec.text.lineHeight,
      )
    }
    if (spec.text.letterSpacing !== undefined) {
      text.letterSpacing = parseLetterSpacingExpression(
        spec.text.letterSpacing,
      )
    }
    if (spec.text.decoration !== undefined) {
      text.decoration = spec.text.decoration
    }
    if (spec.text.case !== undefined) {
      text.case = spec.text.case
    }
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
  if (spec.pointCount !== undefined) {
    result.pointCount = spec.pointCount
  }
  if (spec.innerRadius !== undefined) {
    result.innerRadius = spec.innerRadius
  }
  if (spec.arcData !== undefined) {
    result.arcData = spec.arcData
  }
  if (spec.vectorPaths !== undefined) {
    result.vectorPaths = spec.vectorPaths
  }
  if (spec.sectionContentsHidden !== undefined) {
    result.sectionContentsHidden =
      spec.sectionContentsHidden
  }
  if (spec.booleanOperation !== undefined) {
    result.booleanOperation = spec.booleanOperation
  }

  // TEXT_PATH properties
  if (spec.vectorNodeId !== undefined) {
    result.vectorNodeId = spec.vectorNodeId
  }
  if (spec.startSegment !== undefined) {
    result.startSegment = spec.startSegment
  }
  if (spec.startPosition !== undefined) {
    result.startPosition = spec.startPosition
  }

  // TRANSFORM_GROUP properties
  if (spec.modifiers !== undefined) {
    result.modifiers = spec.modifiers
  }

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

  const nodeSpec = spec as CreateNodeSpec & {
    children?: CreateTreeNodeSpec[]
  }
  const result = convertNodeSpec(nodeSpec)

  if (nodeSpec.children !== undefined) {
    result.children = nodeSpec.children.map(
      convertTreeNodeSpec,
    )
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
    const resolveTreeStyles = (
      node: Record<string, unknown>,
    ) => {
      if ('type' in node) {
        resolveStyleIds(node, styleCache)
        const children = node.children as
          | Record<string, unknown>[]
          | undefined
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
