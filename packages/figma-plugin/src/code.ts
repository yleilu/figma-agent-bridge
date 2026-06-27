import { COMMANDS } from '@figma-agent-bridge/shared'

import { applyLayout, type AppliedLayout } from './apply-layout'
import { projectComponentDefs } from './project-component-defs'

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
  warnings?: string[],
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

  // Corner radius — guard on capability so an incompatible node (e.g. a SLICE)
  // warns-and-continues in update_node rather than throwing → {error}.
  if (spec.radius !== undefined && 'cornerRadius' in node) {
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
  if (
    spec.clipsContent !== undefined &&
    'clipsContent' in node
  ) {
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

  // Layout (FRAME only). Partial layouts are honored: each field is applied
  // only when present, mirroring the server writer's PURE contract (see
  // apply-layout.ts).
  if (spec.layout !== undefined && 'layoutMode' in node) {
    applyLayout(node as FrameNode, spec.layout as AppliedLayout)
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

  // Constraints. The server writer emits the ARRAY form [horizontal, vertical]
  // (Plugin-API vocab: MIN/MAX/CENTER/STRETCH/SCALE); Figma's setter wants the
  // OBJECT form {horizontal, vertical}. Capability-guard so an incompatible node
  // (e.g. a node without ConstraintMixin) warns-and-continues (T7) rather than
  // throwing → {error}, matching the warn-on-no-op pattern.
  if (spec.constraints !== undefined) {
    if ('constraints' in node) {
      const [h, v] = spec.constraints as [string, string]
      ;(node as ConstraintMixin & SceneNode).constraints = {
        horizontal: h as ConstraintType,
        vertical: v as ConstraintType,
      }
    } else {
      warnings?.push(
        'constraints ignored — not supported on a ' +
          node.type +
          ' node',
      )
    }
  }

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
  warnings?: string[],
): void => {
  // These must be set AFTER appendChild to auto-layout parent. On update_node
  // the target is an arbitrary pre-existing node, so an incompatible context
  // (e.g. layoutSizing on a child of a non-auto-layout parent) would THROW.
  // T7: degrade with a warning and continue rather than throwing → {error},
  // matching the x/y warn-and-continue path.

  // Sizing
  if (spec.sizing !== undefined) {
    const [h, v] = spec.sizing as [string, string]
    try {
      ;(node as FrameNode).layoutSizingHorizontal = h as
        | 'FIXED'
        | 'HUG'
        | 'FILL'
      ;(node as FrameNode).layoutSizingVertical = v as
        | 'FIXED'
        | 'HUG'
        | 'FILL'
    } catch (e) {
      warnings?.push(
        'sizing not applicable on this node (' +
          node.type +
          '): ' +
          String(e),
      )
    }
  }

  // Layout positioning (ABSOLUTE)
  if (spec.layoutPositioning !== undefined) {
    try {
      ;(node as FrameNode).layoutPositioning =
        spec.layoutPositioning as 'AUTO' | 'ABSOLUTE'
    } catch (e) {
      warnings?.push(
        'layoutPositioning not applicable on this node (' +
          node.type +
          '): ' +
          String(e),
      )
    }
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
  warnings?: string[],
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
      const compRef = spec.component as
        | {
            key?: string
            id?: string
            properties?: Record<string, string | boolean>
          }
        | undefined
      // Resolve the main component either by LOCAL node id or by published
      // KEY. A COMPONENT_SET resolves to its defaultVariant (you instance a
      // variant, not the set itself).
      let component: ComponentNode | undefined
      if (compRef?.id !== undefined) {
        const found = await figma.getNodeByIdAsync(
          compRef.id,
        )
        if (found === null) {
          throw new Error(
            'INSTANCE component.id not found: ' + compRef.id,
          )
        }
        if (found.type === 'COMPONENT') {
          component = found
        } else if (found.type === 'COMPONENT_SET') {
          component = found.defaultVariant ?? undefined
          if (component === undefined) {
            throw new Error(
              'INSTANCE component.id is a COMPONENT_SET with no default variant: ' +
                compRef.id,
            )
          }
        } else {
          throw new Error(
            'INSTANCE component.id must reference a COMPONENT or COMPONENT_SET, got ' +
              found.type +
              ': ' +
              compRef.id,
          )
        }
      } else if (compRef?.key !== undefined) {
        component = await figma.importComponentByKeyAsync(
          compRef.key,
        )
      } else {
        throw new Error(
          'INSTANCE requires component.id (local component node) or component.key (published/library component)',
        )
      }
      const instance = component.createInstance()
      if (compRef.properties) {
        instance.setProperties(compRef.properties)
      }
      node = instance
      break
    }
    // NOTE (issue #3): the TEXT_PATH case was removed here. figma.createTextPath
    // is a real API but its fields (vectorNodeId/startSegment/startPosition) were
    // never specced/wired, so the server now rejects type:'TEXT_PATH' up front
    // against CREATABLE_TYPES (shared by create_node and create_tree) — this
    // handler was unreachable. Deferred to the spec-completeness phase; see
    // docs/deferred-capabilities.md.
    case 'SLOT': {
      // SLOT in create_node context: create a FRAME placeholder and WARN (T7) —
      // the agent asked for a SLOT and is getting a FRAME, so it must be told.
      // Actual SLOT promotion happens in create_component via component.createSlot().
      node = figma.createFrame()
      warnings?.push(
        'SLOT requested via create_node was created as a FRAME placeholder; real SLOT promotion happens in create_component via component.createSlot()',
      )
      break
    }
    default:
      throw new Error('Unsupported node type: ' + type)
  }

  // Apply common properties (fills, strokes, effects, etc.)
  await applyCommonProperties(node, spec, parent, warnings)

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
  // refStack tracks the chain of { ref } keys currently being resolved so a
  // cyclic pool (a→b→a, or a self-ref) is caught and rejected as a clean
  // {error} instead of recursing forever and freezing the Figma UI.
  refStack: string[] = [],
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
    if (refStack.includes(refKey)) {
      throw new Error(
        'Cyclic ref in pool: ' +
          [...refStack, refKey].join(' -> '),
      )
    }
    return createTreeNode(refSpec, parent, refs, [
      ...refStack,
      refKey,
    ])
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

  // NOTE (issue #2): the composite-via-children cases (GROUP, TRANSFORM_GROUP,
  // BOOLEAN_OPERATION) were removed. The server now rejects these unspecced
  // types up front in create-tree.ts (against the SAME CREATABLE_TYPES list
  // create_node uses), so they can never reach this create-type switch. Their
  // handlers here were unreachable — the ref ({ ref }) and clone ({ id }) paths
  // above return before this point, so a clone-by-id of an existing
  // BOOLEAN_OPERATION / GROUP still works. Booleans are authored via boolean_op.

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
        refStack,
      )
    }
  }

  return node
}

// Apply per-variable metadata (aliases / scopes / codeSyntax /
// hiddenFromPublishing) — the SHARED apply path mirroring update_variables'
// per-variable edits, used by create_variables so create reaches parity with
// update. Each member is feature-detected and degrades with a warning (T7),
// never throwing. `aliases` maps a mode NAME → target variable id; that mode is
// set to a VARIABLE_ALIAS of the target via setValueForMode (async target read).
const applyVariableMeta = async (
  variable: Variable,
  meta: {
    name: string
    aliases?: Record<string, string>
    scopes?: string[]
    codeSyntax?: Record<string, string>
    hiddenFromPublishing?: boolean
  },
  modeByName: Record<string, string>,
  warnings: string[],
): Promise<void> => {
  if (meta.aliases !== undefined) {
    const aliasFactory = (
      figma.variables as VariablesAPI & {
        createVariableAlias?: (v: Variable) => VariableAlias
      }
    ).createVariableAlias
    for (const [modeName, targetId] of Object.entries(
      meta.aliases,
    )) {
      const modeId = modeByName[modeName]
      if (modeId === undefined) {
        warnings.push(
          'unknown mode "' +
            modeName +
            '" for variable "' +
            meta.name +
            '" alias; skipped',
        )
        continue
      }
      if (
        typeof aliasFactory !== 'function' ||
        typeof variable.setValueForMode !== 'function'
      ) {
        warnings.push(
          'createVariableAlias unavailable; alias for "' +
            meta.name +
            '" not set',
        )
        continue
      }
      try {
        const target =
          await figma.variables.getVariableByIdAsync(
            targetId,
          )
        if (!target) {
          warnings.push(
            'alias target not found: ' +
              targetId +
              ' for variable "' +
              meta.name +
              '"',
          )
          continue
        }
        variable.setValueForMode(
          modeId,
          aliasFactory(target),
        )
      } catch (e) {
        warnings.push(
          'alias not set for variable "' +
            meta.name +
            '" mode "' +
            modeName +
            '": ' +
            String(e),
        )
      }
    }
  }
  if (meta.scopes !== undefined) {
    try {
      variable.scopes = meta.scopes as VariableScope[]
    } catch (e) {
      warnings.push(
        'scopes not settable on "' +
          meta.name +
          '": ' +
          String(e),
      )
    }
  }
  if (meta.codeSyntax !== undefined) {
    if (
      typeof variable.setVariableCodeSyntax === 'function'
    ) {
      for (const [platform, value] of Object.entries(
        meta.codeSyntax,
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
              ') on "' +
              meta.name +
              '": ' +
              String(e),
          )
        }
      }
    } else {
      warnings.push(
        'setVariableCodeSyntax unavailable; codeSyntax not set on "' +
          meta.name +
          '"',
      )
    }
  }
  if (meta.hiddenFromPublishing !== undefined) {
    try {
      variable.hiddenFromPublishing =
        meta.hiddenFromPublishing
    } catch (e) {
      warnings.push(
        'hiddenFromPublishing not settable on "' +
          meta.name +
          '": ' +
          String(e),
      )
    }
  }
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

    // status (D1): the LIVE context the user is looking at — current page,
    // selection, and viewport. Connection state (connected/channel) is added
    // SERVER-side; this case supplies only the plugin-known live context. This
    // is the documented READ path for the viewport (set_focus is the writer).
    case COMMANDS.STATUS:
      return {
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
        selection: figma.currentPage.selection.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
        })),
        viewport: {
          center: figma.viewport.center,
          zoom: figma.viewport.zoom,
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
      const skipped: string[] = []
      const offPage: string[] = []
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id)
        // Only scene nodes are selectable; `visible` is present on every
        // SceneNode and absent on PAGE/DOCUMENT, so it's a sound guard.
        if (!n || !('visible' in n)) {
          skipped.push(id)
          continue
        }
        // getNodeByIdAsync resolves nodes on ANY page, but the selection can
        // only hold nodes on the current page. T7: a cross-page id degrades to
        // a warning (skipped) rather than throwing on assignment.
        const sn = n as SceneNode
        let onCurrentPage = false
        let walk: BaseNode | null = sn
        while (walk !== null) {
          if (walk === figma.currentPage) {
            onCurrentPage = true
            break
          }
          walk = walk.parent
        }
        if (onCurrentPage) {
          nodes.push(sn)
        } else {
          offPage.push(id)
        }
      }
      figma.currentPage.selection = nodes
      const warnings: string[] = []
      if (skipped.length > 0) {
        warnings.push(
          'skipped ' +
            skipped.length +
            ' unresolved id(s): ' +
            skipped.join(', '),
        )
      }
      if (offPage.length > 0) {
        warnings.push(
          'skipped ' +
            offPage.length +
            ' cross-page id(s) not on the current page: ' +
            offPage.join(', '),
        )
      }
      return { selectedCount: nodes.length, warnings }
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

      // get_components' `properties` projection (READ) — shares
      // projectComponentDefs with update_component (WRITE) so the shape is
      // identical by construction, not convention (read == write, T2).
      const defaultsOf = (
        defs: ComponentPropertyDefinitions,
      ): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(defs).map(([k, d]) => [
            k,
            d.defaultValue,
          ]),
        )

      // T7 resilience: a ComponentSet with conflicting/incomplete variants makes
      // Figma THROW ("Component set for node has existing errors") when reading
      // variantProperties / componentPropertyDefinitions. Guard EACH set (and
      // each standalone component) individually so one malformed node degrades to
      // a warnings[] entry — naming the node + reason — and every other component
      // still returns, instead of sinking the whole read into {error}.
      const componentWarnings: string[] = []

      const setMap: Record<string, unknown> = {}
      for (const cs of componentSets) {
        // Base identity is read with cheap props that don't throw; the variant
        // projection (which can throw) is layered on inside the try.
        const base = {
          id: cs.id,
          name: cs.name,
          key: cs.key,
          type: cs.type,
          page:
            cs.parent && cs.parent.type === 'PAGE'
              ? cs.parent.name
              : null,
        }
        try {
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
          const csDefs =
            cs.componentPropertyDefinitions || {}
          setMap[cs.id] = {
            ...base,
            properties: projectComponentDefs(csDefs),
            variantAxes:
              Object.keys(variantAxes).length > 0
                ? variantAxes
                : undefined,
            defaults: defaultsOf(csDefs),
          }
        } catch (e) {
          // Degrade: include the set WITHOUT its variant info and warn.
          setMap[cs.id] = base
          componentWarnings.push(
            'component set "' +
              cs.name +
              '" (' +
              cs.id +
              ') skipped variant projection: ' +
              String(e),
          )
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
        try {
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
            properties: projectComponentDefs(compDefs),
            defaults: defaultsOf(compDefs),
          })
        } catch (e) {
          // Degrade: include the component WITHOUT its property info and warn.
          standaloneComponents.push({
            id: comp.id,
            name: comp.name,
            key: comp.key,
            type: comp.type,
            page:
              comp.parent && comp.parent.type === 'PAGE'
                ? comp.parent.name
                : null,
          })
          componentWarnings.push(
            'component "' +
              comp.name +
              '" (' +
              comp.id +
              ') skipped property projection: ' +
              String(e),
          )
        }
      }

      // Remote/library discovery (T10 — the live timeout fix). This walks EVERY
      // instance in the document (findAllWithCriteria(['INSTANCE'])) and resolves
      // each one's mainComponent to index library mains — O(all instances). On a
      // real UI-kit document that exceeds the 30s command timeout, while the
      // LOCAL scan above is cheap. So it is OPT-IN: skipped entirely unless the
      // caller asks for it via includeRemote. Default (false) → remote is empty.
      const includeRemote = params.includeRemote === true
      const remoteMap: Record<
        string,
        {
          key: string
          name: string
          library: string
          instancesCount: number
        }
      > = {}
      if (includeRemote) {
        const instances = figma.root.findAllWithCriteria({
          types: ['INSTANCE'],
        })
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
      }

      const localAll = Object.values(setMap).concat(
        standaloneComponents,
      )
      const remoteAll = Object.values(remoteMap)

      // warnings[] rides on the success reply only when a node degraded (T7);
      // a clean read carries no `warnings` key — same shape the server expects.
      return componentWarnings.length > 0
        ? {
            local: localAll,
            remote: remoteAll,
            warnings: componentWarnings,
          }
        : { local: localAll, remote: remoteAll }
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
        // A typo'd / deleted / non-container nodeId is a genuine not-found,
        // not a zero-match — surface {error} so it is distinguishable (T7).
        if (!target || !('findAll' in target)) {
          return {
            error: 'Node not found: ' + params.nodeId,
          }
        }
        roots.push(target as BaseNode & ChildrenMixin)
      } else if (scope === 'page') {
        const pageNode = await figma.getNodeByIdAsync(
          params.pageId as string,
        )
        if (!pageNode || pageNode.type !== 'PAGE') {
          return {
            error: 'Page not found: ' + params.pageId,
          }
        }
        roots.push(pageNode as PageNode)
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

      // B2 — depth bounds the SCAN SCOPE (descent depth), NOT the output shape:
      // candidates are still returned as a flat list. -1 (or omitted) scans the
      // whole subtree; 0 scans only the root; N descends N levels. This replaces
      // the former unbounded findAll(() => true) so the agent can cap traversal.
      const rawDepth = params.depth as number | undefined
      const scanDepth =
        rawDepth === undefined ? -1 : rawDepth

      // B3 + B4 — conditional per-candidate metadata collection. These flags are
      // set by the SERVER only when the request actually needs them (a
      // reverse-lookup match key or the `characters` projection), because each
      // is an async/extra-cost per-node call. An unhinted scan pays nothing.
      const collectComponentRef =
        params.collectComponentRef === true
      const collectStyleId = params.collectStyleId === true
      const collectVariableId =
        params.collectVariableId === true
      const collectCharacters =
        params.collectCharacters === true
      const needsEnrich =
        collectComponentRef ||
        collectStyleId ||
        collectVariableId ||
        collectCharacters

      const seen = new Set<string>()
      const scanned: SceneNode[] = []

      // Depth-bounded DFS collector. `levelsLeft < 0` is treated as unlimited
      // (the -1 / scan-all default); each descent decrements it.
      const collect = (
        node: SceneNode,
        levelsLeft: number,
      ): void => {
        if (!seen.has(node.id)) {
          seen.add(node.id)
          scanned.push(node)
        }
        if (levelsLeft === 0) {
          return
        }
        if ('children' in node) {
          for (const child of (node as ChildrenMixin)
            .children) {
            collect(child, levelsLeft - 1)
          }
        }
      }

      if (scope === 'selection') {
        // The selected nodes are level 0; their subtrees descend from there.
        for (const sel of figma.currentPage.selection) {
          collect(sel, scanDepth)
        }
      } else {
        // For container roots (page / node subtree) the root itself is level 0,
        // so its direct children are level 1. A page root is not a candidate
        // (we want its descendants); start the descent from each child at the
        // requested depth so depth=0 yields the page's immediate children.
        for (const root of roots) {
          if ('children' in root) {
            for (const child of (root as ChildrenMixin)
              .children) {
              collect(child, scanDepth)
            }
          }
        }
      }

      // Enrich the flat candidate list. The base candidate (id/name/type/size)
      // is cheap and always present; the reverse-lookup metadata + characters
      // are attached only when hinted (B3/B4) so the server's buildMatcher can
      // filter and projectNode can map `characters`.
      const candidates: Record<string, unknown>[] = []
      for (const fn of scanned) {
        const candidate = toCandidate(fn)

        if (needsEnrich) {
          // B4 — characters: TEXT nodes expose their text content as a flat
          // string for copy-inventory scans (non-text nodes leave it undefined).
          if (collectCharacters && fn.type === 'TEXT') {
            candidate.characters = (
              fn as TextNode
            ).characters
          }

          // B3 — instancesOf / componentKey: resolve the INSTANCE's main
          // component (async). `instancesOf` matches by the main component's
          // NAME; `componentKey` matches by its KEY. Failures degrade silently
          // (the candidate simply won't match those keys).
          if (
            collectComponentRef &&
            fn.type === 'INSTANCE'
          ) {
            const main = await (fn as InstanceNode)
              .getMainComponentAsync()
              .catch(() => null)
            if (main) {
              candidate.componentKey = main.key
              candidate.instancesOf = main.name
            }
          }

          // B3 — styleId: any of the node's style references. The server's
          // matcher tests a single `styleId`, so expose the bound style ids and
          // let buildMatcher match if ANY equals the requested id (see match.ts).
          if (collectStyleId) {
            const styleIds: string[] = []
            const g = fn as Partial<{
              fillStyleId: string | symbol
              strokeStyleId: string | symbol
              effectStyleId: string | symbol
              gridStyleId: string | symbol
              textStyleId: string | symbol
            }>
            for (const key of [
              'fillStyleId',
              'strokeStyleId',
              'effectStyleId',
              'gridStyleId',
              'textStyleId',
            ] as const) {
              const v = g[key]
              // figma.mixed is a symbol; only collect concrete string ids.
              if (typeof v === 'string' && v.length > 0) {
                styleIds.push(v)
              }
            }
            if (styleIds.length > 0) {
              candidate.styleIds = styleIds
            }
          }

          // B3 — variableId: the ids bound on the node via boundVariables.
          // boundVariables maps a field → VariableAlias{id} (or an array of
          // them for paints/strokes). Flatten every bound id so the matcher can
          // match if ANY equals the requested variableId.
          if (collectVariableId && 'boundVariables' in fn) {
            const bound = (
              fn as SceneNode & {
                boundVariables?: Record<string, unknown>
              }
            ).boundVariables
            if (bound) {
              const ids: string[] = []
              const pushAlias = (a: unknown): void => {
                const id = (a as { id?: string } | null)?.id
                if (typeof id === 'string') {
                  ids.push(id)
                }
              }
              for (const val of Object.values(bound)) {
                if (Array.isArray(val)) {
                  for (const a of val) {
                    pushAlias(a)
                  }
                } else {
                  pushAlias(val)
                }
              }
              if (ids.length > 0) {
                candidate.variableIds = ids
              }
            }
          }
        }

        candidates.push(candidate)
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
      const created = await createSingleNode(
        spec,
        parent,
        warnings,
      )
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

    // create_component (PROMOTE-ONLY, un-overloaded per spec): componentize an
    // existing node via createComponentFromNode(), optionally rename / set
    // description. The build-from-spec overload (+ its orphan cleanup) was
    // removed — build with create_node / create_tree first, then promote.
    case COMMANDS.CREATE_COMPONENT: {
      const ccName = params.name as string | undefined
      const ccDescription = params.description as
        | string
        | undefined
      const found = await figma.getNodeByIdAsync(
        params.nodeId as string,
      )
      if (!found) {
        return {
          error: 'Node not found: ' + params.nodeId,
        }
      }
      const sourceNode = found as SceneNode
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
      // (e.g. "Label#1:0") that agents need for later setProperties. It is
      // surfaced inside the returned `properties` array (the entry's `id`).
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
            comp.addComponentProperty(
              p.name,
              p.type as ComponentPropertyType,
              p.defaultValue,
            )
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
      // update_component's `properties` projection (WRITE) — shares
      // projectComponentDefs with get_components (READ) so each added property's
      // id is carried in the SAME shape and round-trips get_components by
      // construction (read == write, T2).
      const ucDefs = comp.componentPropertyDefinitions || {}
      const ucProperties = projectComponentDefs(ucDefs)
      return {
        id: comp.id,
        properties: ucProperties,
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
        // Fall back to the first component's parent — but only if it can host
        // children. A parentless first component (parent === null) would make
        // combineAsVariants throw an opaque exception, so return a clean
        // {error} instead of casting null to a non-null parent.
        const fallbackParent = cvComps[0].parent
        if (
          !fallbackParent ||
          !('appendChild' in fallbackParent)
        ) {
          return {
            error: 'No valid parent for the variant set',
          }
        }
        if (params.parentId !== undefined) {
          cvWarnings.push(
            'Requested parent "' +
              String(params.parentId) +
              '" cannot contain the variant set; used the first component\'s parent instead.',
          )
        }
        cvParent = fallbackParent as BaseNode &
          ChildrenMixin
      }
      // Multi-axis variant-name warning (T7/T9): Figma derives variant axes from
      // each component NAME via the `Property=Value, Property2=Value2`
      // convention. A name WITHOUT `=` packs its whole value into one anonymous
      // axis (the `Style=PrimaryLarge` class problem), so the set won't form a
      // CLEAN one-property-per-axis grouping. Detect this from the source names
      // before combining and nudge toward one property per axis. (A name with a
      // single comma-free `Prop=Value` pair is the clean single-axis case.)
      const cvUnaxised = cvComps
        .filter(c => !c.name.includes('='))
        .map(c => c.name)
      if (cvUnaxised.length > 0) {
        cvWarnings.push(
          'combine_variants: ' +
            cvUnaxised.length +
            ' component name(s) do not use the "Property=Value" axis convention (' +
            cvUnaxised.join(', ') +
            '); the variant set will not form a clean axis set. Name each variant one property per axis (e.g. "Style=Primary, Size=Large").',
        )
      }
      const cs = figma.combineAsVariants(cvComps, cvParent)
      if (params.name !== undefined)
        cs.name = params.name as string
      return {
        id: cs.id,
        key: cs.key,
        name: cs.name,
        type: cs.type,
        variantAxes: cs.variantGroupProperties,
        warnings: cvWarnings,
      }
    }

    // swap_component: point an instance at a different main component. Remote-
    // capable: a LOCAL mainComponentId resolves directly (and WINS if both are
    // given); otherwise a `key` is resolved via importComponentByKeyAsync, which
    // is feature-detected + T7-degraded (a failed import warns, never throws).
    // The actual swap also degrades into a warning (T7) — never throw.
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
      const scWarnings: string[] = []
      const inst = scInst as InstanceNode
      const scMainId = params.mainComponentId as
        | string
        | undefined
      const scKey = params.key as string | undefined
      let scMain: ComponentNode | null = null
      if (scMainId !== undefined) {
        // LOCAL path (wins if both given).
        const found = await figma.getNodeByIdAsync(scMainId)
        if (!found || found.type !== 'COMPONENT') {
          return {
            error: 'Main component not found: ' + scMainId,
          }
        }
        scMain = found as ComponentNode
      } else if (scKey !== undefined) {
        // REMOTE path: import the component by key (T7 feature-detect/degrade).
        const importer = (
          figma as typeof figma & {
            importComponentByKeyAsync?: (
              key: string,
            ) => Promise<ComponentNode>
          }
        ).importComponentByKeyAsync
        if (typeof importer !== 'function') {
          return {
            id: inst.id,
            mainComponent: null,
            warnings: [
              'importComponentByKeyAsync unavailable in this Figma version; remote swap skipped',
            ],
          }
        }
        try {
          scMain = await importer(scKey)
        } catch (e) {
          return {
            id: inst.id,
            mainComponent: null,
            warnings: [
              'importComponentByKeyAsync failed for key "' +
                scKey +
                '": ' +
                String(e) +
                '; remote swap skipped',
            ],
          }
        }
      } else {
        return {
          error:
            'swap_component requires mainComponentId (local) or key (remote)',
        }
      }
      try {
        inst.swapComponent(scMain)
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
    // application is limited via the plugin API → warn rather than fail. The
    // RAW Figma inst2.componentProperties ({ [name]:{type,value} }) is echoed
    // back; the SERVER splits it into the read-twin { variantProperties?,
    // componentProperties? } shape (C3 / T2).
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
      const siOverridesRaw = params.overrides as
        | unknown[]
        | undefined
      // T7: set_instance is a WRITE path. A call with neither properties nor
      // overrides mutates nothing — warn rather than returning a silent no-op
      // success (consistent with the warn-on-no-op convention in update_node).
      if (
        (!siProps || Object.keys(siProps).length === 0) &&
        (!siOverridesRaw || siOverridesRaw.length === 0)
      ) {
        siWarnings.push(
          'no properties or overrides supplied; nothing changed',
        )
      }
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

      // warn-on-no-op (T7): a patched property that the target node type does
      // not support is dropped by applyCommonProperties' `'X' in node` guards.
      // On update_node the target is arbitrary, so name the dropped field rather
      // than skipping silently. (capability key → spec key)
      const capabilityChecks: [string, string][] = [
        ['layoutMode', 'layout'],
        ['fills', 'fills'],
        ['strokes', 'strokes'],
        ['effects', 'effects'],
        ['opacity', 'opacity'],
        ['cornerRadius', 'radius'],
        ['clipsContent', 'clipsContent'],
      ]
      for (const [cap, key] of capabilityChecks) {
        if (spec[key] !== undefined && !(cap in node)) {
          warnings.push(
            key +
              ' ignored — not supported on a ' +
              node.type +
              ' node',
          )
        }
      }

      await applyCommonProperties(
        node as SceneNode,
        spec,
        parent as ParentNode,
        warnings,
      )
      if (node.type === 'TEXT' && spec.text !== undefined) {
        await applyTextProperties(node as TextNode, spec)
      }
      applyPostAppendProperties(
        node as SceneNode,
        spec,
        warnings,
      )

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

      // Paint fields (fills/strokes) are NOT members of VariableBindableNodeField,
      // so node.setBoundVariable('fills', v) would throw. They bind per-paint via
      // figma.variables.setBoundVariableForPaint(paint,'color',variable), then the
      // paint array is re-assigned. Feature-detect it (T7): warn+skip if absent.
      if (field === 'fills' || field === 'strokes') {
        const paintHost = node as SceneNode & {
          fills?: readonly Paint[] | typeof figma.mixed
          strokes?: readonly Paint[]
        }
        if (!(field in node)) {
          warnings.push(
            'field "' +
              field +
              '" is not bindable on ' +
              node.type,
          )
          return { id: node.id, warnings }
        }
        const setForPaint = (
          figma.variables as {
            setBoundVariableForPaint?: (
              paint: Paint,
              f: 'color',
              v: Variable,
            ) => Paint
          }
        ).setBoundVariableForPaint
        if (typeof setForPaint !== 'function') {
          warnings.push(
            'setBoundVariableForPaint unavailable in this Figma version; paint binding skipped',
          )
          return { id: node.id, warnings }
        }
        const current =
          field === 'fills'
            ? paintHost.fills
            : paintHost.strokes
        if (
          current === figma.mixed ||
          !Array.isArray(current)
        ) {
          warnings.push(
            field +
              ' has no bindable paints on ' +
              node.type +
              '; paint binding skipped',
          )
          return { id: node.id, warnings }
        }
        try {
          const bound = (current as Paint[]).map(paint =>
            paint.type === 'SOLID'
              ? setForPaint(paint, 'color', variable)
              : paint,
          )
          if (field === 'fills') {
            ;(node as GeometryMixin & SceneNode).fills =
              bound
          } else {
            ;(node as GeometryMixin & SceneNode).strokes =
              bound
          }
        } catch (e) {
          warnings.push(
            'binding ' +
              field +
              ' on ' +
              node.type +
              ' failed: ' +
              String(e),
          )
        }
        return { id: node.id, warnings }
      }

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
        const explicit = params.nodeId !== undefined
        if (explicit) {
          const node = await figma.getNodeByIdAsync(
            params.nodeId as string,
          )
          // An explicit, unresolvable nodeId is a genuine not-found — surface
          // it as a warning (T7) so the agent can tell it apart from "node has
          // zero annotations", never a silent empty success.
          if (!node) {
            return {
              results: [],
              truncated: false,
              warnings: [
                'Node not found: ' + params.nodeId,
              ],
            }
          }
          targets.push(node)
        } else {
          for (const sel of figma.currentPage.selection) {
            targets.push(sel)
          }
        }
        // Multi-selection reads tag each annotation with its source nodeId so
        // the flat result remains attributable and can be regrouped/fed back to
        // the single-node set_annotations writer (T2). The single-node path
        // (explicit nodeId / a 1-node selection) stays bare for a clean
        // round-trip.
        const tag = !explicit && targets.length > 1
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
              collected.push(
                tag
                  ? { ...(a as object), nodeId: node.id }
                  : a,
              )
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
      const missing: string[] = []
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id)
        if (n && 'visible' in n) {
          nodes.push(n as SceneNode)
        } else {
          missing.push(id)
        }
      }
      figma.viewport.scrollAndZoomIntoView(nodes)
      // T7: ids that don't resolve to a scene node are surfaced in warnings[]
      // (never a silent no-op / hallucinated success). requested/focused let the
      // agent compare against the input even when nothing resolved.
      return {
        viewport: {
          center: figma.viewport.center,
          zoom: figma.viewport.zoom,
        },
        requested: ids.length,
        focused: nodes.length,
        warnings:
          missing.length > 0
            ? [
                'set_focus: ' +
                  missing.join(', ') +
                  ' did not resolve to a scene node and were skipped',
              ]
            : [],
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
      // Validate index up front so an out-of-range value returns a clean,
      // actionable {error} instead of degrading to a raw RangeError string from
      // insertChild. The first clone inserts at `index`; each later clone grows
      // the list by 1, so `index+i` stays in range once `index` itself is valid.
      if (index !== undefined) {
        const childCount = (
          dest as ParentNode & {
            children: readonly SceneNode[]
          }
        ).children.length
        if (index < 0 || index > childCount) {
          return {
            error:
              'clone_node index ' +
              index +
              ' is out of range for the parent (0..' +
              childCount +
              ')',
          }
        }
      }
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
        // Strip the optional `nodeId` attribution tag that a multi-selection
        // get_annotations read adds, so a tagged annotation round-trips cleanly
        // through this single-node writer without leaking an extraneous key.
        const incoming =
          params.annotations as unknown as (Annotation & {
            nodeId?: string
          })[]
        const cleaned = incoming.map(a => {
          if (a && typeof a === 'object' && 'nodeId' in a) {
            const { nodeId: _drop, ...rest } = a
            return rest as Annotation
          }
          return a as Annotation
        })
        ;(
          node as SceneNode & {
            annotations?: unknown[]
          }
        ).annotations = cleaned
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
          // T7: a duplicate/invalid rename degrades to a warning rather than
          // throwing the whole call into {error}.
          try {
            collection.renameMode(
              collection.modes[0].modeId,
              requestedModes[0],
            )
          } catch (e) {
            warnings.push(
              'renameMode failed for default mode → "' +
                requestedModes[0] +
                '": ' +
                String(e),
            )
          }
        } else {
          // T7: feature-detected absent is NOT a silent no-op — warn so the
          // agent knows the default mode kept its original name (and any value
          // keyed to the requested mode will then fall through as 'unknown mode').
          warnings.push(
            'renameMode unavailable in this Figma version; default mode not renamed to "' +
              requestedModes[0] +
              '"',
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
              aliases?: Record<string, string>
              scopes?: string[]
              codeSyntax?: Record<string, string>
              hiddenFromPublishing?: boolean
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
        // E1: apply aliases / scopes / codeSyntax / hiddenFromPublishing through
        // the SHARED per-variable path (parity with update_variables, T7).
        await applyVariableMeta(
          variable,
          {
            name: spec.name,
            aliases: spec.aliases,
            scopes: spec.scopes,
            codeSyntax: spec.codeSyntax,
            hiddenFromPublishing: spec.hiddenFromPublishing,
          },
          modeByName,
          warnings,
        )
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
          // T7: a duplicate/invalid rename throws — degrade to a warning rather
          // than letting the throw turn the whole call into {error} (discarding
          // addModes/values already applied).
          try {
            collection.renameMode(modeId, rename.to)
          } catch (e) {
            warnings.push(
              'renameMode failed for "' +
                rename.from +
                '" → "' +
                rename.to +
                '": ' +
                String(e),
            )
          }
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
    // create_styles: array-create with PARTIAL SUCCESS. The server has already
    // CONVERTED each entry's value atom (paint→Paint, text→FontName, effect→
    // Effect, grid→LayoutGrid). Loop, creating one style per entry (loadFontAsync
    // first for text); a single failure degrades to that entry's {index,error}
    // and does NOT abort the rest. Returns { results:[{id,key,name,type,index}],
    // errors:[{index,error}] }.
    case COMMANDS.CREATE_STYLES: {
      const csEntries =
        (params.styles as
          | {
              index: number
              type: 'paint' | 'text' | 'effect' | 'grid'
              name: string
              value: unknown
              description?: string
            }[]
          | undefined) ?? []
      const csResults: {
        id: string
        key: string
        name: string
        type: 'paint' | 'text' | 'effect' | 'grid'
        index: number
      }[] = []
      const csErrors: { index: number; error: string }[] =
        []

      for (const entry of csEntries) {
        try {
          let style:
            | PaintStyle
            | TextStyle
            | EffectStyle
            | GridStyle
          if (entry.type === 'paint') {
            if (
              typeof figma.createPaintStyle !== 'function'
            ) {
              throw new Error(
                'createPaintStyle unavailable',
              )
            }
            const ps = figma.createPaintStyle()
            ps.paints = [entry.value as Paint]
            style = ps
          } else if (entry.type === 'text') {
            if (
              typeof figma.createTextStyle !== 'function'
            ) {
              throw new Error('createTextStyle unavailable')
            }
            const font = entry.value as {
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
            const ts = figma.createTextStyle()
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
            style = ts
          } else if (entry.type === 'effect') {
            if (
              typeof figma.createEffectStyle !== 'function'
            ) {
              throw new Error(
                'createEffectStyle unavailable',
              )
            }
            const es = figma.createEffectStyle()
            es.effects = [entry.value as Effect]
            style = es
          } else {
            if (
              typeof figma.createGridStyle !== 'function'
            ) {
              throw new Error('createGridStyle unavailable')
            }
            const gs = figma.createGridStyle()
            gs.layoutGrids = [entry.value as LayoutGrid]
            style = gs
          }
          style.name = entry.name
          if (entry.description !== undefined) {
            style.description = entry.description
          }
          csResults.push({
            id: style.id,
            key: style.key,
            name: style.name,
            type: entry.type,
            index: entry.index,
          })
        } catch (e) {
          csErrors.push({
            index: entry.index,
            error: String(e),
          })
        }
      }
      return { results: csResults, errors: csErrors }
    }

    // update_styles: array-edit existing styles' value/newName/description with
    // PARTIAL SUCCESS. Each entry is looked up by `id` OR by `name`+`type` (the
    // async local-style listers). The server sends the CONVERTED value + the
    // inferred valueType; the plugin validates valueType against the style's
    // actual type and assigns. One entry's failure becomes THAT entry's
    // {index,error} and does NOT abort the rest. Partial-write contract per
    // entry: a TEXT entry whose newName/description committed but whose font
    // load failed becomes that entry's error, naming that name/description WERE
    // applied (an honest partial write, never a silent no-op).
    case COMMANDS.UPDATE_STYLES: {
      const usEntries =
        (params.styles as
          | {
              index: number
              id?: string
              name?: string
              type?: 'paint' | 'text' | 'effect' | 'grid'
              value?: unknown
              valueType?:
                | 'paint'
                | 'text'
                | 'effect'
                | 'grid'
              newName?: string
              description?: string
            }[]
          | undefined) ?? []
      const usResults: { id: string; index: number }[] = []
      const usErrors: { index: number; error: string }[] =
        []

      // Resolve a style by id, else by name + category. The name+type listers
      // are loaded lazily (only when an entry omits its id).
      const resolveStyle = async (entry: {
        id?: string
        name?: string
        type?: 'paint' | 'text' | 'effect' | 'grid'
      }): Promise<BaseStyle | null> => {
        if (entry.id !== undefined) {
          return figma.getStyleByIdAsync(entry.id)
        }
        if (
          entry.name === undefined ||
          entry.type === undefined
        ) {
          return null
        }
        const listers = {
          paint: figma.getLocalPaintStylesAsync,
          text: figma.getLocalTextStylesAsync,
          effect: figma.getLocalEffectStylesAsync,
          grid: figma.getLocalGridStylesAsync,
        }
        const list = await listers[entry.type]()
        return (
          (list as BaseStyle[]).find(
            s => s.name === entry.name,
          ) ?? null
        )
      }

      for (const entry of usEntries) {
        try {
          const style = await resolveStyle(entry)
          if (!style) {
            usErrors.push({
              index: entry.index,
              error:
                'Style not found: ' +
                (entry.id ??
                  `${entry.name} (${entry.type})`),
            })
            continue
          }
          // name/description commit first (partial-write contract).
          if (entry.newName !== undefined) {
            style.name = entry.newName
          }
          if (entry.description !== undefined) {
            style.description = entry.description
          }
          if (entry.value !== undefined) {
            const actual = {
              PAINT: 'paint',
              TEXT: 'text',
              EFFECT: 'effect',
              GRID: 'grid',
            }[style.type]
            if (
              entry.valueType !== undefined &&
              entry.valueType !== actual
            ) {
              usErrors.push({
                index: entry.index,
                error:
                  'value looks like a ' +
                  entry.valueType +
                  ' atom but the style is ' +
                  actual +
                  '; value not applied (newName/description were updated)',
              })
              continue
            }
            if (style.type === 'PAINT') {
              ;(style as PaintStyle).paints = [
                entry.value as Paint,
              ]
            } else if (style.type === 'TEXT') {
              const font = entry.value as {
                family: string
                style: string
                size: number
                lineHeight?: LineHeight
                letterSpacing?: LetterSpacing
              }
              // loadFontAsync throws for an unavailable font. newName/description
              // were ALREADY committed above, so this entry becomes a per-entry
              // error that NAMES the applied name/description — an honest partial
              // write, not a silent no-op, and it does not abort other entries.
              try {
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
              } catch (e) {
                usErrors.push({
                  index: entry.index,
                  error:
                    'font "' +
                    font.family +
                    ' ' +
                    font.style +
                    '" unavailable; value not applied (newName/description were updated): ' +
                    String(e),
                })
                continue
              }
            } else if (style.type === 'EFFECT') {
              ;(style as EffectStyle).effects = [
                entry.value as Effect,
              ]
            } else if (style.type === 'GRID') {
              ;(style as GridStyle).layoutGrids = [
                entry.value as LayoutGrid,
              ]
            }
          }
          usResults.push({
            id: style.id,
            index: entry.index,
          })
        } catch (e) {
          usErrors.push({
            index: entry.index,
            error: String(e),
          })
        }
      }
      return { results: usResults, errors: usErrors }
    }

    // apply_style: bind a style to a node field via the matching async setter.
    // T7 boundary:
    //  - a missing node or a non-existent / wrong-CATEGORY styleId is a GENUINE
    //    invalid → {error} (validated up front, never swallowed).
    //  - a setter that is feature-unavailable on the node type degrades to a
    //    warning on success (NEVER {error}); the remaining catch covers a true
    //    feature-unavailability rejection.
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
      // A genuinely invalid styleId is NOT a degrade — surface {error} up front
      // (mirrors the node-not-found guard above).
      const style = await figma.getStyleByIdAsync(styleId)
      if (!style) {
        return { error: 'Style not found: ' + styleId }
      }
      // Wrong-category binding (e.g. a PAINT style via field:'text') is a
      // genuine invalid → {error}, not a warning.
      const expectedType = {
        fill: 'PAINT',
        stroke: 'PAINT',
        text: 'TEXT',
        effect: 'EFFECT',
        grid: 'GRID',
      }[field]
      if (style.type !== expectedType) {
        return {
          error:
            'Style category mismatch: field "' +
            field +
            '" expects a ' +
            expectedType +
            ' style but ' +
            styleId +
            ' is a ' +
            style.type +
            ' style',
        }
      }
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
