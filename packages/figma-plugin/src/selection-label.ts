// Pure selection logic — no React, no Figma API — so it unit-tests
// under `bun test`. code.ts cannot host this: it calls figma.showUI()
// at module load, so importing it in a test boots the plugin.

// Prototype-free so an inherited key ('toString') can never be
// mistaken for a noun.
const NOUNS: Record<string, readonly [string, string]> =
  Object.assign(Object.create(null), {
    FRAME: ['frame', 'frames'],
    GROUP: ['group', 'groups'],
    SECTION: ['section', 'sections'],
    TEXT: ['text layer', 'text layers'],
    RECTANGLE: ['rectangle', 'rectangles'],
    ELLIPSE: ['ellipse', 'ellipses'],
    POLYGON: ['polygon', 'polygons'],
    STAR: ['star', 'stars'],
    LINE: ['line', 'lines'],
    VECTOR: ['vector', 'vectors'],
    COMPONENT: ['component', 'components'],
    COMPONENT_SET: ['component set', 'component sets'],
    INSTANCE: ['instance', 'instances'],
    BOOLEAN_OPERATION: ['boolean', 'booleans'],
  })

// Homogeneous selection → its NodeType; mixed → 'MIXED'; empty →
// null. Structurally typed so code.ts can pass
// figma.currentPage.selection straight in (no map, no allocation)
// and tests can pass plain objects. Early-exits on the first
// difference, so a huge multi-select stays cheap.
export const homogeneousKind = (
  sel: readonly { type: string }[],
): string | null => {
  if (sel.length === 0) return null
  const first = sel[0].type
  for (const node of sel) {
    if (node.type !== first) return 'MIXED'
  }
  return first
}

export const selectionNoun = (
  kind: string | null,
  count: number,
): string => {
  const pair = kind ? NOUNS[kind] : undefined
  if (pair) return count === 1 ? pair[0] : pair[1]
  return count === 1 ? 'node' : 'nodes'
}

export const selectionLabel = (
  count: number,
  kind: string | null,
): string =>
  `${count} ${selectionNoun(kind, count)} selected`
