import YAML from 'yaml'
import type {
  ParsedNode,
  InspectSummary,
  PageFrameInfo,
  SearchResult,
} from '@figma-agent-bridge/shared'

// --- Type aliases ---

type RGBA = { r: number; g: number; b: number; a: number }

type FigmaFill = {
  type: string
  visible?: boolean
  color?: RGBA
}

type FigmaEffect = {
  type: string
  visible?: boolean
  color?: RGBA
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
}

// --- Helpers ---

const rgbaToHex = (color: RGBA): string => {
  const toHex = (v: number): string => {
    const hex = Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')

    return hex
  }

  const rgb = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
  if (
    color.a !== null &&
    color.a !== undefined &&
    color.a < 1
  ) {
    return `${rgb}${toHex(color.a)}`.toUpperCase()
  }

  return rgb.toUpperCase()
}

const parseFills = (
  fills: FigmaFill[],
): string[] | undefined => {
  const result = fills
    .filter(
      f =>
        f.visible !== false &&
        f.type === 'SOLID' &&
        f.color !== null &&
        f.color !== undefined,
    )
    .map(f => rgbaToHex(f.color as RGBA))

  return result.length > 0 ? result : undefined
}

const parseEffects = (
  effects: FigmaEffect[],
): string[] | undefined => {
  const result = effects
    .filter(e => e.visible !== false)
    .map(e => {
      if (
        e.type === 'DROP_SHADOW' ||
        e.type === 'INNER_SHADOW'
      ) {
        const colorHex =
          e.color !== null && e.color !== undefined
            ? rgbaToHex(e.color)
            : '?'
        const ox =
          e.offset !== null && e.offset !== undefined
            ? e.offset.x
            : 0
        const oy =
          e.offset !== null && e.offset !== undefined
            ? e.offset.y
            : 0

        return `shadow(${ox},${oy},${e.radius ?? 0},${colorHex})`
      }
      if (
        e.type === 'LAYER_BLUR' ||
        e.type === 'BACKGROUND_BLUR'
      ) {
        return `blur(${e.radius ?? 0})`
      }

      return e.type.toLowerCase()
    })

  return result.length > 0 ? result : undefined
}

const parseTextStyle = (
  style: {
    fontFamily?: string
    fontStyle?: string
    fontSize?: number
    textAlignHorizontal?: string
  },
  fills: FigmaFill[],
): { font: string; align?: string; color?: string } => {
  const family = style.fontFamily ?? 'Unknown'
  const weight = (style.fontStyle ?? 'Regular').replace(
    /\s+/g,
    '',
  )
  const size = style.fontSize ?? 0
  const font = `${family}/${weight}/${size}`
  const align = style.textAlignHorizontal
  const colorFills = fills.filter(
    f =>
      f.visible !== false &&
      f.type === 'SOLID' &&
      f.color !== null &&
      f.color !== undefined,
  )
  const color =
    colorFills.length > 0
      ? rgbaToHex(colorFills[0].color as RGBA)
      : undefined

  return {
    font,
    ...(align !== undefined ? { align } : {}),
    ...(color !== undefined ? { color } : {}),
  }
}

const computeCanvasBounds = (
  items: { x: number; y: number; w: number; h: number }[],
): [number, number] => {
  if (items.length === 0) {
    return [0, 0]
  }

  return [
    Math.max(...items.map(f => f.x + f.w)),
    Math.max(...items.map(f => f.y + f.h)),
  ]
}

const parseLayout = (
  node: Record<string, unknown>,
): ParsedNode['layout'] | undefined => {
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
    ...((node.layoutWrap as string) === 'WRAP'
      ? { wrap: true }
      : {}),
  }
}

const parseComponentInfo = (
  node: Record<string, unknown>,
): ParsedNode['component'] | undefined => {
  if (node.type !== 'INSTANCE') {
    return undefined
  }

  const props = node.componentProperties as
    | Record<string, { type: string; value: string }>
    | undefined
  const variant =
    props !== null && props !== undefined
      ? Object.fromEntries(
          Object.entries(props)
            .filter(([, v]) => v.type === 'VARIANT')
            .map(([k, v]) => [k, v.value]),
        )
      : undefined

  return {
    name: (node.name as string) ?? '',
    id: (node.componentId as string) ?? '',
    ...(variant !== undefined &&
    Object.keys(variant).length > 0
      ? { variant }
      : {}),
  }
}

// --- Main exports ---

export const parseNode = (
  raw: Record<string, unknown>,
): ParsedNode => {
  const bbox = raw.absoluteBoundingBox as
    | {
        x: number
        y: number
        width: number
        height: number
      }
    | undefined
  const size: [number, number] =
    bbox !== null && bbox !== undefined
      ? [bbox.width, bbox.height]
      : [0, 0]
  const fills =
    raw.fills !== null && raw.fills !== undefined
      ? parseFills(raw.fills as FigmaFill[])
      : undefined
  const strokes =
    raw.strokes !== null && raw.strokes !== undefined
      ? parseFills(raw.strokes as FigmaFill[])
      : undefined
  const effects =
    raw.effects !== null && raw.effects !== undefined
      ? parseEffects(raw.effects as FigmaEffect[])
      : undefined
  const layout = parseLayout(raw)
  const component = parseComponentInfo(raw)

  const sizingH = raw.layoutSizingHorizontal as
    | string
    | undefined
  const sizingV = raw.layoutSizingVertical as
    | string
    | undefined
  const sizing: [string, string] | undefined =
    sizingH !== null &&
    sizingH !== undefined &&
    sizingV !== null &&
    sizingV !== undefined
      ? [sizingH, sizingV]
      : undefined

  const radius = raw.cornerRadius as number | undefined
  const opacity = raw.opacity as number | undefined

  const children =
    raw.children !== null && raw.children !== undefined
      ? (raw.children as Record<string, unknown>[]).map(c =>
          parseNode(c),
        )
      : undefined

  const textContent = raw.characters as string | undefined
  const textStyle = raw.style as
    | {
        fontFamily?: string
        fontStyle?: string
        fontSize?: number
        textAlignHorizontal?: string
      }
    | undefined
  const text =
    textContent !== null &&
    textContent !== undefined &&
    textStyle !== null &&
    textStyle !== undefined
      ? {
          content: textContent,
          ...parseTextStyle(
            textStyle,
            (raw.fills ?? []) as FigmaFill[],
          ),
        }
      : undefined

  const result: ParsedNode = {
    id: raw.id as string,
    name: raw.name as string,
    type: raw.type as string,
    size,
  }

  if (layout !== undefined) {
    result.layout = layout
  }
  if (sizing !== undefined) {
    result.sizing = sizing
  }
  if (fills !== undefined) {
    result.fills = fills
  }
  if (strokes !== undefined && strokes.length > 0) {
    result.strokes = strokes
  }
  if (radius !== undefined && radius !== 0) {
    result.radius = radius
  }
  if (opacity !== undefined && opacity < 1) {
    result.opacity = opacity
  }
  if (effects !== undefined) {
    result.effects = effects
  }
  if (text !== undefined) {
    result.text = text
  }
  if (component !== undefined) {
    result.component = component
  }
  if (children !== undefined && children.length > 0) {
    result.children = children
  }

  return result
}

export const computeSummary = (
  parsed: ParsedNode,
): InspectSummary => {
  const typeBreakdown: Record<string, number> = {}
  const componentNames: string[] = []
  let totalLayers = 0
  let maxDepth = 0

  const walk = (node: ParsedNode, depth: number): void => {
    totalLayers++
    if (depth > maxDepth) {
      maxDepth = depth
    }
    typeBreakdown[node.type] =
      (typeBreakdown[node.type] ?? 0) + 1

    if (
      node.component !== null &&
      node.component !== undefined &&
      !componentNames.includes(node.component.name)
    ) {
      componentNames.push(node.component.name)
    }

    if (
      node.children !== null &&
      node.children !== undefined
    ) {
      node.children.forEach(child => {
        walk(child, depth + 1)
      })
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
    layoutMode:
      parsed.layout !== null && parsed.layout !== undefined
        ? parsed.layout.mode
        : null,
    size: parsed.size,
    rootFill:
      parsed.fills !== null &&
      parsed.fills !== undefined &&
      parsed.fills.length > 0
        ? parsed.fills[0]
        : null,
  }
}

const buildHeader = (summary: InspectSummary): string => {
  const sizeStr = `${summary.size[0]}×${summary.size[1]}`
  const typeCounts = Object.entries(summary.typeBreakdown)
    .map(([t, c]) => `${c} ${t}`)
    .join(', ')
  const alStr =
    summary.layoutMode !== null
      ? `auto-layout: ${summary.layoutMode}`
      : 'no auto-layout'

  return [
    `# ${summary.name} [${summary.id}]`,
    `# ${summary.totalLayers} layers, depth ${summary.maxDepth} | ${sizeStr} | ${alStr}`,
    `# types: ${typeCounts}`,
    ...(summary.componentNames.length > 0
      ? [
          `# components: ${summary.componentNames.join(', ')}`,
        ]
      : []),
    '',
  ].join('\n')
}

export const toInspectYaml = (
  parsed: ParsedNode,
): string => {
  const summary = computeSummary(parsed)
  const header = buildHeader(summary)
  const yamlStr = YAML.stringify(parsed, { lineWidth: 120 })

  return header + yamlStr
}

const renderNode = (
  node: ParsedNode,
  lines: string[],
  depth: number,
): void => {
  const indent = '  '.repeat(depth) + '- '
  const sizeStr = `${node.size[0]}×${node.size[1]}`

  let typeStr = node.type
  if (
    node.type === 'INSTANCE' &&
    node.component !== undefined
  ) {
    typeStr = `INSTANCE<${node.component.name}>`
  }

  let extras = ''
  if (node.layout !== undefined) {
    extras += ` ${node.layout.mode}`
  }
  if (node.text !== undefined) {
    let { content } = node.text
    if (content.length > 50) {
      content = content.slice(0, 50) + '...'
    }
    extras += ` "${content}"`
  }

  const hasChildren =
    node.children !== undefined && node.children.length > 0
  const suffix = hasChildren ? ':' : ''

  lines.push(
    `${indent}${node.name} [${node.id}] ${typeStr} ${sizeStr}${extras}${suffix}`,
  )

  if (hasChildren) {
    for (const child of node.children!) {
      renderNode(child, lines, depth + 1)
    }
  }
}

export const toInspectTree = (
  parsed: ParsedNode,
): string => {
  const summary = computeSummary(parsed)
  const header = buildHeader(summary)
  const lines: string[] = []
  renderNode(parsed, lines, 0)

  return header + lines.join('\n') + '\n'
}

// --- toInspectTreeMulti ---

export const toInspectTreeMulti = (
  nodes: ParsedNode[],
): string => {
  const typeBreakdown: Record<string, number> = {}
  const componentNames: string[] = []
  let totalLayers = 0

  const walk = (node: ParsedNode): void => {
    totalLayers++
    typeBreakdown[node.type] =
      (typeBreakdown[node.type] ?? 0) + 1
    if (
      node.component !== undefined &&
      !componentNames.includes(node.component.name)
    ) {
      componentNames.push(node.component.name)
    }
    if (node.children !== undefined) {
      node.children.forEach(walk)
    }
  }

  nodes.forEach(walk)

  const typeCounts = Object.entries(typeBreakdown)
    .map(([t, c]) => `${c} ${t}`)
    .join(', ')

  const headerLines = [
    `# ${nodes.length} selected`,
    `# ${totalLayers} layers total | types: ${typeCounts}`,
  ]
  if (componentNames.length > 0) {
    headerLines.push(
      `# components: ${componentNames.join(', ')}`,
    )
  }

  const lines: string[] = []
  for (const node of nodes) {
    renderNode(node, lines, 0)
  }

  return (
    headerLines.join('\n') +
    '\n\n' +
    lines.join('\n') +
    '\n'
  )
}

// --- toPageLayoutTree ---

export const toPageLayoutTree = (raw: {
  pageName: string
  frames: Record<string, unknown>[]
}): string => {
  const { pageName, frames } = raw

  const items: PageFrameInfo[] = frames.map(f => ({
    id: f.id as string,
    name: f.name as string,
    type: (f.type as string) ?? 'FRAME',
    size: [f.width as number, f.height as number] as [
      number,
      number,
    ],
    position: [f.x as number, f.y as number] as [
      number,
      number,
    ],
    childrenCount: (f.childCount as number) ?? 0,
  }))

  const [canvasW, canvasH] = computeCanvasBounds(
    items.map(f => ({
      x: f.position[0],
      y: f.position[1],
      w: f.size[0],
      h: f.size[1],
    })),
  )

  const typeBreakdown: Record<string, number> = {}
  for (const item of items) {
    typeBreakdown[item.type] =
      (typeBreakdown[item.type] ?? 0) + 1
  }
  const typeCounts = Object.entries(typeBreakdown)
    .map(([t, c]) => `${c} ${t}`)
    .join(', ')

  const header = [
    `# ${pageName}`,
    `# ${items.length} items | canvas: ${canvasW}×${canvasH}`,
    `# types: ${typeCounts}`,
    '',
  ].join('\n')

  const lines = items.map(
    f =>
      `- ${f.name} [${f.id}] ${f.type} ${f.size[0]}×${f.size[1]} @ ${f.position[0]},${f.position[1]}`,
  )

  return header + lines.join('\n') + '\n'
}

// --- toStylesTree ---

const renderPaintValue = (
  paints: Record<string, unknown>[],
): string => {
  if (paints.length === 0) {
    return 'none'
  }

  const paint = paints[0] as {
    type: string
    color?: RGBA
    gradientStops?: {
      position: number
      color: RGBA
    }[]
    gradientTransform?: number[][]
  }

  if (paint.type === 'SOLID' && paint.color !== undefined) {
    return rgbaToHex(paint.color)
  }

  if (paint.type === 'IMAGE') {
    return 'image'
  }

  if (paint.gradientStops !== undefined) {
    const stops = paint.gradientStops
      .map(
        s =>
          `${rgbaToHex(s.color)} ${Math.round(s.position * 100)}%`,
      )
      .join(', ')

    if (paint.type === 'GRADIENT_LINEAR') {
      const transform = paint.gradientTransform
      const angle =
        transform !== undefined
          ? Math.round(
              (Math.atan2(
                transform[0][1],
                transform[0][0],
              ) *
                180) /
                Math.PI,
            )
          : 0
      return `linear-gradient(${angle}deg, ${stops})`
    }
    if (paint.type === 'GRADIENT_RADIAL') {
      return `radial-gradient(${stops})`
    }
    if (paint.type === 'GRADIENT_ANGULAR') {
      return `angular-gradient(${stops})`
    }
    if (paint.type === 'GRADIENT_DIAMOND') {
      return `diamond-gradient(${stops})`
    }
  }

  return paint.type.toLowerCase()
}

const renderStyleEffect = (effect: FigmaEffect): string => {
  if (effect.type === 'DROP_SHADOW') {
    const colorHex =
      effect.color !== undefined
        ? rgbaToHex(effect.color)
        : '?'
    const ox = effect.offset?.x ?? 0
    const oy = effect.offset?.y ?? 0
    return `shadow(${ox},${oy},${effect.radius ?? 0},${colorHex})`
  }
  if (effect.type === 'INNER_SHADOW') {
    const colorHex =
      effect.color !== undefined
        ? rgbaToHex(effect.color)
        : '?'
    const ox = effect.offset?.x ?? 0
    const oy = effect.offset?.y ?? 0
    return `inner-shadow(${ox},${oy},${effect.radius ?? 0},${colorHex})`
  }
  if (effect.type === 'BACKGROUND_BLUR') {
    return `bg-blur(${effect.radius ?? 0})`
  }
  if (effect.type === 'LAYER_BLUR') {
    return `blur(${effect.radius ?? 0})`
  }
  return effect.type.toLowerCase()
}

const renderGridValue = (
  grids: Record<string, unknown>[],
): string => {
  if (grids.length === 0) {
    return 'none'
  }
  const grid = grids[0] as {
    pattern: string
    count?: number
    sectionSize?: number
    gutterSize?: number
  }
  if (grid.pattern === 'COLUMNS') {
    return `columns(${grid.count},${grid.sectionSize},${grid.gutterSize})`
  }
  if (grid.pattern === 'ROWS') {
    return `rows(${grid.count},${grid.sectionSize},${grid.gutterSize})`
  }
  if (grid.pattern === 'GRID') {
    return `grid(${grid.sectionSize})`
  }
  return grid.pattern.toLowerCase()
}

export const toStylesTree = (raw: {
  paint: Record<string, unknown>[]
  text: Record<string, unknown>[]
  effect: Record<string, unknown>[]
  grid: Record<string, unknown>[]
}): string => {
  const counts: string[] = []
  if (raw.paint.length > 0) {
    counts.push(`${raw.paint.length} paint`)
  }
  if (raw.text.length > 0) {
    counts.push(`${raw.text.length} text`)
  }
  if (raw.effect.length > 0) {
    counts.push(`${raw.effect.length} effect`)
  }
  if (raw.grid.length > 0) {
    counts.push(`${raw.grid.length} grid`)
  }

  const total =
    raw.paint.length +
    raw.text.length +
    raw.effect.length +
    raw.grid.length
  const header = `# ${total} styles: ${counts.join(', ')}`

  const lines: string[] = []

  for (const s of raw.paint) {
    const value = renderPaintValue(
      s.paints as Record<string, unknown>[],
    )
    lines.push(`- ${s.name} [${s.id}] paint ${value}`)
  }

  for (const s of raw.text) {
    const font = `${s.fontFamily}/${s.fontStyle}/${s.fontSize}`
    lines.push(`- ${s.name} [${s.id}] text ${font}`)
  }

  for (const s of raw.effect) {
    const effects = (s.effects as FigmaEffect[])
      .filter(e => e.visible !== false)
      .map(renderStyleEffect)
      .join('+')
    lines.push(`- ${s.name} [${s.id}] effect ${effects}`)
  }

  for (const s of raw.grid) {
    const value = renderGridValue(
      s.grids as Record<string, unknown>[],
    )
    lines.push(`- ${s.name} [${s.id}] grid ${value}`)
  }

  return header + '\n\n' + lines.join('\n') + '\n'
}

// --- toComponentsTree ---

export const toComponentsTree = (raw: {
  local: Record<string, unknown>[]
  remote: Record<string, unknown>[]
}): string => {
  const header = `# ${raw.local.length} local, ${raw.remote.length} remote`

  const lines: string[] = []

  for (const c of raw.local) {
    let line = `- ${c.name} [${c.id}]`

    const variants = c.variants as Record<
      string,
      string[]
    > | null
    if (
      variants !== null &&
      variants !== undefined &&
      Object.keys(variants).length > 0
    ) {
      const variantStr = Object.entries(variants)
        .map(([k, v]) => `${k}=${v.join('|')}`)
        .join(', ')
      line += ` ${variantStr}`
    }

    const properties = c.properties as
      | { name: string; type: string }[]
      | undefined
    if (properties !== undefined && properties.length > 0) {
      const propStr = properties
        .map(p => {
          const shortType =
            p.type === 'BOOLEAN'
              ? 'BOOL'
              : p.type === 'INSTANCE_SWAP'
                ? 'SWAP'
                : p.type
          return `${p.name}:${shortType}`
        })
        .join(' ')
      line += ` ${propStr}`
    }

    lines.push(line)
  }

  for (const r of raw.remote) {
    lines.push(
      `- ${r.name} [remote:${r.library}] key:${r.key}`,
    )
  }

  return header + '\n\n' + lines.join('\n') + '\n'
}

// --- toFullJson ---

export const truncateChildren = (
  raw: Record<string, unknown>,
  maxDepth: number,
  currentDepth: number,
): Record<string, unknown> => {
  const result = { ...raw }

  if (result.children && Array.isArray(result.children)) {
    if (maxDepth !== -1 && currentDepth >= maxDepth) {
      result.children = (
        result.children as Record<string, unknown>[]
      ).map(child => ({
        id: child.id,
        name: child.name,
        type: child.type,
      }))
    } else {
      result.children = (
        result.children as Record<string, unknown>[]
      ).map(child =>
        truncateChildren(child, maxDepth, currentDepth + 1),
      )
    }
  }

  return result
}

/**
 * Depth semantics:
 * - depth 0 = root node with child stubs only (children shown as { id, name, type })
 * - depth 1 = root + full first-level children, grandchild stubs
 * - depth 3 (default) = 3 levels of full data
 * - depth -1 = unlimited (no truncation)
 */
export const toFullJson = (
  raw: Record<string, unknown>,
  depth = 3,
): string => {
  if (depth === -1) {
    return JSON.stringify(raw, null, 2)
  }
  return JSON.stringify(
    truncateChildren(raw, depth, 0),
    null,
    2,
  )
}

// --- toPageLayoutYaml ---

/** @deprecated Use toPageLayoutTree instead */
export const toPageLayoutYaml = (raw: {
  pageName: string
  frames: Record<string, unknown>[]
}): string => {
  const { pageName, frames } = raw
  const mapped: PageFrameInfo[] = frames.map(f => ({
    id: f.id as string,
    name: f.name as string,
    type: (f.type as string) ?? 'FRAME',
    size: [f.width as number, f.height as number] as [
      number,
      number,
    ],
    position: [f.x as number, f.y as number] as [
      number,
      number,
    ],
    childrenCount: (f.childCount as number) ?? 0,
  }))

  const [canvasW, canvasH] = computeCanvasBounds(
    mapped.map(f => ({
      x: f.position[0],
      y: f.position[1],
      w: f.size[0],
      h: f.size[1],
    })),
  )

  const header = [
    `# ${pageName}`,
    `# ${mapped.length} top-level frames | canvas: ${canvasW}×${canvasH}`,
    '',
  ].join('\n')

  const yamlData = mapped.map(f => ({
    id: f.id,
    name: f.name,
    size: f.size,
    position: f.position,
    children_count: f.childrenCount,
  }))

  return (
    header + YAML.stringify(yamlData, { lineWidth: 120 })
  )
}

// --- toStylesYaml ---

/** @deprecated Use toStylesTree instead */
export const toStylesYaml = (raw: {
  paint: Record<string, unknown>[]
  text: Record<string, unknown>[]
  effect: Record<string, unknown>[]
  grid: Record<string, unknown>[]
}): string => {
  const counts: string[] = []
  const sections: Record<string, unknown>[] = []

  if (raw.paint.length > 0) {
    counts.push(`${raw.paint.length} paint`)
    const paintEntries = raw.paint.map(s => {
      const paints = s.paints as FigmaFill[]
      const solidFill = paints.find(
        p =>
          p.type === 'SOLID' &&
          p.color !== null &&
          p.color !== undefined,
      )

      return {
        id: s.id,
        name: s.name,
        ...(solidFill !== undefined
          ? { color: rgbaToHex(solidFill.color as RGBA) }
          : {}),
      }
    })
    sections.push({ paint: paintEntries })
  }

  if (raw.text.length > 0) {
    counts.push(`${raw.text.length} text`)
    const textEntries = raw.text.map(s => ({
      id: s.id,
      name: s.name,
      font: `${s.fontFamily}/${s.fontStyle}/${s.fontSize}`,
      ...(s.lineHeight !== null &&
      s.lineHeight !== undefined
        ? { lineHeight: s.lineHeight }
        : {}),
    }))
    sections.push({ text: textEntries })
  }

  if (raw.effect.length > 0) {
    counts.push(`${raw.effect.length} effect`)
    const effectEntries = raw.effect.map(s => {
      const effects = s.effects as FigmaEffect[]
      const parsed = parseEffects(effects)

      return {
        id: s.id,
        name: s.name,
        ...(parsed !== undefined
          ? { effects: parsed }
          : {}),
      }
    })
    sections.push({ effect: effectEntries })
  }

  const total =
    raw.paint.length +
    raw.text.length +
    raw.effect.length +
    raw.grid.length
  const header = `# ${total} styles: ${counts.join(', ')}\n\n`
  const body = sections
    .map(sec => YAML.stringify(sec, { lineWidth: 120 }))
    .join('\n')

  return header + body
}

// --- toSearchYaml ---

export const toSearchYaml = (
  results: SearchResult[],
  truncated: boolean,
): string => {
  const summary = `# ${results.length} results${truncated ? ' (truncated)' : ''}`
  const data = {
    results: results.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      page: r.page,
      parent: r.parent,
      size: r.size,
    })),
  }

  return `${summary}\n\n${YAML.stringify(data)}`
}

// --- toComponentsYaml ---

/** @deprecated Use toComponentsTree instead */
export const toComponentsYaml = (raw: {
  local: Record<string, unknown>[]
  remote: Record<string, unknown>[]
}): string => {
  const header = `# ${raw.local.length} local components, ${raw.remote.length} remote in use\n\n`

  const localEntries = raw.local.map(c => ({
    id: c.id,
    name: c.name,
    ...(c.page !== null && c.page !== undefined
      ? { page: c.page }
      : {}),
    ...(c.variants !== null && c.variants !== undefined
      ? { variants: c.variants }
      : {}),
    ...(Array.isArray(c.properties) &&
    c.properties.length > 0
      ? { properties: c.properties }
      : {}),
  }))

  const remoteEntries = raw.remote.map(r => ({
    name: r.name,
    library: r.library,
    ...(r.key !== null && r.key !== undefined
      ? { key: r.key }
      : {}),
    ...(r.instancesCount !== null &&
    r.instancesCount !== undefined
      ? { instances: r.instancesCount }
      : {}),
  }))

  const data: Record<string, unknown> = {
    local: localEntries,
  }
  if (remoteEntries.length > 0) {
    data.remote_in_use = remoteEntries
  }

  return header + YAML.stringify(data, { lineWidth: 120 })
}
