import { COMMANDS } from '@figma-agent-bridge/shared'

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
    if ('fills' in node) {
      ;(node as GeometryMixin & SceneNode).fills =
        paintArray
    }
  }

  // Strokes
  if (spec.strokes !== undefined) {
    const strokes = spec.strokes as Paint[]
    const strokeArray: Paint[] = []
    for (const stroke of strokes) {
      strokeArray.push(stroke)
    }
    if ('strokes' in node) {
      ;(node as GeometryMixin & SceneNode).strokes =
        strokeArray
    }
  }

  // Stroke properties
  if (
    spec.strokeWeight !== undefined &&
    'strokeWeight' in node
  ) {
    ;(node as GeometryMixin & SceneNode).strokeWeight =
      spec.strokeWeight as number
  }
  if (
    spec.strokeAlign !== undefined &&
    'strokeAlign' in node
  ) {
    ;(node as GeometryMixin & SceneNode).strokeAlign =
      spec.strokeAlign as 'CENTER' | 'INSIDE' | 'OUTSIDE'
  }
  if (
    spec.strokeDash !== undefined &&
    'dashPattern' in node
  ) {
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
  if (
    spec.fillStyleId !== undefined &&
    'fillStyleId' in node
  ) {
    ;(node as GeometryMixin & SceneNode).fillStyleId =
      spec.fillStyleId as string
  }
  if (
    spec.strokeStyleId !== undefined &&
    'strokeStyleId' in node
  ) {
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
  refs?: Record<string, Record<string, unknown>>,
): Promise<SceneNode> => {
  const type = spec.type as string

  // Ref-pool reference: { ref } — rebuild refs[key] FRESH on each reuse so N
  // uses of one ref yield N independent subtrees, not N shared references.
  if (spec.ref !== undefined && spec.type === undefined) {
    const refKey = spec.ref as string
    const refSpec = refs?.[refKey]
    if (!refSpec) {
      throw new Error('Ref not found in pool: ' + refKey)
    }
    return createTreeNode(refSpec, parent, refs)
  }

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
      const child = await createTreeNode(
        childSpec,
        parent,
        refs,
      )
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
      const child = await createTreeNode(
        childSpec,
        parent,
        refs,
      )
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
      const child = await createTreeNode(
        childSpec,
        parent,
        refs,
      )
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
      await createTreeNode(
        childSpec,
        node as ParentNode,
        refs,
      )
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

    case COMMANDS.GET_SELECTION:
      return figma.currentPage.selection.map(node => ({
        id: node.id,
        name: node.name,
        type: node.type,
      }))

    // set_selection: SELECTION ONLY (does not scroll — pair with set_focus).
    // Resolves the ids to scene nodes on the current page; ids that don't
    // resolve to a selectable scene node are skipped. Returns {selectedCount}.
    case COMMANDS.SET_SELECTION: {
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id)
        // Only scene nodes are selectable; `visible` is present on every
        // SceneNode and absent on PAGE/DOCUMENT, so it's a sound guard.
        if (n && 'visible' in n) {
          nodes.push(n as SceneNode)
        }
      }
      figma.currentPage.selection = nodes
      return { selectedCount: nodes.length }
    }

    case COMMANDS.GET_NODE: {
      const node = await figma.getNodeByIdAsync(
        params.nodeId as string,
      )
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      return exportNodeDocument(node)
    }

    // inspect returns the SAME raw export the reader consumes; the server's
    // read model decides depth/budget. Resolves nodeId → pageId → current
    // selection → current page. With no nodeId/pageId and a MULTI-node
    // selection it returns an ARRAY of raw exports (one per selected node); the
    // server wraps those in a SELECTION forest so depth/budget/receipt bound the
    // whole set. A single selected node returns that node's export; an empty
    // selection falls back to the current page.
    case COMMANDS.INSPECT: {
      let target: BaseNode | null = null
      if (params.nodeId !== undefined) {
        target = await figma.getNodeByIdAsync(
          params.nodeId as string,
        )
      } else if (params.pageId !== undefined) {
        target = await figma.getNodeByIdAsync(
          params.pageId as string,
        )
      } else {
        const sel = figma.currentPage.selection
        if (sel.length > 1) {
          // Multi-selection → forest of all selected nodes. Resolve every
          // export before returning (each exportNodeDocument is async).
          return Promise.all(
            sel.map(node => exportNodeDocument(node)),
          )
        }
        target =
          sel.length === 1 ? sel[0] : figma.currentPage
      }
      if (!target) {
        return {
          error:
            'Node not found: ' +
            ((params.nodeId ?? params.pageId) as string),
        }
      }
      return exportNodeDocument(target)
    }

    // get_nodes: one entry per id — a raw export (the same shape get_node /
    // inspect return, which the server's toNodeSpec consumes) or {id, error}
    // for a miss. The server splits them into {results, errors[]}.
    case COMMANDS.GET_NODES: {
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

    // list_pages: document + page enumeration (Rule A; bounded). The server
    // wraps this in { docName, results, truncated:false }.
    case COMMANDS.LIST_PAGES:
      return {
        docName: figma.root.name,
        results: figma.root.children.map(page => ({
          id: page.id,
          name: page.name,
          isCurrent: page.id === figma.currentPage.id,
          childCount: page.children
            ? page.children.length
            : 0,
        })),
      }

    case COMMANDS.EXPORT: {
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

    // get_styles: each entry carries the raw figma VALUE the server renders to
    // a view atom (paint→hex, text→font, effect/grid→head). Uses the ASYNC
    // style getters; the server applies the type/id filters.
    case COMMANDS.GET_STYLES: {
      const paintStylesRaw =
        await figma.getLocalPaintStylesAsync()
      const paint = paintStylesRaw.map(s => ({
        id: s.id,
        name: s.name,
        value: s.paints[0],
      }))
      const textStylesRaw =
        await figma.getLocalTextStylesAsync()
      const text = textStylesRaw.map(s => ({
        id: s.id,
        name: s.name,
        value: {
          family: s.fontName.family,
          style: s.fontName.style,
          size: s.fontSize,
          lineHeight: s.lineHeight,
          letterSpacing: s.letterSpacing,
        },
      }))
      const effectStylesRaw =
        await figma.getLocalEffectStylesAsync()
      const effect = effectStylesRaw.map(s => ({
        id: s.id,
        name: s.name,
        value: s.effects[0],
      }))
      const gridStylesRaw =
        await figma.getLocalGridStylesAsync()
      const grid = gridStylesRaw.map(s => {
        const g = s.layoutGrids?.[0] as
          | LayoutGrid
          | undefined
        return {
          id: s.id,
          name: s.name,
          value: g
            ? {
                pattern: g.pattern,
                alignment:
                  'alignment' in g
                    ? (g as RowsColsLayoutGrid).alignment
                    : undefined,
                count:
                  'count' in g
                    ? (g as RowsColsLayoutGrid).count
                    : undefined,
                sectionSize:
                  'sectionSize' in g
                    ? (g as RowsColsLayoutGrid).sectionSize
                    : undefined,
                gutterSize:
                  'gutterSize' in g
                    ? (g as RowsColsLayoutGrid).gutterSize
                    : undefined,
                offset:
                  'offset' in g
                    ? (g as RowsColsLayoutGrid).offset
                    : undefined,
                visible: g.visible,
              }
            : undefined,
        }
      })
      return { paint, text, effect, grid }
    }

    // get_components: rich per-entry shape — key, type, page, the full
    // componentPropertyDefinitions (incl. variantOptions for VARIANT), the
    // variant axes, and the per-property defaults. The server applies the
    // name query filter.
    case COMMANDS.GET_COMPONENTS: {
      const componentSets = figma.root.findAllWithCriteria({
        types: ['COMPONENT_SET'],
      })
      const components = figma.root.findAllWithCriteria({
        types: ['COMPONENT'],
      })

      const projectDefs = (
        defs: ComponentPropertyDefinitions,
      ): {
        name: string
        type: string
        defaultValue: string | boolean
        variantOptions?: string[]
      }[] =>
        Object.keys(defs).map(key => {
          const def = defs[key]
          const entry: {
            name: string
            type: string
            defaultValue: string | boolean
            variantOptions?: string[]
          } = {
            name: key,
            type: def.type,
            defaultValue: def.defaultValue,
          }
          if (
            def.type === 'VARIANT' &&
            def.variantOptions
          ) {
            entry.variantOptions = def.variantOptions
          }
          return entry
        })

      const defaultsOf = (
        defs: ComponentPropertyDefinitions,
      ): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(defs).map(([k, d]) => [
            k,
            d.defaultValue,
          ]),
        )

      const setMap: Record<string, unknown> = {}
      for (const cs of componentSets) {
        const variantAxes: Record<string, string[]> = {}
        if (cs.children) {
          for (const variant of cs.children) {
            const props = (variant as ComponentNode)
              .variantProperties
            if (props) {
              for (const pkey of Object.keys(props)) {
                if (!variantAxes[pkey]) {
                  variantAxes[pkey] = []
                }
                if (
                  !variantAxes[pkey].includes(props[pkey])
                ) {
                  variantAxes[pkey].push(props[pkey])
                }
              }
            }
          }
        }
        const csDefs = cs.componentPropertyDefinitions || {}
        setMap[cs.id] = {
          id: cs.id,
          name: cs.name,
          key: cs.key,
          type: cs.type,
          page:
            cs.parent && cs.parent.type === 'PAGE'
              ? cs.parent.name
              : null,
          propertyDefinitions: projectDefs(csDefs),
          variantAxes:
            Object.keys(variantAxes).length > 0
              ? variantAxes
              : undefined,
          defaults: defaultsOf(csDefs),
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
        standaloneComponents.push({
          id: comp.id,
          name: comp.name,
          key: comp.key,
          type: comp.type,
          page:
            comp.parent && comp.parent.type === 'PAGE'
              ? comp.parent.name
              : null,
          propertyDefinitions: projectDefs(compDefs),
          defaults: defaultsOf(compDefs),
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

    // search (Rule A): the plugin SCANS the requested scope and returns the RAW
    // candidate nodes — it does NOT filter, project, or paginate. The SERVER
    // owns match + fields + limit + cursor. We emit { results: [candidate…] }
    // where each candidate carries the fields the server's matcher / projection
    // read (id, name, type, size).
    case COMMANDS.SEARCH: {
      const scope = (params.scope as string) || 'document'

      // Collect the root subtrees to scan based on scope. (selection scope
      // builds its candidates directly below — no shared root.)
      const roots: (BaseNode & ChildrenMixin)[] = []
      if (scope === 'node') {
        const target = await figma.getNodeByIdAsync(
          params.nodeId as string,
        )
        if (target && 'findAll' in target) {
          roots.push(target as BaseNode & ChildrenMixin)
        }
      } else if (scope === 'page') {
        const pageNode = await figma.getNodeByIdAsync(
          params.pageId as string,
        )
        if (pageNode && pageNode.type === 'PAGE') {
          roots.push(pageNode as PageNode)
        }
      } else {
        // document (default): a page may be restricted via pageId.
        const pageId = params.pageId as string | undefined
        if (pageId) {
          const pageNode =
            await figma.getNodeByIdAsync(pageId)
          if (pageNode && pageNode.type === 'PAGE') {
            roots.push(pageNode as PageNode)
          }
        } else {
          for (const page of figma.root.children) {
            roots.push(page)
          }
        }
      }

      const toCandidate = (
        fn: SceneNode,
      ): Record<string, unknown> => ({
        id: fn.id,
        name: fn.name,
        type: fn.type,
        size:
          'width' in fn && 'height' in fn
            ? [
                (fn as SceneNode & { width: number }).width,
                (fn as SceneNode & { height: number })
                  .height,
              ]
            : undefined,
      })

      const seen = new Set<string>()
      const candidates: Record<string, unknown>[] = []

      // selection scope: the selected nodes plus their subtrees.
      if (scope === 'selection') {
        for (const sel of figma.currentPage.selection) {
          if (!seen.has(sel.id)) {
            seen.add(sel.id)
            candidates.push(toCandidate(sel))
          }
          if ('findAll' in sel) {
            for (const fn of (
              sel as SceneNode & ChildrenMixin
            ).findAll(() => true)) {
              if (!seen.has(fn.id)) {
                seen.add(fn.id)
                candidates.push(toCandidate(fn))
              }
            }
          }
        }
      } else {
        for (const root of roots) {
          for (const fn of root.findAll(() => true)) {
            if (!seen.has(fn.id)) {
              seen.add(fn.id)
              candidates.push(toCandidate(fn))
            }
          }
        }
      }

      return { results: candidates }
    }

    // create_node (M2 single-node): the spec is a FigmaWritePayload already
    // converted on the server's grammar write face (atom leaves parsed; name
    // fallback applied). Resolve parent (parentId, else the current page),
    // create the node by type, apply via applyCommonProperties / (TEXT)
    // applyTextProperties, append, then applyPostAppendProperties (FILL/ABSOLUTE
    // ordering). Children are out of scope (the server strips them) — guard and
    // warn if any slip through; never recurse. Returns {id,name,type,warnings}.
    case COMMANDS.CREATE_NODE: {
      const parentNode =
        params.parentId !== undefined
          ? await figma.getNodeByIdAsync(
              params.parentId as string,
            )
          : figma.currentPage
      if (!parentNode || !('appendChild' in parentNode)) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const parent = parentNode as ParentNode
      const spec = params.spec as Record<string, unknown>
      const warnings: string[] = []
      if (
        spec.children !== undefined &&
        Array.isArray(spec.children) &&
        (spec.children as unknown[]).length > 0
      ) {
        warnings.push(
          'children ignored — create_node creates a single node; use create_tree (M3) for nested creation',
        )
      }
      const created = await createSingleNode(spec, parent)
      return {
        id: created.id,
        name: created.name,
        type: created.type,
        warnings,
      }
    }

    // create_tree (M3 REBUILD): build a nested tree from a converted
    // TreeNodeSpec. params = { tree, parentId?, refs? }. parentId omitted →
    // current page. The recursive builder createTreeNode creates each node by
    // type, appendChild, then applyPostAppendProperties (FILL/ABSOLUTE) per
    // level and loadFontAsync before text. `{ ref }` rebuilds refs[key] fresh;
    // `{ id }` clones the existing node.
    case COMMANDS.CREATE_TREE: {
      const treeParentNode =
        params.parentId !== undefined
          ? await figma.getNodeByIdAsync(
              params.parentId as string,
            )
          : figma.currentPage
      if (
        !treeParentNode ||
        !('appendChild' in treeParentNode)
      ) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const treeParent = treeParentNode as ParentNode
      const treeSpec = params.tree as Record<
        string,
        unknown
      >
      const treeRefs = params.refs as
        | Record<string, Record<string, unknown>>
        | undefined
      const treeResult = await createTreeNode(
        treeSpec,
        treeParent,
        treeRefs,
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

      // Add component properties if specified (before slots, so they always run)
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

      // Create slots if specified
      const slots = params.slots as string[] | undefined
      let slotWarning: string | undefined
      if (slots) {
        const compWithSlot = comp as ComponentNode & {
          createSlot?: (name: string) => void
        }
        if (compWithSlot.createSlot) {
          for (const slotName of slots) {
            compWithSlot.createSlot(slotName)
          }
        } else {
          slotWarning =
            'createSlot is not available in this Figma version; requested slots were not created.'
        }
      }

      const result: Record<string, unknown> = {
        id: comp.id,
        name: comp.name,
        type: comp.type,
        key: comp.key,
      }
      if (slotWarning) result.warning = slotWarning
      return result
    }

    case COMMANDS.CREATE_FROM_SVG: {
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

    case COMMANDS.UPDATE_NODE: {
      const node = await figma.getNodeByIdAsync(
        params.nodeId as string,
      )
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const spec = params.spec as Record<string, unknown>
      const warnings: string[] = []
      const parent = node.parent as ParentNode | null

      // warn-on-no-op: x/y on an auto-layout flow child is ignored by Figma.
      if (
        spec.position !== undefined &&
        parent !== null &&
        'layoutMode' in parent &&
        (parent as FrameNode).layoutMode !== 'NONE' &&
        (node as FrameNode).layoutPositioning !== 'ABSOLUTE'
      ) {
        warnings.push(
          'x/y ignored on an auto-layout child (set layoutPositioning:ABSOLUTE first)',
        )
        delete spec.position
      }

      await applyCommonProperties(
        node as SceneNode,
        spec,
        parent as ParentNode,
      )
      if (node.type === 'TEXT' && spec.text !== undefined) {
        await applyTextProperties(node as TextNode, spec)
      }
      applyPostAppendProperties(node as SceneNode, spec)

      return {
        id: node.id,
        name: node.name,
        type: node.type,
        warnings,
      }
    }

    case COMMANDS.BIND_VARIABLE: {
      const node = await figma.getNodeByIdAsync(
        params.nodeId as string,
      )
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const variable =
        await figma.variables.getVariableByIdAsync(
          params.variableId as string,
        )
      if (!variable) {
        return {
          error: 'Variable not found: ' + params.variableId,
        }
      }
      const field = params.field as string
      const warnings: string[] = []
      const bindable = node as SceneNode & {
        setBoundVariable?: (
          f: VariableBindableNodeField,
          v: Variable,
        ) => void
      }
      // Feature-detect/warn (T7): degrade returns {id,warnings}, NEVER {error}.
      if (typeof bindable.setBoundVariable !== 'function') {
        warnings.push(
          'setBoundVariable unavailable in this Figma version; binding skipped',
        )
        return { id: node.id, warnings }
      }
      try {
        bindable.setBoundVariable(
          field as VariableBindableNodeField,
          variable,
        )
      } catch (e) {
        warnings.push(
          'field "' +
            field +
            '" is not bindable on ' +
            node.type +
            ': ' +
            String(e),
        )
      }
      return { id: node.id, warnings }
    }

    case COMMANDS.GET_VARIABLES: {
      const collectionId = params.collectionId as
        | string
        | undefined
      const collections =
        await figma.variables.getLocalVariableCollectionsAsync()
      const filtered =
        collectionId !== undefined
          ? collections.filter(c => c.id === collectionId)
          : collections
      const results = await Promise.all(
        filtered.map(async c => ({
          id: c.id,
          name: c.name,
          modes: c.modes,
          variables: (
            await Promise.all(
              c.variableIds.map(async id => {
                const v =
                  await figma.variables.getVariableByIdAsync(
                    id,
                  )
                if (!v) {
                  return null
                }
                // aliases: scan valuesByMode for VARIABLE_ALIAS refs.
                const aliases = Object.values(
                  v.valuesByMode,
                ).filter(
                  val =>
                    typeof val === 'object' &&
                    val !== null &&
                    (val as { type?: string }).type ===
                      'VARIABLE_ALIAS',
                )
                return {
                  id: v.id,
                  name: v.name,
                  resolvedType: v.resolvedType,
                  valuesByMode: v.valuesByMode,
                  aliases,
                  scopes: v.scopes,
                  codeSyntax: v.codeSyntax,
                  hiddenFromPublishing:
                    v.hiddenFromPublishing,
                }
              }),
            )
          ).filter(v => v !== null),
        })),
      )
      return { results }
    }

    // list_fonts: group listAvailableFontsAsync() by family, optionally
    // filtered by a case-insensitive family substring.
    case COMMANDS.LIST_FONTS: {
      const fonts = await figma.listAvailableFontsAsync()
      const byFamily: Record<string, string[]> = {}
      for (const f of fonts) {
        const fam = f.fontName.family
        if (!byFamily[fam]) {
          byFamily[fam] = []
        }
        if (!byFamily[fam].includes(f.fontName.style)) {
          byFamily[fam].push(f.fontName.style)
        }
      }
      let results = Object.keys(byFamily).map(family => ({
        family,
        styles: byFamily[family],
      }))
      const fontQuery = params.query as string | undefined
      if (fontQuery !== undefined) {
        const needle = fontQuery.toLowerCase()
        results = results.filter(r =>
          r.family.toLowerCase().includes(needle),
        )
      }
      return { results }
    }

    // get_reactions: prototype reactions on a node. Degrade (NEVER throw) when
    // the node is missing or has no reactions API.
    case COMMANDS.GET_REACTIONS: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node) {
        return {
          nodeId,
          reactions: [],
          warnings: ['Node not found: ' + nodeId],
        }
      }
      if ('reactions' in node) {
        return {
          nodeId,
          reactions:
            (node as SceneNode & { reactions: unknown[] })
              .reactions ?? [],
        }
      }
      return {
        nodeId,
        reactions: [],
        warnings: ['Node has no reactions'],
      }
    }

    // get_plugin_data: this plugin's data on a node; shared data when a
    // namespace is given. Degrade (NEVER throw) when the node is missing.
    case COMMANDS.GET_PLUGIN_DATA: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node || !('getPluginDataKeys' in node)) {
        return {
          nodeId,
          pluginData: {},
          warnings: ['Node not found: ' + nodeId],
        }
      }
      const dataNode = node as BaseNode & PluginDataMixin
      const pluginData = Object.fromEntries(
        dataNode
          .getPluginDataKeys()
          .map(k => [k, dataNode.getPluginData(k)]),
      )
      const namespace = params.namespace as
        | string
        | undefined
      if (namespace !== undefined) {
        const sharedPluginData = Object.fromEntries(
          dataNode
            .getSharedPluginDataKeys(namespace)
            .map(k => [
              k,
              dataNode.getSharedPluginData(namespace, k),
            ]),
        )
        return { nodeId, pluginData, sharedPluginData }
      }
      return { nodeId, pluginData }
    }

    // get_annotations: editorType-gated → degrade (NEVER throw) to an empty
    // Rule-A result with a warning when annotations are unavailable. Annotations
    // live on the NODE (node.annotations), so feature-detect 'annotations' in node.
    case COMMANDS.GET_ANNOTATIONS: {
      const degrade = {
        results: [] as unknown[],
        truncated: false,
        warnings: [
          'Annotations API unavailable in this editor; returning empty.',
        ],
      }
      try {
        const targets: BaseNode[] = []
        if (params.nodeId !== undefined) {
          const node = await figma.getNodeByIdAsync(
            params.nodeId as string,
          )
          if (node) {
            targets.push(node)
          }
        } else {
          for (const sel of figma.currentPage.selection) {
            targets.push(sel)
          }
        }
        const collected: unknown[] = []
        let supported = false
        for (const node of targets) {
          if ('annotations' in node) {
            supported = true
            const anns =
              (
                node as SceneNode & {
                  annotations?: unknown[]
                }
              ).annotations ?? []
            for (const a of anns) {
              collected.push(a)
            }
          }
        }
        if (targets.length > 0 && !supported) {
          return degrade
        }
        return { results: collected, truncated: false }
      } catch {
        return degrade
      }
    }

    // delete_node: capture {id,name,type} BEFORE removing so the reply still
    // describes the now-gone node. Missing node → {error}.
    case COMMANDS.DELETE_NODE: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      const info = {
        id: node.id,
        name: node.name,
        type: node.type,
      }
      node.remove()
      return info
    }

    // set_focus: scroll + zoom the viewport so the resolved nodes are in view.
    // CANVAS only — does not change selection (pair with set_selection). Ids
    // that don't resolve to a scene node are skipped (same guard as
    // set_selection: 'visible' is on every SceneNode, absent on PAGE/DOCUMENT).
    case COMMANDS.SET_FOCUS: {
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id)
        if (n && 'visible' in n) {
          nodes.push(n as SceneNode)
        }
      }
      figma.viewport.scrollAndZoomIntoView(nodes)
      return {
        viewport: {
          center: figma.viewport.center,
          zoom: figma.viewport.zoom,
        },
      }
    }

    // clone_node: node.clone() (count times), optionally reparented into
    // parentId at index. Each clone is appended (or inserted) and reported as
    // {id,name,type}. Missing source/parent → {error}.
    case COMMANDS.CLONE_NODE: {
      const srcId = params.nodeId as string
      const source = await figma.getNodeByIdAsync(srcId)
      if (!source || !('clone' in source)) {
        return {
          error:
            'Node not found or not cloneable: ' + srcId,
        }
      }
      const src = source as SceneNode
      let dest: ParentNode | null =
        src.parent as ParentNode | null
      if (params.parentId !== undefined) {
        const p = await figma.getNodeByIdAsync(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        dest = p as ParentNode
      }
      if (!dest) {
        return {
          error: 'No parent to place the clone under.',
        }
      }
      const count = (params.count as number) ?? 1
      const index = params.index as number | undefined
      const clones: {
        id: string
        name: string
        type: string
      }[] = []
      for (let i = 0; i < count; i++) {
        const clone = src.clone()
        if (index !== undefined) {
          dest.insertChild(index + i, clone)
        } else {
          dest.appendChild(clone)
        }
        clones.push({
          id: clone.id,
          name: clone.name,
          type: clone.type,
        })
      }
      return clones
    }

    // reparent_node: move a node under a new parent (re-flows in the new
    // parent's layout). insertChild at index when given, else appendChild.
    // Missing node/parent → {error}.
    case COMMANDS.REPARENT_NODE: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node || !('parent' in node)) {
        return { error: 'Node not found: ' + nodeId }
      }
      const newParent = await figma.getNodeByIdAsync(
        params.parentId as string,
      )
      if (!newParent || !('appendChild' in newParent)) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const parent = newParent as ParentNode
      const child = node as SceneNode
      const index = params.index as number | undefined
      if (index !== undefined) {
        parent.insertChild(index, child)
      } else {
        parent.appendChild(child)
      }
      return {
        id: child.id,
        name: child.name,
        type: child.type,
        parentId: parent.id,
      }
    }

    // reorder_children: reorder a parent's children to match nodeIds. The id
    // set is SET-EQUALITY validated against the actual children — a mismatch
    // WARNS (T7) and only the ids present in both sets are reordered; we never
    // throw. Reorder via insertChild (re-inserting at the target index moves
    // an existing child). Missing parent → {error}.
    case COMMANDS.REORDER_CHILDREN: {
      const parentId = params.parentId as string
      const parentNode =
        await figma.getNodeByIdAsync(parentId)
      if (!parentNode || !('children' in parentNode)) {
        return {
          error:
            'Parent not found or has no children: ' +
            parentId,
        }
      }
      const parent = parentNode as ParentNode & {
        children: readonly SceneNode[]
      }
      const requested = (params.nodeIds as string[]) ?? []
      const actualIds = parent.children.map(c => c.id)
      const actualSet = new Set(actualIds)
      const requestedSet = new Set(requested)
      const warnings: string[] = []

      const missing = requested.filter(
        id => !actualSet.has(id),
      )
      const extra = actualIds.filter(
        id => !requestedSet.has(id),
      )
      if (missing.length > 0 || extra.length > 0) {
        warnings.push(
          'reorder_children id set differs from the parent children: ' +
            'not children=[' +
            missing.join(',') +
            '], omitted=[' +
            extra.join(',') +
            ']. Only matching ids were reordered.',
        )
      }

      // Reorder only the requested ids that are actually children. Insert each
      // at its target index in turn (insertChild on an existing child moves it).
      const ordered = requested.filter(id =>
        actualSet.has(id),
      )
      let pos = 0
      for (const id of ordered) {
        const child = parent.children.find(c => c.id === id)
        if (child) {
          parent.insertChild(pos, child)
          pos++
        }
      }
      return {
        parentId: parent.id,
        order: parent.children.map(c => c.id),
        warnings,
      }
    }

    // boolean_op: combine ≥2 nodes into a BooleanOperationNode via
    // figma.union/subtract/intersect/exclude. parentId omitted → first node's
    // parent. Missing nodes/parent → {error}.
    case COMMANDS.BOOLEAN_OP: {
      const ids = (params.nodeIds as string[]) ?? []
      const op = params.op as string
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id)
        if (n && 'type' in n) {
          nodes.push(n as SceneNode)
        }
      }
      if (nodes.length < 2) {
        return {
          error:
            'boolean_op requires at least 2 resolvable nodes.',
        }
      }
      let boolParent: ParentNode | null
      if (params.parentId !== undefined) {
        const p = await figma.getNodeByIdAsync(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        boolParent = p as ParentNode
      } else {
        boolParent = nodes[0].parent as ParentNode | null
      }
      if (!boolParent) {
        return {
          error: 'No parent for the boolean result.',
        }
      }
      let boolNode: BooleanOperationNode
      switch (op) {
        case 'UNION':
          boolNode = figma.union(nodes, boolParent)
          break
        case 'SUBTRACT':
          boolNode = figma.subtract(nodes, boolParent)
          break
        case 'INTERSECT':
          boolNode = figma.intersect(nodes, boolParent)
          break
        case 'EXCLUDE':
          boolNode = figma.exclude(nodes, boolParent)
          break
        default:
          return {
            error: 'Unknown boolean op: ' + op,
          }
      }
      return {
        id: boolNode.id,
        name: boolNode.name,
        type: boolNode.type,
      }
    }

    // flatten: flatten ≥1 nodes into a single vector via figma.flatten.
    // parentId omitted → first node's parent. Missing nodes/parent → {error}.
    case COMMANDS.FLATTEN: {
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id)
        if (n && 'type' in n) {
          nodes.push(n as SceneNode)
        }
      }
      if (nodes.length < 1) {
        return {
          error:
            'flatten requires at least 1 resolvable node.',
        }
      }
      let flatParent: ParentNode | null
      if (params.parentId !== undefined) {
        const p = await figma.getNodeByIdAsync(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        flatParent = p as ParentNode
      } else {
        flatParent = nodes[0].parent as ParentNode | null
      }
      if (!flatParent) {
        return {
          error: 'No parent for the flattened result.',
        }
      }
      const vector = figma.flatten(nodes, flatParent)
      return {
        id: vector.id,
        name: vector.name,
        type: vector.type,
      }
    }

    // create_page: add a new page and name it.
    case COMMANDS.CREATE_PAGE: {
      const page = figma.createPage()
      page.name = params.name as string
      return { id: page.id, name: page.name }
    }

    // set_current_page: switch the active page. Missing/non-PAGE → {error}.
    case COMMANDS.SET_CURRENT_PAGE: {
      const pageId = params.pageId as string
      const page = await figma.getNodeByIdAsync(pageId)
      if (!page || page.type !== 'PAGE') {
        return { error: 'Page not found: ' + pageId }
      }
      await figma.setCurrentPageAsync(page as PageNode)
      return {
        currentPage: { id: page.id, name: page.name },
      }
    }

    // duplicate_page: clone an existing page, optionally renaming the clone.
    // Missing/non-PAGE → {error}.
    case COMMANDS.DUPLICATE_PAGE: {
      const pageId = params.pageId as string
      const page = await figma.getNodeByIdAsync(pageId)
      if (!page || page.type !== 'PAGE') {
        return { error: 'Page not found: ' + pageId }
      }
      const dup = (page as PageNode).clone()
      if (params.name !== undefined) {
        dup.name = params.name as string
      }
      return { id: dup.id, name: dup.name }
    }

    // create_image: register an image and return its hash. T7 degrade — when
    // createImageAsync is unavailable or fetching/decoding fails, return
    // {warnings} (NO hash, NO error) so the server reports success-with-warning.
    // Supply EXACTLY ONE of url (fetched via createImageAsync) or bytes
    // (raw bytes via createImage).
    case COMMANDS.CREATE_IMAGE: {
      const url = params.url as string | undefined
      const bytes = params.bytes as number[] | undefined
      if (url !== undefined) {
        if (typeof figma.createImageAsync !== 'function') {
          return {
            warnings: [
              'createImageAsync unavailable in this Figma version; image not created',
            ],
          }
        }
        try {
          const image = await figma.createImageAsync(url)
          return { hash: image.hash }
        } catch (e) {
          return {
            warnings: [
              'createImageAsync failed (network/feature unavailable): ' +
                String(e),
            ],
          }
        }
      }
      if (bytes !== undefined) {
        try {
          const image = figma.createImage(
            new Uint8Array(bytes),
          )
          return { hash: image.hash }
        } catch (e) {
          return {
            warnings: [
              'createImage failed (invalid bytes/feature unavailable): ' +
                String(e),
            ],
          }
        }
      }
      return { error: 'create_image requires url or bytes' }
    }

    // set_plugin_data: write a single plugin-data key (shared when a namespace
    // is given). Missing/incapable node → {error}. Twin of get_plugin_data.
    case COMMANDS.SET_PLUGIN_DATA: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node || !('setPluginData' in node)) {
        return { error: 'Node not found: ' + nodeId }
      }
      const dataNode = node as BaseNode & PluginDataMixin
      const key = params.key as string
      const value = params.value as string
      const namespace = params.namespace as
        | string
        | undefined
      if (namespace !== undefined) {
        dataNode.setSharedPluginData(namespace, key, value)
      } else {
        dataNode.setPluginData(key, value)
      }
      return { id: node.id }
    }

    // set_reactions: replace a node's prototype reactions. T7 — feature-detect
    // setReactionsAsync and degrade to {id,warnings} (NEVER {error}) on a
    // missing API or a failed assignment; only a missing node yields {error}.
    case COMMANDS.SET_REACTIONS: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      const r = node as SceneNode & {
        setReactionsAsync?: (
          reactions: unknown[],
        ) => Promise<void>
      }
      if (typeof r.setReactionsAsync !== 'function') {
        return {
          id: node.id,
          warnings: [
            'setReactionsAsync unavailable in this Figma version; reactions not set',
          ],
        }
      }
      try {
        await r.setReactionsAsync(
          params.reactions as unknown as Reaction[],
        )
        return { id: node.id, warnings: [] }
      } catch (e) {
        return {
          id: node.id,
          warnings: [
            'Failed to set reactions: ' + String(e),
          ],
        }
      }
    }

    // set_annotations: replace a node's annotations. T7 editorType-gated —
    // feature-detect 'annotations' on the node and degrade to {id,warnings}
    // (NEVER {error}/throw) when absent; only a missing node yields {error}.
    case COMMANDS.SET_ANNOTATIONS: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      if (!('annotations' in node)) {
        return {
          id: node.id,
          warnings: [
            'Annotations API unavailable in this editor; annotations not set',
          ],
        }
      }
      try {
        ;(
          node as SceneNode & {
            annotations?: unknown[]
          }
        ).annotations =
          params.annotations as unknown as Annotation[]
        return { id: node.id, warnings: [] }
      } catch (e) {
        return {
          id: node.id,
          warnings: [
            'Failed to set annotations: ' + String(e),
          ],
        }
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
