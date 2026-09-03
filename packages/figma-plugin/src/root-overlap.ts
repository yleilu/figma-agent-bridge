// root-overlap.ts — a write that GROWS a page-root frame into its neighbour
// says so (I5, growth half).
//
// I5 was filed as a PLACEMENT problem: five page-root nodes created with no
// position all landed at [0,0], piled on each other. The 2026-09-01 design
// review widened it, and the wider half is the one that bites a competent
// caller. The 2026-08-30 operator stated sane positions — a section at y=1400,
// the next at y=1900, a 500px budget between them — and then appended into the
// first. It HUGS, so it grew to 556 and 56px of it went into its neighbour.
// Silently. A placement-time checker would have passed that write: at placement
// time there was nothing wrong.
//
// So the question this module asks is not "where should this go" but "did what
// I just did move a page-root frame into another one". That is answerable
// exactly, from two measurements of the same box, and it needs no policy about
// where things belong.
//
// ONLY WHAT THE WRITE CAUSED. A pair that already overlapped before the write
// is not this write's finding — reporting it would put a warning on every
// unrelated edit inside a document someone has decided to lay out that way, and
// the one warning that means something would be lost in them. The check
// compares the overlap set before against the overlap set after and reports the
// difference.
//
// PAGE-ROOT ONLY. Inside a frame, overlap is ordinary composition — a badge on
// an avatar, a label over an image. Between top-level frames on a page it is
// almost always an accident, because nothing arranges them: the page is not an
// auto-layout parent, so no reflow ever separates them again.
//
// Structural on the node side, so the whole rule is testable against plain
// objects without a Figma runtime.

/** As much of a node as the bounds check reads. */
export type BoxNode = Partial<{
  id: unknown
  name: unknown
  type: unknown
  x: unknown
  y: unknown
  width: unknown
  height: unknown
  parent: unknown
  children: unknown
}>

/** One node's box in its parent's coordinates. */
export type Box = {
  x: number
  y: number
  width: number
  height: number
}

/** How far a walk climbs before it gives up. See resolve-node.ts. */
const MAX_HOPS = 64

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : undefined

/** A node's box, or undefined when it will not state one. */
export const boxOf = (
  node: BoxNode | undefined,
): Box | undefined => {
  if (node === undefined) return undefined
  try {
    const x = num(node.x)
    const y = num(node.y)
    const width = num(node.width)
    const height = num(node.height)
    return x === undefined ||
      y === undefined ||
      width === undefined ||
      height === undefined
      ? undefined
      : { x, y, width, height }
  } catch {
    return undefined
  }
}

/**
 * The PAGE-ROOT frame a node lives under — the ancestor whose own parent is the
 * PAGE — or undefined when the node is not on a page at all.
 *
 * A node that IS a page root answers itself: a create into it and an update of
 * it change the same box.
 */
export const pageRootOf = (
  node: BoxNode,
): BoxNode | undefined => {
  let current: BoxNode = node
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let parent: unknown
    try {
      parent = current.parent
    } catch {
      return undefined
    }
    if (typeof parent !== 'object' || parent === null) {
      return undefined
    }
    const p = parent as BoxNode
    let type: unknown
    try {
      type = p.type
    } catch {
      return undefined
    }
    if (type === 'PAGE') return current
    current = p
  }
  return undefined
}

/** The overlap of two boxes, or undefined when they do not touch. */
export const overlapOf = (
  a: Box,
  b: Box,
): { width: number; height: number } | undefined => {
  const width =
    Math.min(a.x + a.width, b.x + b.width) -
    Math.max(a.x, b.x)
  const height =
    Math.min(a.y + a.height, b.y + b.height) -
    Math.max(a.y, b.y)
  // A shared EDGE is not an overlap: two frames laid out side by side at
  // x=0,w=100 and x=100 touch on purpose, and warning there would fire on the
  // tidiest possible page.
  return width > 0 && height > 0 ? { width, height } : undefined
}

const labelOf = (node: BoxNode): string => {
  try {
    const name = node.name
    if (typeof name === 'string' && name !== '') {
      return '"' + name + '"'
    }
    const id = node.id
    return typeof id === 'string' ? id : 'a page-root frame'
  } catch {
    return 'a page-root frame'
  }
}

/** The page-root frames beside this one. */
const siblingsOf = (root: BoxNode): BoxNode[] => {
  try {
    const parent = root.parent
    if (typeof parent !== 'object' || parent === null) {
      return []
    }
    const kids = (parent as BoxNode).children
    if (!Array.isArray(kids)) return []
    return (kids as BoxNode[]).filter(k => k !== root)
  } catch {
    return []
  }
}

/** How many neighbours a warning names before it summarises (T4). */
const NAMED_NEIGHBOURS = 3

/**
 * The warning for a page-root frame whose bounds just grew into a neighbour.
 *
 * `before` is the same frame's box as it was BEFORE the write. Pass it and the
 * check reports only the overlaps the write created; a box that did not grow
 * reports nothing at all, however it already sat.
 *
 * Returns undefined when there is nothing to say — which is nearly always.
 */
export const grownIntoNeighbourWarning = (
  root: BoxNode | undefined,
  before: Box | undefined,
): string | undefined => {
  if (root === undefined) return undefined
  const after = boxOf(root)
  if (after === undefined) return undefined
  // Nothing grew, so nothing this write did can have caused a collision. A
  // frame that SHRANK is the same non-event.
  if (
    before !== undefined &&
    after.width <= before.width &&
    after.height <= before.height
  ) {
    return undefined
  }
  const hits: { label: string; width: number; height: number }[] =
    []
  for (const sibling of siblingsOf(root)) {
    const box = boxOf(sibling)
    if (box === undefined) continue
    const now = overlapOf(after, box)
    if (now === undefined) continue
    // Already overlapping before the write? Then it is not this write's
    // finding, and saying so on every edit would bury the one that is.
    if (
      before !== undefined &&
      overlapOf(before, box) !== undefined
    ) {
      continue
    }
    hits.push({
      label: labelOf(sibling),
      width: now.width,
      height: now.height,
    })
  }
  if (hits.length === 0) return undefined
  const named = hits
    .slice(0, NAMED_NEIGHBOURS)
    .map(
      h =>
        h.label +
        ' by ' +
        String(Math.round(h.width)) +
        '×' +
        String(Math.round(h.height)) +
        'px',
    )
    .join(', ')
  const rest =
    hits.length > NAMED_NEIGHBOURS
      ? ' and ' +
        String(hits.length - NAMED_NEIGHBOURS) +
        ' more'
      : ''
  return (
    'this write grew the page-root frame ' +
    labelOf(root) +
    ' from ' +
    String(Math.round(before?.width ?? after.width)) +
    '×' +
    String(Math.round(before?.height ?? after.height)) +
    ' to ' +
    String(Math.round(after.width)) +
    '×' +
    String(Math.round(after.height)) +
    ', and it now overlaps ' +
    named +
    rest +
    '. Nothing arranges page-root frames, so they will stay overlapped: move ' +
    'one, or put the sections in a single page-root auto-layout stack so ' +
    'growth reflows instead of colliding.'
  )
}
