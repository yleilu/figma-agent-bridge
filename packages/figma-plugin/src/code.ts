figma.showUI(__html__, {
  width: 340,
  height: 280,
  title: 'Agent Bridge',
  themeColors: true,
})

figma.ui.postMessage({
  type: 'file-name',
  fileName: figma.root.name,
})

type PluginMessage =
  | {
      type: 'execute-command'
      id: string
      command: string
      params: Record<string, unknown>
    }
  | { type: 'storage-get'; key: string }
  | { type: 'storage-set'; key: string; value: unknown }
  | { type: 'storage-delete'; key: string }

const summarizeChildren = (
  node: BaseNode & { children?: readonly BaseNode[] },
) =>
  'children' in node && node.children
    ? node.children.map(child => ({
        id: child.id,
        name: child.name,
        type: child.type,
      }))
    : []

const exportNodeDocument = async (
  node: BaseNode,
): Promise<unknown> => {
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      children: summarizeChildren(node),
    }
  }
  const exported = await (node as SceneNode).exportAsync({
    format: 'JSON_REST_V1',
  })
  if (
    typeof exported === 'object' &&
    exported !== null &&
    (exported as Record<string, unknown>).document
  ) {
    return (exported as Record<string, unknown>).document
  }
  throw new Error(
    'exportAsync returned unexpected type: ' +
      typeof exported,
  )
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  const CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let b64 = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i++]
    const b1 = i < bytes.length ? bytes[i++] : 0
    const b2 = i < bytes.length ? bytes[i++] : 0
    b64 += CHARS[b0 >> 2]
    b64 += CHARS[((b0 & 3) << 4) | (b1 >> 4)]
    b64 += CHARS[((b1 & 15) << 2) | (b2 >> 6)]
    b64 += CHARS[b2 & 63]
  }
  const pad = bytes.length % 3
  if (pad === 1) {
    b64 = b64.slice(0, -2) + '=='
  } else if (pad === 2) {
    b64 = b64.slice(0, -1) + '='
  }
  return b64
}

const bytesToString = (bytes: Uint8Array): string => {
  let result = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end =
      i + chunkSize < bytes.length
        ? i + chunkSize
        : bytes.length
    const slice = bytes.slice(i, end)
    result += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    )
  }
  return result
}

type ParentNode =
  | FrameNode
  | PageNode
  | SectionNode
  | ComponentNode
  | GroupNode

const applyCommonProperties = async (
  node: SceneNode,
  spec: Record<string, unknown>,
  _parent: ParentNode,
): Promise<void> => {
  // Name
  if (spec.name !== undefined) {
    node.name = spec.name as string
  }

  // Size
  if (spec.size !== undefined) {
    const [w, h] = spec.size as [number, number]
    if ('resize' in node) {
      ;(node as FrameNode).resize(w, h)
    }
  }

  // Position
  if (spec.position !== undefined) {
    const [x, y] = spec.position as [number, number]
    node.x = x
    node.y = y
  }

  // Fills (already parsed to paint objects by server)
  if (spec.fills !== undefined) {
    const fills = spec.fills as (Paint & {
      imageUrl?: string
      imageHash?: string
      scaleMode?: string
    })[]
    const paintArray: Paint[] = []
    for (const fill of fills) {
      if (
        fill.type === 'IMAGE' &&
        (fill as unknown as Record<string, unknown>)
          .imageUrl
      ) {
        // Fetch image from URL and create ImagePaint
        const image = await figma.createImageAsync(
          (fill as unknown as Record<string, unknown>)
            .imageUrl as string,
        )
        paintArray.push({
          type: 'IMAGE',
          imageHash: image.hash,
          scaleMode:
            ((fill as unknown as Record<string, unknown>)
              .scaleMode as ImagePaint['scaleMode']) ??
            'FILL',
        } as ImagePaint)
      } else if (
        fill.type === 'IMAGE' &&
        (fill as unknown as Record<string, unknown>)
          .imageHash
      ) {
        // Use existing image hash directly
        paintArray.push({
          type: 'IMAGE',
          imageHash: (
            fill as unknown as Record<string, unknown>
          ).imageHash as string,
          scaleMode:
            ((fill as unknown as Record<string, unknown>)
              .scaleMode as ImagePaint['scaleMode']) ??
            'FILL',
        } as ImagePaint)
      } else {
        paintArray.push(fill)
      }
    }
    ;(node as GeometryMixin & SceneNode).fills = paintArray
  }

  // Strokes
  if (spec.strokes !== undefined) {
    const strokes = spec.strokes as Paint[]
    const strokeArray: Paint[] = []
    for (const stroke of strokes) {
      strokeArray.push(stroke)
    }
    ;(node as GeometryMixin & SceneNode).strokes =
      strokeArray
  }

  // Stroke properties
  if (spec.strokeWeight !== undefined) {
    ;(node as GeometryMixin & SceneNode).strokeWeight =
      spec.strokeWeight as number
  }
  if (spec.strokeAlign !== undefined) {
    ;(node as GeometryMixin & SceneNode).strokeAlign =
      spec.strokeAlign as 'CENTER' | 'INSIDE' | 'OUTSIDE'
  }
  if (spec.strokeDash !== undefined) {
    ;(node as GeometryMixin & SceneNode).dashPattern =
      spec.strokeDash as number[]
  }

  // Corner radius
  if (spec.radius !== undefined) {
    if (Array.isArray(spec.radius)) {
      const [tl, tr, br, bl] = spec.radius as [
        number,
        number,
        number,
        number,
      ]
      const rn = node as RectangleNode | FrameNode
      rn.topLeftRadius = tl
      rn.topRightRadius = tr
      rn.bottomRightRadius = br
      rn.bottomLeftRadius = bl
    } else {
      ;(
        node as RectangleNode | FrameNode | EllipseNode
      ).cornerRadius = spec.radius as number
    }
  }

  // Scalar visual properties
  if (spec.opacity !== undefined && 'opacity' in node) {
    ;(node as FrameNode).opacity = spec.opacity as number
  }
  if (spec.blendMode !== undefined && 'blendMode' in node) {
    ;(node as FrameNode).blendMode =
      spec.blendMode as BlendMode
  }
  if (spec.rotation !== undefined && 'rotation' in node) {
    ;(node as FrameNode).rotation = spec.rotation as number
  }
  if (spec.visible !== undefined)
    node.visible = spec.visible as boolean
  if (spec.clipsContent !== undefined) {
    ;(node as FrameNode).clipsContent =
      spec.clipsContent as boolean
  }

  // Effects (already parsed to effect objects by server)
  if (spec.effects !== undefined && 'effects' in node) {
    const effects = spec.effects as Effect[]
    // Ensure visible defaults
    ;(node as BlendMixin).effects = effects.map(
      function (e) {
        return Object.assign({}, e, {
          visible:
            (e as DropShadowEffect).visible !== undefined
              ? (e as DropShadowEffect).visible
              : true,
        })
      },
    )
  }

  // Layout (FRAME only)
  if (spec.layout !== undefined && 'layoutMode' in node) {
    const layout = spec.layout as {
      mode: string
      spacing: number
      padding: [number, number, number, number]
      align: [string, string]
      wrap?: boolean
      counterAxisSpacing?: number
      counterAxisAlignContent?: string
      primaryAxisSizingMode?: string
      counterAxisSizingMode?: string
    }
    const frame = node as FrameNode
    frame.layoutMode =
      layout.mode === 'H' ? 'HORIZONTAL' : 'VERTICAL'
    frame.itemSpacing = layout.spacing
    frame.paddingTop = layout.padding[0]
    frame.paddingRight = layout.padding[1]
    frame.paddingBottom = layout.padding[2]
    frame.paddingLeft = layout.padding[3]
    frame.primaryAxisAlignItems = layout.align[0] as
      | 'MIN'
      | 'MAX'
      | 'CENTER'
      | 'SPACE_BETWEEN'
    frame.counterAxisAlignItems = layout.align[1] as
      | 'MIN'
      | 'MAX'
      | 'CENTER'
      | 'BASELINE'
    if (layout.wrap) {
      frame.layoutWrap = 'WRAP'
    }
    if (layout.counterAxisSpacing !== undefined) {
      frame.counterAxisSpacing = layout.counterAxisSpacing
    }
    if (layout.counterAxisAlignContent !== undefined) {
      frame.counterAxisAlignContent =
        layout.counterAxisAlignContent as
          | 'AUTO'
          | 'SPACE_BETWEEN'
    }
    if (layout.primaryAxisSizingMode !== undefined) {
      frame.primaryAxisSizingMode =
        layout.primaryAxisSizingMode as 'FIXED' | 'AUTO'
    }
    if (layout.counterAxisSizingMode !== undefined) {
      frame.counterAxisSizingMode =
        layout.counterAxisSizingMode as 'FIXED' | 'AUTO'
    }
  }

  // Min/max sizing
  if (spec.minWidth !== undefined)
    (node as FrameNode).minWidth = spec.minWidth as
      | number
      | null
  if (spec.maxWidth !== undefined)
    (node as FrameNode).maxWidth = spec.maxWidth as
      | number
      | null
  if (spec.minHeight !== undefined)
    (node as FrameNode).minHeight = spec.minHeight as
      | number
      | null
  if (spec.maxHeight !== undefined)
    (node as FrameNode).maxHeight = spec.maxHeight as
      | number
      | null

  // Apply resolved style IDs (server resolves style(name) → styleId)
  if (spec.fillStyleId !== undefined) {
    ;(node as GeometryMixin & SceneNode).fillStyleId =
      spec.fillStyleId as string
  }
  if (spec.strokeStyleId !== undefined) {
    ;(node as GeometryMixin & SceneNode).strokeStyleId =
      spec.strokeStyleId as string
  }
  if (
    spec.effectStyleId !== undefined &&
    'effectStyleId' in node
  ) {
    ;(node as BlendMixin).effectStyleId =
      spec.effectStyleId as string
  }
  if (
    spec.textStyleId !== undefined &&
    'textStyleId' in node
  ) {
    ;(node as TextNode).textStyleId =
      spec.textStyleId as string
  }
}

const applyPostAppendProperties = (
  node: SceneNode,
  spec: Record<string, unknown>,
): void => {
  // These must be set AFTER appendChild to auto-layout parent

  // Sizing
  if (spec.sizing !== undefined) {
    const [h, v] = spec.sizing as [string, string]
    ;(node as FrameNode).layoutSizingHorizontal = h as
      | 'FIXED'
      | 'HUG'
      | 'FILL'
    ;(node as FrameNode).layoutSizingVertical = v as
      | 'FIXED'
      | 'HUG'
      | 'FILL'
  }

  // Layout positioning (ABSOLUTE)
  if (spec.layoutPositioning !== undefined) {
    ;(node as FrameNode).layoutPositioning =
      spec.layoutPositioning as 'AUTO' | 'ABSOLUTE'
  }
}

const applyTextProperties = async (
  node: TextNode,
  spec: Record<string, unknown>,
): Promise<void> => {
  const text = spec.text as Record<string, unknown>
  if (!text) return

  const font = text.font as {
    family: string
    style: string
    size: number
  }

  // Load font first — REQUIRED before setting any text property
  await figma.loadFontAsync({
    family: font.family,
    style: font.style,
  })

  // Set font
  node.fontName = { family: font.family, style: font.style }
  node.fontSize = font.size

  // Text auto-resize (set before content to avoid resize fighting)
  if (spec.textAutoResize !== undefined) {
    node.textAutoResize = spec.textAutoResize as
      | 'NONE'
      | 'WIDTH_AND_HEIGHT'
      | 'HEIGHT'
      | 'TRUNCATE'
  }

  // Set text content
  if (text.content !== undefined) {
    node.characters = text.content as string
  }

  // Alignment
  if (text.align !== undefined) {
    node.textAlignHorizontal = text.align as
      | 'LEFT'
      | 'CENTER'
      | 'RIGHT'
      | 'JUSTIFIED'
  }
  if (text.valign !== undefined) {
    node.textAlignVertical = text.valign as
      | 'TOP'
      | 'CENTER'
      | 'BOTTOM'
  }

  // Text color (from parsed paint)
  if (text.color !== undefined) {
    const paint = text.color as {
      type: string
      color: RGB
      opacity: number
    }
    if (paint.type === 'SOLID') {
      node.fills = [
        {
          type: 'SOLID',
          color: paint.color,
          opacity:
            paint.opacity !== undefined ? paint.opacity : 1,
        },
      ]
    }
  }

  // Line height
  if (text.lineHeight !== undefined) {
    const lh = text.lineHeight as {
      value?: number
      unit: string
    }
    if (lh.unit === 'AUTO') {
      node.lineHeight = { unit: 'AUTO' }
    } else if (lh.unit === 'PIXELS') {
      node.lineHeight = {
        value: lh.value as number,
        unit: 'PIXELS',
      }
    } else if (lh.unit === 'PERCENT') {
      node.lineHeight = {
        value: lh.value as number,
        unit: 'PERCENT',
      }
    }
  }

  // Letter spacing
  if (text.letterSpacing !== undefined) {
    const ls = text.letterSpacing as {
      value: number
      unit: string
    }
    node.letterSpacing = {
      value: ls.value,
      unit: ls.unit as 'PIXELS' | 'PERCENT',
    }
  }

  // Decoration
  if (text.decoration !== undefined) {
    node.textDecoration = text.decoration as
      | 'NONE'
      | 'UNDERLINE'
      | 'STRIKETHROUGH'
  }

  // Case
  if (text.case !== undefined) {
    node.textCase = text.case as
      | 'ORIGINAL'
      | 'UPPER'
      | 'LOWER'
      | 'TITLE'
      | 'SMALL_CAPS'
      | 'SMALL_CAPS_FORCED'
  }

  // Paragraph spacing
  if (text.paragraphSpacing !== undefined) {
    node.paragraphSpacing = text.paragraphSpacing as number
  }
}

const createSingleNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
): Promise<SceneNode> => {
  const type = spec.type as string
  let node: SceneNode

  switch (type) {
    case 'FRAME':
      node = figma.createFrame()
      break
    case 'RECTANGLE':
      node = figma.createRectangle()
      break
    case 'ELLIPSE': {
      const ellipse = figma.createEllipse()
      if (spec.arcData !== undefined) {
        ellipse.arcData = spec.arcData as ArcData
      }
      node = ellipse
      break
    }
    case 'TEXT':
      node = figma.createText()
      break
    case 'LINE':
      node = figma.createLine()
      break
    case 'POLYGON': {
      const polygon = figma.createPolygon()
      if (spec.pointCount !== undefined) {
        polygon.pointCount = spec.pointCount as number
      }
      node = polygon
      break
    }
    case 'STAR': {
      const star = figma.createStar()
      if (spec.pointCount !== undefined) {
        star.pointCount = spec.pointCount as number
      }
      if (spec.innerRadius !== undefined) {
        star.innerRadius = spec.innerRadius as number
      }
      node = star
      break
    }
    case 'VECTOR': {
      const vector = figma.createVector()
      if (spec.vectorPaths !== undefined) {
        vector.vectorPaths =
          spec.vectorPaths as VectorPath[]
      }
      node = vector
      break
    }
    case 'SECTION': {
      const section = figma.createSection()
      if (spec.sectionContentsHidden !== undefined) {
        section.sectionContentsHidden =
          spec.sectionContentsHidden as boolean
      }
      node = section
      break
    }
    case 'SLICE':
      node = figma.createSlice()
      break
    case 'INSTANCE': {
      const compRef = spec.component as {
        key: string
        properties?: Record<string, string | boolean>
      }
      const component =
        await figma.importComponentByKeyAsync(compRef.key)
      const instance = component.createInstance()
      if (compRef.properties) {
        instance.setProperties(compRef.properties)
      }
      node = instance
      break
    }
    case 'TEXT_PATH': {
      // TEXT_PATH requires an existing VectorNode and path segment info
      const vectorNodeId = spec.vectorNodeId as string
      const startSegment =
        (spec.startSegment as number) !== undefined
          ? (spec.startSegment as number)
          : 0
      const startPosition =
        (spec.startPosition as number) !== undefined
          ? (spec.startPosition as number)
          : 0
      const vectorNode =
        await figma.getNodeByIdAsync(vectorNodeId)
      if (!vectorNode || vectorNode.type !== 'VECTOR') {
        throw new Error(
          'TEXT_PATH requires a valid VectorNode ID, got: ' +
            vectorNodeId,
        )
      }
      node = figma.createTextPath(
        vectorNode as VectorNode,
        startSegment,
        startPosition,
      )
      break
    }
    case 'SLOT': {
      // SLOT in create_node context: create a FRAME placeholder.
      // Actual SLOT promotion happens in create_component via component.createSlot().
      node = figma.createFrame()
      break
    }
    default:
      throw new Error('Unsupported node type: ' + type)
  }

  // Apply common properties (fills, strokes, effects, etc.)
  await applyCommonProperties(node, spec, parent)

  // Apply text-specific properties (requires font loading)
  if (type === 'TEXT') {
    await applyTextProperties(node as TextNode, spec)
  }

  // Append to parent
  parent.appendChild(node)

  // Apply post-append properties (FILL sizing, ABSOLUTE positioning)
  applyPostAppendProperties(node, spec)

  return node
}

const createTreeNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
): Promise<SceneNode> => {
  const type = spec.type as string

  // Clone reference: { id } with no type
  if (spec.id !== undefined && spec.type === undefined) {
    const existing = await figma.getNodeByIdAsync(
      spec.id as string,
    )
    if (!existing)
      throw new Error(
        'Node not found for clone: ' + spec.id,
      )

    if (existing.type === 'COMPONENT') {
      // COMPONENT → create INSTANCE
      const instance = (
        existing as ComponentNode
      ).createInstance()
      parent.appendChild(instance)
      return instance
    }
    if (existing.type === 'INSTANCE') {
      // INSTANCE → create another instance of same component
      const mainComp = (existing as InstanceNode)
        .mainComponent
      if (mainComp) {
        const instance = mainComp.createInstance()
        parent.appendChild(instance)
        return instance
      }
    }
    // Default: clone
    const cloned = (existing as SceneNode).clone()
    parent.appendChild(cloned)
    return cloned
  }

  // GROUP: create children first, then group
  if (type === 'GROUP') {
    const children = spec.children as
      | Record<string, unknown>[]
      | undefined
    if (!children || children.length === 0) {
      throw new Error('GROUP requires at least one child')
    }
    const childNodes: SceneNode[] = []
    for (const childSpec of children) {
      const child = await createTreeNode(childSpec, parent)
      childNodes.push(child)
    }
    const group = figma.group(childNodes, parent)
    if (spec.name) group.name = spec.name as string
    return group
  }

  // TRANSFORM_GROUP: create children first, then wrap (similar to GROUP)
  if (type === 'TRANSFORM_GROUP') {
    const children = spec.children as
      | Record<string, unknown>[]
      | undefined
    if (!children || children.length === 0) {
      throw new Error(
        'TRANSFORM_GROUP requires at least one child',
      )
    }
    const childNodes: SceneNode[] = []
    for (const childSpec of children) {
      const child = await createTreeNode(childSpec, parent)
      childNodes.push(child)
    }
    const modifiers = spec.modifiers as
      | Record<string, unknown>
      | undefined
    const group = figma.group(childNodes, parent)
    if (spec.name) group.name = spec.name as string
    // Apply transform modifiers if provided (rotation, scale, skew)
    if (modifiers) {
      if (modifiers.rotation !== undefined)
        group.rotation = modifiers.rotation as number
    }
    return group
  }

  // BOOLEAN_OPERATION: create children first, then combine
  if (type === 'BOOLEAN_OPERATION') {
    const children = spec.children as
      | Record<string, unknown>[]
      | undefined
    if (!children || children.length < 2) {
      throw new Error(
        'BOOLEAN_OPERATION requires at least 2 children',
      )
    }
    const childNodes: SceneNode[] = []
    for (const childSpec of children) {
      const child = await createTreeNode(childSpec, parent)
      childNodes.push(child)
    }
    const op = spec.booleanOperation as string
    let boolNode: BooleanOperationNode
    switch (op) {
      case 'UNION':
        boolNode = figma.union(childNodes, parent)
        break
      case 'SUBTRACT':
        boolNode = figma.subtract(childNodes, parent)
        break
      case 'INTERSECT':
        boolNode = figma.intersect(childNodes, parent)
        break
      case 'EXCLUDE':
        boolNode = figma.exclude(childNodes, parent)
        break
      default:
        boolNode = figma.union(childNodes, parent)
    }
    if (spec.name) boolNode.name = spec.name as string
    return boolNode
  }

  // Regular node: create, apply properties, append
  const node = await createSingleNode(spec, parent)

  // Recurse into children (for FRAME, SECTION, etc.)
  const children = spec.children as
    | Record<string, unknown>[]
    | undefined
  if (
    children &&
    children.length > 0 &&
    'appendChild' in node
  ) {
    for (const childSpec of children) {
      await createTreeNode(childSpec, node as ParentNode)
    }
  }

  return node
}

const handleCommand = async (
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> => {
  switch (command) {
    case 'get_document_info':
      return {
        name: figma.root.name,
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
      }

    case 'get_selection':
      return figma.currentPage.selection.map(node => ({
        id: node.id,
        name: node.name,
        type: node.type,
      }))

    case 'get_node': {
      const node = await figma.getNodeByIdAsync(
        params.nodeId as string,
      )
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      return exportNodeDocument(node)
    }

    case 'get_nodes': {
      const nodeIds = (params.nodeIds as string[]) || []
      return Promise.all(
        nodeIds.map(async nodeId => {
          const node = await figma.getNodeByIdAsync(nodeId)
          if (!node) {
            return { id: nodeId, error: 'Node not found' }
          }
          return exportNodeDocument(node)
        }),
      )
    }

    case 'get_page_layout': {
      return {
        pageName: figma.currentPage.name,
        frames: figma.currentPage.children.map(frame => ({
          id: frame.id,
          name: frame.name,
          type: frame.type,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          childCount:
            'children' in frame
              ? (frame as SceneNode & ChildrenMixin)
                  .children.length
              : 0,
        })),
      }
    }

    case 'get_pages':
      return figma.root.children.map(page => ({
        id: page.id,
        name: page.name,
        isCurrent: page.id === figma.currentPage.id,
        childCount: page.children
          ? page.children.length
          : 0,
      }))

    case 'export_node': {
      const exportNode = (await figma.getNodeByIdAsync(
        params.nodeId as string,
      )) as SceneNode | null
      if (!exportNode) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const exportFormat =
        (params.format as 'PNG' | 'JPG' | 'SVG' | 'PDF') ||
        'PNG'
      const exportScale = (params.scale as number) || 1
      const bytes = await exportNode.exportAsync({
        format: exportFormat,
        constraint: { type: 'SCALE', value: exportScale },
      })
      const data =
        exportFormat === 'SVG'
          ? bytesToString(bytes)
          : bytesToBase64(bytes)
      return {
        format: exportFormat,
        scale: exportScale,
        data,
      }
    }

    case 'get_styles': {
      const paintStyles = figma
        .getLocalPaintStyles()
        .map(s => ({
          id: s.id,
          name: s.name,
          paints: s.paints.map(p => ({
            type: p.type,
            color:
              p.type === 'SOLID'
                ? (p as SolidPaint).color
                : undefined,
            opacity: p.opacity,
          })),
        }))
      const textStyles = figma
        .getLocalTextStyles()
        .map(s => ({
          id: s.id,
          name: s.name,
          fontFamily: s.fontName.family,
          fontStyle: s.fontName.style,
          fontSize: s.fontSize,
          lineHeight:
            s.lineHeight.unit === 'PIXELS'
              ? (
                  s.lineHeight as {
                    unit: 'PIXELS'
                    value: number
                  }
                ).value
              : null,
        }))
      const effectStyles = figma
        .getLocalEffectStyles()
        .map(s => ({
          id: s.id,
          name: s.name,
          effects: s.effects.map(e => ({
            type: e.type,
            color:
              'color' in e
                ? (
                    e as
                      | DropShadowEffect
                      | InnerShadowEffect
                  ).color
                : undefined,
            offset:
              'offset' in e
                ? (
                    e as
                      | DropShadowEffect
                      | InnerShadowEffect
                  ).offset
                : undefined,
            radius:
              'radius' in e
                ? (
                    e as
                      | DropShadowEffect
                      | InnerShadowEffect
                      | BlurEffectNormal
                  ).radius
                : undefined,
            spread:
              'spread' in e
                ? (
                    e as
                      | DropShadowEffect
                      | InnerShadowEffect
                  ).spread
                : undefined,
          })),
        }))
      const gridStyles = figma
        .getLocalGridStyles()
        .map(s => ({ id: s.id, name: s.name }))
      return {
        paint: paintStyles,
        text: textStyles,
        effect: effectStyles,
        grid: gridStyles,
      }
    }

    case 'get_local_components': {
      const componentSets = figma.root.findAllWithCriteria({
        types: ['COMPONENT_SET'],
      })
      const components = figma.root.findAllWithCriteria({
        types: ['COMPONENT'],
      })

      const setMap: Record<string, unknown> = {}
      for (const cs of componentSets) {
        const variantKeys: Record<string, string[]> = {}
        if (cs.children) {
          for (const variant of cs.children) {
            const props = (variant as ComponentNode)
              .variantProperties
            if (props) {
              for (const pkey of Object.keys(props)) {
                if (!variantKeys[pkey]) {
                  variantKeys[pkey] = []
                }
                if (
                  !variantKeys[pkey].includes(props[pkey])
                ) {
                  variantKeys[pkey].push(props[pkey])
                }
              }
            }
          }
        }
        const csDefs = cs.componentPropertyDefinitions || {}
        const csProps = Object.keys(csDefs).map(key => ({
          name: key,
          type: csDefs[key].type,
          default: csDefs[key].defaultValue,
        }))
        setMap[cs.id] = {
          id: cs.id,
          name: cs.name,
          page:
            cs.parent && cs.parent.type === 'PAGE'
              ? cs.parent.name
              : null,
          variants:
            Object.keys(variantKeys).length > 0
              ? variantKeys
              : null,
          properties: csProps,
        }
      }

      const standaloneComponents: unknown[] = []
      for (const comp of components) {
        if (
          comp.parent &&
          comp.parent.type === 'COMPONENT_SET'
        ) {
          continue
        }
        const compDefs =
          comp.componentPropertyDefinitions || {}
        const compProps = Object.keys(compDefs).map(
          key => ({
            name: key,
            type: compDefs[key].type,
            default: compDefs[key].defaultValue,
          }),
        )
        standaloneComponents.push({
          id: comp.id,
          name: comp.name,
          page:
            comp.parent && comp.parent.type === 'PAGE'
              ? comp.parent.name
              : null,
          variants: null,
          properties: compProps,
        })
      }

      const instances = figma.root.findAllWithCriteria({
        types: ['INSTANCE'],
      })
      const remoteMap: Record<
        string,
        {
          key: string
          name: string
          library: string
          instancesCount: number
        }
      > = {}
      for (const inst of instances) {
        const main = inst.mainComponent
        if (main && main.remote) {
          const mkey = main.key
          if (!remoteMap[mkey]) {
            remoteMap[mkey] = {
              key: mkey,
              name: main.name,
              library:
                main.parent && main.parent.name
                  ? main.parent.name
                  : 'Unknown',
              instancesCount: 0,
            }
          }
          remoteMap[mkey].instancesCount++
        }
      }

      const localAll = Object.values(setMap).concat(
        standaloneComponents,
      )
      const remoteAll = Object.values(remoteMap)

      return { local: localAll, remote: remoteAll }
    }

    case 'search_nodes': {
      const searchName = (params.name as string) || ''
      const searchType = (params.type as string) || null
      const searchPageId = (params.pageId as string) || null
      const searchLimit = (params.limit as number) || 50

      const searchPages: PageNode[] = []
      if (searchPageId) {
        const pageNode =
          await figma.getNodeByIdAsync(searchPageId)
        if (pageNode && pageNode.type === 'PAGE') {
          searchPages.push(pageNode as PageNode)
        }
      } else {
        for (const page of figma.root.children) {
          searchPages.push(page)
        }
      }

      const globPattern = searchName
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
      const nameRegex = searchName
        ? new RegExp(globPattern, 'i')
        : null

      const matches: unknown[] = []
      for (const sp of searchPages) {
        const found = sp.findAll(node => {
          if (nameRegex && !nameRegex.test(node.name)) {
            return false
          }
          if (searchType && node.type !== searchType) {
            return false
          }
          return true
        })
        for (const fn of found) {
          if (matches.length >= searchLimit) {
            break
          }
          matches.push({
            id: fn.id,
            name: fn.name,
            type: fn.type,
            page: sp.name,
            parent: fn.parent
              ? fn.parent.name + ' [' + fn.parent.id + ']'
              : null,
            width:
              'width' in fn
                ? (fn as SceneNode & { width: number })
                    .width
                : null,
            height:
              'height' in fn
                ? (fn as SceneNode & { height: number })
                    .height
                : null,
          })
        }
        if (matches.length >= searchLimit) {
          break
        }
      }

      const truncated = matches.length >= searchLimit
      return {
        results: matches.slice(0, searchLimit),
        truncated,
      }
    }

    case 'create_node': {
      const parentNode = await figma.getNodeByIdAsync(
        params.parentId as string,
      )
      if (!parentNode || !('appendChild' in parentNode)) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const parent = parentNode as
        | FrameNode
        | PageNode
        | SectionNode
      const spec = params.node as Record<string, unknown>
      const created = await createSingleNode(spec, parent)
      return {
        id: created.id,
        name: created.name,
        type: created.type,
      }
    }

    case 'create_tree': {
      const treeParent = await figma.getNodeByIdAsync(
        params.parentId as string,
      )
      if (!treeParent || !('appendChild' in treeParent)) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const treeParentNode = treeParent as
        | FrameNode
        | PageNode
        | SectionNode
      const treeSpec = params.node as Record<
        string,
        unknown
      >
      const treeResult = await createTreeNode(
        treeSpec,
        treeParentNode,
      )
      return {
        id: treeResult.id,
        name: treeResult.name,
        type: treeResult.type,
      }
    }

    case 'create_component': {
      if (params.combineAsVariants && params.nodeIds) {
        const compNodes: ComponentNode[] = []
        for (const nid of params.nodeIds as string[]) {
          const n = await figma.getNodeByIdAsync(nid)
          if (n && n.type === 'COMPONENT') {
            compNodes.push(n as ComponentNode)
          }
        }
        if (compNodes.length < 2) {
          return {
            error:
              'Need at least 2 components for combineAsVariants',
          }
        }
        const compParent = compNodes[0].parent as BaseNode &
          ChildrenMixin
        const cs = figma.combineAsVariants(
          compNodes,
          compParent,
        )
        return {
          id: cs.id,
          name: cs.name,
          type: cs.type,
          key: cs.key,
        }
      }
      const nodeToPromote = await figma.getNodeByIdAsync(
        params.nodeId as string,
      )
      if (!nodeToPromote) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const comp = figma.createComponentFromNode(
        nodeToPromote as SceneNode,
      )

      // Create slots if specified
      const slots = params.slots as string[] | undefined
      if (slots) {
        const compWithSlot = comp as ComponentNode & {
          createSlot?: (name: string) => void
        }
        if (compWithSlot.createSlot) {
          for (const slotName of slots) {
            compWithSlot.createSlot(slotName)
          }
        }
      }

      // Add component properties if specified
      const componentProperties =
        params.componentProperties as
          | {
              name: string
              type: string
              default: string | boolean
            }[]
          | undefined
      if (componentProperties) {
        for (const prop of componentProperties) {
          comp.addComponentProperty(
            prop.name,
            prop.type as ComponentPropertyType,
            prop.default,
          )
        }
      }

      return {
        id: comp.id,
        name: comp.name,
        type: comp.type,
        key: comp.key,
      }
    }

    case 'create_from_svg': {
      const svgParent = await figma.getNodeByIdAsync(
        params.parentId as string,
      )
      if (!svgParent || !('appendChild' in svgParent)) {
        return {
          error: 'Parent not found: ' + params.parentId,
        }
      }
      const svgFrame = figma.createNodeFromSvg(
        params.svg as string,
      )
      if (params.name) {
        svgFrame.name = params.name as string
      }
      if (params.size) {
        const [w, h] = params.size as [number, number]
        svgFrame.resize(w, h)
      }
      ;(svgParent as FrameNode).appendChild(svgFrame)
      return {
        id: svgFrame.id,
        name: svgFrame.name,
        type: svgFrame.type,
        childCount: svgFrame.children.length,
      }
    }

    default:
      return { error: 'Unknown command: ' + command }
  }
}

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type === 'execute-command') {
    let result: unknown
    try {
      result = await handleCommand(msg.command, msg.params)
    } catch (err) {
      result = { error: String(err) }
    }

    figma.ui.postMessage({
      type: 'command-result',
      id: msg.id,
      result,
    })
  }

  if (msg.type === 'storage-get') {
    const value = await figma.clientStorage.getAsync(
      msg.key,
    )
    figma.ui.postMessage({
      type: 'storage-result',
      key: msg.key,
      value: value !== undefined ? value : null,
    })
  }

  if (msg.type === 'storage-set') {
    await figma.clientStorage.setAsync(msg.key, msg.value)
  }

  if (msg.type === 'storage-delete') {
    await figma.clientStorage.deleteAsync(msg.key)
  }
}
