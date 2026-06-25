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
        // Consistent with the boolean_op tool's strict handling (which returns
        // { error: 'Unknown boolean op' }): reject an unknown op rather than
        // silently defaulting to union. createTreeNode's caller surfaces the
        // throw as the create_tree {error}.
        throw new Error('Unknown boolean op: ' + op)
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

    // create_component (M3-B rebuild): supply EXACTLY ONE source — `spec` (a
    // NodeSpec built first via createSingleNode, then componentized) OR `nodeId`
    // (promote an existing node via createComponentFromNode). The server has
    // already validated the XOR and converted the spec on the grammar write
    // face. Returns {id,key,name,type}.
    case COMMANDS.CREATE_COMPONENT: {
      const ccName = params.name as string | undefined
      const ccDescription = params.description as
        | string
        | undefined
      let sourceNode: SceneNode
      const ccSpec = params.spec as
        | Record<string, unknown>
        | undefined
      if (ccSpec !== undefined) {
        // Build from NodeSpec first, then componentize. Resolve parentId if
        // supplied and able to host children; else use the current page.
        const ccParentNode =
          params.parentId !== undefined
            ? await figma.getNodeByIdAsync(
                params.parentId as string,
              )
            : null
        const ccParent =
          ccParentNode && 'appendChild' in ccParentNode
            ? (ccParentNode as ParentNode)
            : figma.currentPage
        sourceNode = await createSingleNode(
          ccSpec,
          ccParent,
        )
      } else {
        const found = await figma.getNodeByIdAsync(
          params.nodeId as string,
        )
        if (!found) {
          return {
            error: 'Node not found: ' + params.nodeId,
          }
        }
        sourceNode = found as SceneNode
      }
      const comp = figma.createComponentFromNode(sourceNode)
      if (ccName !== undefined) comp.name = ccName
      if (ccDescription !== undefined)
        comp.description = ccDescription
      return {
        id: comp.id,
        key: comp.key,
        name: comp.name,
        type: comp.type,
      }
    }

    // update_component: add/edit/delete componentPropertyDefinitions, set the
    // description, and (T7-gated) expose nested instances. Each step is wrapped
    // so a single failure degrades into a warning rather than aborting the rest.
    case COMMANDS.UPDATE_COMPONENT: {
      const compNode = await figma.getNodeByIdAsync(
        params.componentId as string,
      )
      if (!compNode) {
        return {
          error:
            'Component not found: ' + params.componentId,
        }
      }
      if (
        compNode.type !== 'COMPONENT' &&
        compNode.type !== 'COMPONENT_SET'
      ) {
        return {
          error:
            'Node is not a component or component set: ' +
            params.componentId,
        }
      }
      const comp = compNode as
        | ComponentNode
        | ComponentSetNode
      const ucWarnings: string[] = []
      // add. addComponentProperty returns the CANONICAL property id
      // (e.g. "Label#1:0") that agents need for later setProperties — surface
      // each {name,id} rather than discarding it.
      const ucAdded: { name: string; id: string }[] = []
      const addProps = params.add as
        | {
            name: string
            type: string
            defaultValue: string | boolean
          }[]
        | undefined
      if (addProps) {
        for (const p of addProps) {
          try {
            const propId = comp.addComponentProperty(
              p.name,
              p.type as ComponentPropertyType,
              p.defaultValue,
            )
            ucAdded.push({ name: p.name, id: propId })
          } catch (e) {
            ucWarnings.push(
              'Failed to add property "' +
                p.name +
                '": ' +
                String(e),
            )
          }
        }
      }
      // edit
      const editProps = params.edit as
        | {
            name: string
            newName?: string
            defaultValue?: string | boolean
          }[]
        | undefined
      if (editProps) {
        for (const p of editProps) {
          try {
            const opts: {
              name?: string
              defaultValue?: string | boolean
            } = {}
            if (p.newName !== undefined)
              opts.name = p.newName
            if (p.defaultValue !== undefined)
              opts.defaultValue = p.defaultValue
            comp.editComponentProperty(p.name, opts)
          } catch (e) {
            ucWarnings.push(
              'Failed to edit property "' +
                p.name +
                '": ' +
                String(e),
            )
          }
        }
      }
      // delete
      const delProps = params.delete as string[] | undefined
      if (delProps) {
        for (const name of delProps) {
          try {
            comp.deleteComponentProperty(name)
          } catch (e) {
            ucWarnings.push(
              'Failed to delete property "' +
                name +
                '": ' +
                String(e),
            )
          }
        }
      }
      // description
      if (params.description !== undefined) {
        comp.description = params.description as string
      }
      // expose nested instances (T7-gated)
      const exposeIds = params.expose as
        | string[]
        | undefined
      if (exposeIds && exposeIds.length > 0) {
        for (const eid of exposeIds) {
          const en = await figma.getNodeByIdAsync(eid)
          const exposable = en as
            | (InstanceNode & {
                isExposedInstance?: boolean
              })
            | null
          if (
            exposable &&
            'isExposedInstance' in exposable
          ) {
            try {
              ;(
                exposable as { isExposedInstance: boolean }
              ).isExposedInstance = true
            } catch (e) {
              ucWarnings.push(
                'Failed to expose instance "' +
                  eid +
                  '": ' +
                  String(e),
              )
            }
          } else {
            ucWarnings.push(
              'exposeNestedInstances unavailable for "' +
                eid +
                '"; expose skipped',
            )
          }
        }
      }
      return {
        id: comp.id,
        propertyDefinitions:
          comp.componentPropertyDefinitions,
        added: ucAdded,
        warnings: ucWarnings,
      }
    }

    // combine_variants: combine ≥2 components into a variant set. Resolves the
    // parent (parentId else the first component's parent) and combines. Ids that
    // aren't found / aren't a COMPONENT are DROPPED with a warning (honest
    // partial success — never silently swallowed); a requested parent that can't
    // bear children is also reported rather than silently ignored.
    case COMMANDS.COMBINE_VARIANTS: {
      const cvIds = (params.componentIds as string[]) ?? []
      const cvComps: ComponentNode[] = []
      const cvDropped: string[] = []
      const cvWarnings: string[] = []
      for (const cid of cvIds) {
        const n = await figma.getNodeByIdAsync(cid)
        if (n && n.type === 'COMPONENT') {
          cvComps.push(n as ComponentNode)
        } else {
          cvDropped.push(cid)
        }
      }
      if (cvDropped.length > 0) {
        cvWarnings.push(
          'combine_variants ignored ' +
            cvDropped.length +
            ' id(s) that are not a COMPONENT: ' +
            cvDropped.join(', '),
        )
      }
      if (cvComps.length < 2) {
        return {
          error:
            'Need at least 2 components for combine_variants',
        }
      }
      const cvParentNode =
        params.parentId !== undefined
          ? await figma.getNodeByIdAsync(
              params.parentId as string,
            )
          : cvComps[0].parent
      let cvParent: BaseNode & ChildrenMixin
      if (cvParentNode && 'appendChild' in cvParentNode) {
        cvParent = cvParentNode as BaseNode & ChildrenMixin
      } else {
        if (params.parentId !== undefined) {
          cvWarnings.push(
            'Requested parent "' +
              String(params.parentId) +
              '" cannot contain the variant set; used the first component\'s parent instead.',
          )
        }
        cvParent = cvComps[0].parent as BaseNode &
          ChildrenMixin
      }
      const cs = figma.combineAsVariants(cvComps, cvParent)
      if (params.name !== undefined)
        cs.name = params.name as string
      return {
        id: cs.id,
        name: cs.name,
        type: cs.type,
        variantAxes: cs.variantGroupProperties,
        warnings: cvWarnings,
      }
    }

    // swap_component: point an instance at a different main component. swap
    // failures degrade into a warning (T7) — never throw.
    case COMMANDS.SWAP_COMPONENT: {
      const scInst = await figma.getNodeByIdAsync(
        params.instanceId as string,
      )
      if (!scInst) {
        return {
          error: 'Instance not found: ' + params.instanceId,
        }
      }
      if (scInst.type !== 'INSTANCE') {
        return {
          error:
            'Node is not an instance: ' + params.instanceId,
        }
      }
      const scMain = await figma.getNodeByIdAsync(
        params.mainComponentId as string,
      )
      if (!scMain || scMain.type !== 'COMPONENT') {
        return {
          error:
            'Main component not found: ' +
            params.mainComponentId,
        }
      }
      const scWarnings: string[] = []
      const inst = scInst as InstanceNode
      try {
        inst.swapComponent(scMain as ComponentNode)
      } catch (e) {
        scWarnings.push(
          'swapComponent failed: ' + String(e),
        )
      }
      const swapped = await inst
        .getMainComponentAsync()
        .catch(() => null)
      return {
        id: inst.id,
        mainComponent: swapped ? swapped.id : scMain.id,
        warnings: scWarnings,
      }
    }

    // set_instance: set instance properties via setProperties and/or apply
    // per-node overrides. setProperties failures degrade (T7); per-node override
    // application is limited via the plugin API → warn rather than fail.
    case COMMANDS.SET_INSTANCE: {
      const siInst = await figma.getNodeByIdAsync(
        params.instanceId as string,
      )
      if (!siInst) {
        return {
          error: 'Instance not found: ' + params.instanceId,
        }
      }
      if (siInst.type !== 'INSTANCE') {
        return {
          error:
            'Node is not an instance: ' + params.instanceId,
        }
      }
      const inst2 = siInst as InstanceNode
      const siWarnings: string[] = []
      const siProps = params.properties as
        | Record<string, string | boolean>
        | undefined
      if (siProps && Object.keys(siProps).length > 0) {
        try {
          inst2.setProperties(siProps)
        } catch (e) {
          siWarnings.push(
            'setProperties failed: ' + String(e),
          )
        }
      }
      const siOverrides = params.overrides as
        | { path: string; field: string; value: string }[]
        | undefined
      if (siOverrides && siOverrides.length > 0) {
        siWarnings.push(
          'Per-node overrides are not yet applied; ' +
            siOverrides.length +
            ' override(s) skipped',
        )
      }
      return {
        id: inst2.id,
        componentProperties: inst2.componentProperties,
        warnings: siWarnings,
      }
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

    // create_variables: create a collection (+ optional extra modes), then its
    // variables with per-mode values. The server has already CONVERTED COLOR
    // values to {r,g,b,a}; FLOAT/STRING/BOOLEAN pass through. valuesByMode is
    // keyed by mode NAME — resolved to mode ids against the collection's modes
    // (an unknown mode name is reported as a warning, never throws). T7:
    // feature-detect createVariableCollection / createVariable / setValueForMode.
    case COMMANDS.CREATE_VARIABLES: {
      const vars = figma.variables as VariablesAPI & {
        createVariableCollection?: (
          name: string,
        ) => VariableCollection
        createVariable?: (
          name: string,
          collection: VariableCollection,
          type: VariableResolvedDataType,
        ) => Variable
      }
      if (
        typeof vars.createVariableCollection !== 'function'
      ) {
        return {
          error:
            'Variables API unavailable in this Figma version',
        }
      }
      // T7: the collection-level factory failing is a genuine failure (nothing
      // to return) → {error}, not a degrade.
      let collection: VariableCollection
      try {
        collection = vars.createVariableCollection(
          params.collection as string,
        )
      } catch (e) {
        return {
          error:
            'createVariableCollection failed for "' +
            String(params.collection) +
            '": ' +
            String(e),
        }
      }
      const warnings: string[] = []

      // Build the mode NAME → modeId map. The collection starts with one
      // default mode; the first requested mode renames it, the rest are added.
      const requestedModes =
        (params.modes as string[] | undefined) ?? []
      if (requestedModes.length > 0) {
        if (typeof collection.renameMode === 'function') {
          collection.renameMode(
            collection.modes[0].modeId,
            requestedModes[0],
          )
        }
        for (const modeName of requestedModes.slice(1)) {
          if (typeof collection.addMode === 'function') {
            try {
              collection.addMode(modeName)
            } catch (e) {
              warnings.push(
                'addMode failed for "' +
                  modeName +
                  '": ' +
                  String(e),
              )
            }
          } else {
            warnings.push(
              'addMode unavailable in this Figma version; mode "' +
                modeName +
                '" not added',
            )
          }
        }
      }
      const modeByName: Record<string, string> = {}
      for (const m of collection.modes) {
        modeByName[m.name] = m.modeId
      }

      const inVars =
        (params.variables as
          | {
              name: string
              type: VariableResolvedDataType
              valuesByMode: Record<string, unknown>
            }[]
          | undefined) ?? []
      const created: { id: string; name: string }[] = []
      for (const spec of inVars) {
        if (typeof vars.createVariable !== 'function') {
          warnings.push(
            'createVariable unavailable; variable "' +
              spec.name +
              '" not created',
          )
          continue
        }
        // T7: a single per-variable create FAILING degrades to a warning and the
        // batch continues (never a throw, never {error} — that is reserved for
        // the collection-level factory above).
        let variable: Variable
        try {
          variable = vars.createVariable(
            spec.name,
            collection,
            spec.type,
          )
        } catch (e) {
          warnings.push(
            'createVariable failed for variable "' +
              spec.name +
              '": ' +
              String(e),
          )
          continue
        }
        for (const [modeName, value] of Object.entries(
          spec.valuesByMode,
        )) {
          const modeId = modeByName[modeName]
          if (modeId === undefined) {
            warnings.push(
              'unknown mode "' +
                modeName +
                '" for variable "' +
                spec.name +
                '"; value skipped',
            )
            continue
          }
          if (
            typeof variable.setValueForMode === 'function'
          ) {
            // T7: a setValueForMode REJECTION (e.g. a type-incompatible value
            // reaching a COLOR variable) degrades to a warning, never throws.
            try {
              variable.setValueForMode(
                modeId,
                value as VariableValue,
              )
            } catch (e) {
              warnings.push(
                'setValueForMode failed for variable "' +
                  spec.name +
                  '" mode "' +
                  modeName +
                  '": ' +
                  String(e),
              )
            }
          } else {
            warnings.push(
              'setValueForMode unavailable; value for "' +
                spec.name +
                '" not set',
            )
          }
        }
        created.push({
          id: variable.id,
          name: variable.name,
        })
      }

      return {
        collectionId: collection.id,
        modes: collection.modes,
        variables: created,
        warnings,
      }
    }

    // update_variables: mode lifecycle (addModes/removeModes/renameModes) +
    // per-variable edits (values, scopes, codeSyntax, hiddenFromPublishing) on
    // an existing collection. COLOR value edits arrive pre-converted from the
    // server. Each gated member is feature-detected and degrades with a warning
    // (T7); only a missing collection yields {error}.
    case COMMANDS.UPDATE_VARIABLES: {
      const collectionId = params.collectionId as string
      const collection =
        await figma.variables.getVariableCollectionByIdAsync(
          collectionId,
        )
      if (!collection) {
        return {
          error: 'Collection not found: ' + collectionId,
        }
      }
      const warnings: string[] = []

      // renameModes / removeModes match a mode by NAME first, then by id.
      const findModeId = (
        ref: string,
      ): string | undefined => {
        const byName = collection.modes.find(
          m => m.name === ref,
        )
        if (byName) {
          return byName.modeId
        }
        const byId = collection.modes.find(
          m => m.modeId === ref,
        )
        return byId?.modeId
      }

      for (const modeName of (params.addModes as
        | string[]
        | undefined) ?? []) {
        if (typeof collection.addMode === 'function') {
          try {
            collection.addMode(modeName)
          } catch (e) {
            warnings.push(
              'addMode failed for "' +
                modeName +
                '": ' +
                String(e),
            )
          }
        } else {
          warnings.push(
            'addMode unavailable in this Figma version; mode "' +
              modeName +
              '" not added',
          )
        }
      }
      for (const rename of (params.renameModes as
        | { from: string; to: string }[]
        | undefined) ?? []) {
        const modeId = findModeId(rename.from)
        if (modeId === undefined) {
          warnings.push(
            'mode "' +
              rename.from +
              '" not found; not renamed',
          )
        } else if (
          typeof collection.renameMode === 'function'
        ) {
          collection.renameMode(modeId, rename.to)
        } else {
          warnings.push(
            'renameMode unavailable; mode "' +
              rename.from +
              '" not renamed',
          )
        }
      }
      for (const modeRef of (params.removeModes as
        | string[]
        | undefined) ?? []) {
        const modeId = findModeId(modeRef)
        if (modeId === undefined) {
          warnings.push(
            'mode "' + modeRef + '" not found; not removed',
          )
        } else if (
          typeof collection.removeMode === 'function'
        ) {
          try {
            collection.removeMode(modeId)
          } catch (e) {
            warnings.push(
              'removeMode failed for "' +
                modeRef +
                '": ' +
                String(e),
            )
          }
        } else {
          warnings.push(
            'removeMode unavailable; mode "' +
              modeRef +
              '" not removed',
          )
        }
      }

      // Re-read modes after lifecycle edits for value-by-name resolution.
      const modeByName: Record<string, string> = {}
      for (const m of collection.modes) {
        modeByName[m.name] = m.modeId
      }

      for (const edit of (params.variables as
        | {
            id: string
            valuesByMode?: Record<string, unknown>
            scopes?: string[]
            codeSyntax?: Record<string, string>
            hiddenFromPublishing?: boolean
          }[]
        | undefined) ?? []) {
        const variable =
          await figma.variables.getVariableByIdAsync(
            edit.id,
          )
        if (!variable) {
          warnings.push('variable not found: ' + edit.id)
          continue
        }
        if (edit.valuesByMode !== undefined) {
          for (const [modeName, value] of Object.entries(
            edit.valuesByMode,
          )) {
            const modeId =
              modeByName[modeName] ?? findModeId(modeName)
            if (modeId === undefined) {
              warnings.push(
                'unknown mode "' +
                  modeName +
                  '" for variable ' +
                  edit.id +
                  '; value skipped',
              )
              continue
            }
            if (
              typeof variable.setValueForMode === 'function'
            ) {
              // T7: a setValueForMode REJECTION (e.g. a type-incompatible value
              // reaching a COLOR variable) degrades to a warning, never throws.
              try {
                variable.setValueForMode(
                  modeId,
                  value as VariableValue,
                )
              } catch (e) {
                warnings.push(
                  'setValueForMode failed for variable ' +
                    edit.id +
                    ' mode "' +
                    modeName +
                    '": ' +
                    String(e),
                )
              }
            } else {
              warnings.push(
                'setValueForMode unavailable; value not set on ' +
                  edit.id,
              )
            }
          }
        }
        if (edit.scopes !== undefined) {
          try {
            variable.scopes = edit.scopes as VariableScope[]
          } catch (e) {
            warnings.push(
              'scopes not settable on ' +
                edit.id +
                ': ' +
                String(e),
            )
          }
        }
        if (edit.codeSyntax !== undefined) {
          if (
            typeof variable.setVariableCodeSyntax ===
            'function'
          ) {
            for (const [platform, value] of Object.entries(
              edit.codeSyntax,
            )) {
              try {
                variable.setVariableCodeSyntax(
                  platform as CodeSyntaxPlatform,
                  value,
                )
              } catch (e) {
                warnings.push(
                  'codeSyntax not set (' +
                    platform +
                    ') on ' +
                    edit.id +
                    ': ' +
                    String(e),
                )
              }
            }
          } else {
            warnings.push(
              'setVariableCodeSyntax unavailable; codeSyntax not set on ' +
                edit.id,
            )
          }
        }
        if (edit.hiddenFromPublishing !== undefined) {
          try {
            variable.hiddenFromPublishing =
              edit.hiddenFromPublishing
          } catch (e) {
            warnings.push(
              'hiddenFromPublishing not settable on ' +
                edit.id +
                ': ' +
                String(e),
            )
          }
        }
      }

      return {
        collectionId: collection.id,
        modes: collection.modes,
        warnings,
      }
    }

    // create_styles: create one paint/text/effect/grid style from the
    // server-CONVERTED value (paint→Paint, text→FontName, effect→Effect,
    // grid→LayoutGrid). loadFontAsync first for text styles. T7: feature-detect
    // the createXStyle factory.
    case COMMANDS.CREATE_STYLES: {
      const styleType = params.type as
        | 'paint'
        | 'text'
        | 'effect'
        | 'grid'
      const styleName = params.name as string
      const styleValue = params.value
      const styleDesc = params.description as
        | string
        | undefined

      if (styleType === 'paint') {
        if (typeof figma.createPaintStyle !== 'function') {
          return {
            error: 'createPaintStyle unavailable',
          }
        }
        const style = figma.createPaintStyle()
        style.name = styleName
        if (styleDesc !== undefined) {
          style.description = styleDesc
        }
        style.paints = [styleValue as Paint]
        return {
          id: style.id,
          key: style.key,
          name: style.name,
          type: 'paint',
        }
      }
      if (styleType === 'text') {
        if (typeof figma.createTextStyle !== 'function') {
          return { error: 'createTextStyle unavailable' }
        }
        const font = styleValue as {
          family: string
          style: string
          size: number
          lineHeight?: LineHeight
          letterSpacing?: LetterSpacing
        }
        await figma.loadFontAsync({
          family: font.family,
          style: font.style,
        })
        const style = figma.createTextStyle()
        style.name = styleName
        if (styleDesc !== undefined) {
          style.description = styleDesc
        }
        style.fontName = {
          family: font.family,
          style: font.style,
        }
        style.fontSize = font.size
        if (font.lineHeight !== undefined) {
          style.lineHeight = font.lineHeight
        }
        if (font.letterSpacing !== undefined) {
          style.letterSpacing = font.letterSpacing
        }
        return {
          id: style.id,
          key: style.key,
          name: style.name,
          type: 'text',
        }
      }
      if (styleType === 'effect') {
        if (typeof figma.createEffectStyle !== 'function') {
          return { error: 'createEffectStyle unavailable' }
        }
        const style = figma.createEffectStyle()
        style.name = styleName
        if (styleDesc !== undefined) {
          style.description = styleDesc
        }
        style.effects = [styleValue as Effect]
        return {
          id: style.id,
          key: style.key,
          name: style.name,
          type: 'effect',
        }
      }
      // grid
      if (typeof figma.createGridStyle !== 'function') {
        return { error: 'createGridStyle unavailable' }
      }
      const gridStyle = figma.createGridStyle()
      gridStyle.name = styleName
      if (styleDesc !== undefined) {
        gridStyle.description = styleDesc
      }
      gridStyle.layoutGrids = [styleValue as LayoutGrid]
      return {
        id: gridStyle.id,
        key: gridStyle.key,
        name: gridStyle.name,
        type: 'grid',
      }
    }

    // update_styles: edit an existing style's value/name/description. The server
    // sends the CONVERTED value + the inferred valueType; the plugin resolves the
    // style, validates valueType against the style's actual type (warns on
    // mismatch, T7), and assigns. Missing style → {error}.
    case COMMANDS.UPDATE_STYLES: {
      const styleId = params.styleId as string
      const style = await figma.getStyleByIdAsync(styleId)
      if (!style) {
        return { error: 'Style not found: ' + styleId }
      }
      const warnings: string[] = []
      if (params.name !== undefined) {
        style.name = params.name as string
      }
      if (params.description !== undefined) {
        style.description = params.description as string
      }
      if (params.value !== undefined) {
        const valueType = params.valueType as
          | 'paint'
          | 'text'
          | 'effect'
          | 'grid'
          | undefined
        const actual = {
          PAINT: 'paint',
          TEXT: 'text',
          EFFECT: 'effect',
          GRID: 'grid',
        }[style.type]
        if (
          valueType !== undefined &&
          valueType !== actual
        ) {
          warnings.push(
            'value looks like a ' +
              valueType +
              ' atom but the style is ' +
              actual +
              '; value not applied',
          )
        } else if (style.type === 'PAINT') {
          ;(style as PaintStyle).paints = [
            params.value as Paint,
          ]
        } else if (style.type === 'TEXT') {
          const font = params.value as {
            family: string
            style: string
            size: number
            lineHeight?: LineHeight
            letterSpacing?: LetterSpacing
          }
          await figma.loadFontAsync({
            family: font.family,
            style: font.style,
          })
          const ts = style as TextStyle
          ts.fontName = {
            family: font.family,
            style: font.style,
          }
          ts.fontSize = font.size
          if (font.lineHeight !== undefined) {
            ts.lineHeight = font.lineHeight
          }
          if (font.letterSpacing !== undefined) {
            ts.letterSpacing = font.letterSpacing
          }
        } else if (style.type === 'EFFECT') {
          ;(style as EffectStyle).effects = [
            params.value as Effect,
          ]
        } else if (style.type === 'GRID') {
          ;(style as GridStyle).layoutGrids = [
            params.value as LayoutGrid,
          ]
        }
      }
      return { id: style.id, warnings }
    }

    // apply_style: bind a style to a node field via the matching async setter.
    // T7: feature-detect the setter on the node and degrade with a warning when
    // it is unavailable (NEVER {error}); only a missing node yields {error}.
    case COMMANDS.APPLY_STYLE: {
      const nodeId = params.nodeId as string
      const node = await figma.getNodeByIdAsync(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      const styleId = params.styleId as string
      const field = params.field as
        | 'fill'
        | 'stroke'
        | 'text'
        | 'effect'
        | 'grid'
      const setterName = {
        fill: 'setFillStyleIdAsync',
        stroke: 'setStrokeStyleIdAsync',
        text: 'setTextStyleIdAsync',
        effect: 'setEffectStyleIdAsync',
        grid: 'setGridStyleIdAsync',
      }[field]
      const warnings: string[] = []
      const styled = node as unknown as Record<
        string,
        (id: string) => Promise<void>
      >
      if (typeof styled[setterName] !== 'function') {
        warnings.push(
          setterName +
            ' unavailable on ' +
            node.type +
            '; style not applied',
        )
        return { id: node.id, warnings }
      }
      try {
        await styled[setterName](styleId)
      } catch (e) {
        warnings.push(
          field +
            ' style not applicable on ' +
            node.type +
            ': ' +
            String(e),
        )
      }
      return { id: node.id, warnings }
    }

    // batch (M3-D): N WRITE ops over existing targets, executed in ARRAY ORDER
    // with PARTIAL SUCCESS. The server has already CONVERTED each op's params
    // (atom leaves → Figma objects) and tagged each with its command, so the
    // plugin simply re-dispatches each through handleCommand (the same switch)
    // and collects a per-op {ok,result|error}. One failing op does NOT abort the
    // rest: a handler returning {error} OR a thrown exception is isolated to that
    // entry. Returns { results: [{ok,result|error}] } index-aligned with ops.
    case COMMANDS.BATCH: {
      const batchOps =
        (params.ops as
          | {
              op: string
              params: Record<string, unknown>
            }[]
          | undefined) ?? []
      const results: {
        ok: boolean
        result?: unknown
        error?: string
      }[] = []
      for (const entry of batchOps) {
        try {
          const opResult = await handleCommand(
            entry.op,
            entry.params ?? {},
          )
          // A handler that returns {error} (e.g. node not found) is a per-op
          // failure, not a success — surface it as this entry's error.
          if (
            opResult !== null &&
            typeof opResult === 'object' &&
            (opResult as { error?: string }).error !==
              undefined
          ) {
            results.push({
              ok: false,
              error: (opResult as { error: string }).error,
            })
          } else {
            results.push({ ok: true, result: opResult })
          }
        } catch (e) {
          results.push({ ok: false, error: String(e) })
        }
      }
      return { results }
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
