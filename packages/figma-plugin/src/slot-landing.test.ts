// slot-landing.test.ts — B81: a create into a slot LANDS, and the route it
// took is selectable so a live probe can retire the default.
//
// THE FAKES MODEL FIGMA, NOT A PLAIN OBJECT, and they have to.
//
//   `appendChild` MOVES a node. It is not a list push: Figma detaches the child
//   from its old parent first. A plain-object fake pushes and leaves the node in
//   both places, which would let the staged route look like it worked while the
//   page kept a duplicate — the exact debris B14 is about.
//
//   `appendChild` REFUSES on a nested slot, in Figma's own words, quoting an
//   address Figma composed off the inner instance's PRE-APPEND id:
//   *"in appendChild: The node (instance sublayer or table cell) with id
//   'I581:58099;581:58287' does not exist"*. Two segments, naming no node. That
//   sentence is live evidence (2026-09-03, and 69 of the 2026-09-02 artifact's
//   300 readErrors quote the same shape from other verbs), and it is what every
//   candidate route here is being tested against.
//
//   The handle a LOOKUP returns and the handle the live TREE holds are
//   different objects for slot content — the file says `I<outer>;<mid>;<leaf>`
//   and the handle answers a plain pre-append id (canonical-ids.ts). The
//   'inner-handle' arm exists only because of that, so the fake keeps them
//   distinct.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_SLOT_ROUTE,
  SLOT_ROUTES,
  SLOT_ROUTE_KEY,
  appendVia,
  landingHost,
  liveHandleFor,
  needsStaging,
  readSlotRoute,
  routeFellBackMessage,
  routeUnavailableMessage,
  sealingInstanceNode,
  stagedLandingMessage,
  type LandingNode,
} from './slot-landing'

/** Figma's own refusal, verbatim in shape (2026-09-03, live). */
const FIGMA_REFUSAL =
  'in appendChild: The node (instance sublayer or table cell) with id ' +
  '"I581:58099;581:58287" does not exist'

/**
 * A container whose `appendChild` behaves the way Figma's does: it DETACHES the
 * child from whatever held it, then takes it.
 *
 * `refuses` models the other live behaviour of the same method on a nested
 * slot — the node keeps its old parent, and nothing moved.
 */
const figmaParent = ({
  id,
  type = 'FRAME',
  name = 'box',
  parent,
  refuses = false,
}: {
  id: string
  type?: string
  name?: string
  parent?: LandingNode
  refuses?: boolean
}): LandingNode & { kids: LandingNode[] } => {
  const kids: LandingNode[] = []
  const node = {
    id,
    name,
    type,
    parent,
    kids,
    appendChild(child: LandingNode) {
      if (refuses) throw new Error(FIGMA_REFUSAL)
      const held = child.parent as
        | (LandingNode & { kids?: LandingNode[] })
        | undefined
      if (held?.kids !== undefined) {
        const at = held.kids.indexOf(child)
        if (at >= 0) held.kids.splice(at, 1)
      }
      child.parent = node
      kids.push(child)
    },
    insertChild(index: number, child: LandingNode) {
      if (refuses) throw new Error(FIGMA_REFUSAL)
      child.parent = node
      kids.splice(index, 0, child)
    },
  }
  Object.defineProperty(node, 'children', {
    configurable: true,
    enumerable: true,
    get: () => kids,
  })
  return node as LandingNode & { kids: LandingNode[] }
}

/** A page, an outer INSTANCE, its SLOT, an inner INSTANCE and ITS slot. */
const nestedSlotFile = (opts?: {
  refuseInnerSlot?: boolean
}) => {
  const page = figmaParent({ id: '0:1', type: 'PAGE', name: 'Overview' })
  const outer = figmaParent({
    id: '581:58099',
    type: 'INSTANCE',
    name: 'Chart card',
    parent: page,
  })
  page.kids.push(outer)
  const outerSlot = figmaParent({
    id: 'I581:58099;581:58200',
    type: 'SLOT',
    name: 'Body',
    parent: outer,
  })
  outer.kids.push(outerSlot)
  const inner = figmaParent({
    id: '581:58274',
    type: 'INSTANCE',
    name: 'Table',
    parent: outerSlot,
  })
  outerSlot.kids.push(inner)
  // The handle the LIVE TREE holds for the inner slot: its id is composed off
  // the inner instance's pre-append id, the way Figma composes them.
  const innerSlotLive = figmaParent({
    id: 'I581:58274;581:58287',
    type: 'SLOT',
    name: 'Rows',
    parent: inner,
    refuses: opts?.refuseInnerSlot ?? false,
  })
  inner.kids.push(innerSlotLive)
  return { page, outer, outerSlot, inner, innerSlotLive }
}

/** A freshly created node, parented to the page the way Figma parents one. */
const freshNode = (page: LandingNode & { kids: LandingNode[] }) => {
  const node: LandingNode = {
    id: '900:1',
    name: 'Row',
    type: 'FRAME',
    parent: page,
  }
  page.kids.push(node)
  return node
}

describe('B81 — the route enumeration', () => {
  it('names every candidate the probe has to try, and the default last', () => {
    expect([...SLOT_ROUTES]).toEqual([
      'direct',
      'insert-child',
      'inner-handle',
      'slot-property',
      'stage-then-move',
    ])
    expect(DEFAULT_SLOT_ROUTE).toBe('stage-then-move')
    expect(SLOT_ROUTES[SLOT_ROUTES.length - 1]).toBe(
      DEFAULT_SLOT_ROUTE,
    )
  })

  it('reads an override off plugin data, and a typo degrades to the working route', () => {
    expect(SLOT_ROUTE_KEY).toBe('figma-bridge:slotRoute')
    expect(readSlotRoute('inner-handle')).toBe('inner-handle')
    expect(readSlotRoute('slot-property')).toBe('slot-property')
    expect(readSlotRoute('')).toBe(DEFAULT_SLOT_ROUTE)
    expect(readSlotRoute('inner_handle')).toBe(
      DEFAULT_SLOT_ROUTE,
    )
    expect(readSlotRoute(undefined)).toBe(DEFAULT_SLOT_ROUTE)
  })
})

describe('B81 — when a create has to be staged', () => {
  it('stages an append into a slot INSIDE an instance', () => {
    const { innerSlotLive, outerSlot } = nestedSlotFile()
    expect(needsStaging('stage-then-move', innerSlotLive)).toBe(
      true,
    )
    expect(needsStaging('stage-then-move', outerSlot)).toBe(
      true,
    )
  })

  it('does NOT stage a plain frame — nothing seals it, so nothing is moved', () => {
    const page = figmaParent({ id: '0:1', type: 'PAGE' })
    const frame = figmaParent({
      id: '1:2',
      type: 'FRAME',
      parent: page,
    })
    expect(needsStaging('stage-then-move', frame)).toBe(false)
    expect(landingHost(frame)).toBeUndefined()
  })

  it('does NOT stage when a candidate route is selected — the probe wants the raw answer', () => {
    const { innerSlotLive } = nestedSlotFile()
    for (const route of SLOT_ROUTES) {
      if (route === DEFAULT_SLOT_ROUTE) continue
      expect(needsStaging(route, innerSlotLive)).toBe(false)
    }
  })

  it('names the sealing INSTANCE, so the staged message can say which one', () => {
    const { innerSlotLive, inner } = nestedSlotFile()
    expect(landingHost(innerSlotLive)).toEqual({
      id: inner.id as string,
      name: 'Table',
    })
    expect(sealingInstanceNode(innerSlotLive)).toBe(inner)
  })
})

describe('B81 — the routes themselves', () => {
  it("'direct': Figma's refusal is Figma's, raised unchanged for the caller to restate", () => {
    const { page, innerSlotLive } = nestedSlotFile({
      refuseInnerSlot: true,
    })
    const child = freshNode(page)
    expect(() =>
      appendVia('direct', innerSlotLive, child),
    ).toThrow(FIGMA_REFUSAL)
    // Nothing moved: the node is still where the create left it.
    expect(child.parent).toBe(page)
  })

  it("'direct': lands, and the child LEAVES the page (appendChild moves, it does not copy)", () => {
    const { page, innerSlotLive } = nestedSlotFile()
    const child = freshNode(page)
    appendVia('direct', innerSlotLive, child)
    expect(
      (innerSlotLive as { kids: LandingNode[] }).kids,
    ).toContain(child)
    expect(page.kids).not.toContain(child)
  })

  it("'insert-child': goes through insertChild, not appendChild", () => {
    const { page, innerSlotLive } = nestedSlotFile()
    const sibling = { id: '800:1', name: 'Head', type: 'FRAME' }
    ;(innerSlotLive as { kids: LandingNode[] }).kids.push(
      sibling,
    )
    const child = freshNode(page)
    appendVia('insert-child', innerSlotLive, child)
    expect(
      (innerSlotLive as { kids: LandingNode[] }).kids[0],
    ).toBe(child)
  })

  it("'inner-handle': appends through the handle the LIVE TREE holds, not the one handed in", () => {
    const { page, inner, innerSlotLive } = nestedSlotFile()
    // What a lookup on the canonical id returns: a different object, answering
    // the id the EXPORT gives the node. It refuses the append — the B81 fact.
    const paired = figmaParent({
      id: 'I581:58099;581:58200;581:58274;581:58287',
      type: 'SLOT',
      name: 'Rows',
      parent: inner,
      refuses: true,
    })
    const child = freshNode(page)
    appendVia('inner-handle', paired, child)
    // It landed on the tree's own handle, and nothing was written to the
    // paired one.
    expect(
      (innerSlotLive as { kids: LandingNode[] }).kids,
    ).toContain(child)
    expect((paired as { kids: LandingNode[] }).kids).toEqual(
      [],
    )
  })

  it("'inner-handle': prefers an EXACT id match over a same-tail one", () => {
    const { inner, innerSlotLive } = nestedSlotFile()
    const decoy = figmaParent({
      id: 'I999:1;581:58287',
      type: 'SLOT',
      name: 'Rows',
      parent: inner,
    })
    inner.kids.unshift(decoy)
    expect(liveHandleFor(inner, innerSlotLive)).toBe(
      innerSlotLive,
    )
  })

  it("'slot-property': drives the content through the instance's own override surface", () => {
    const { page, inner, innerSlotLive } = nestedSlotFile()
    const written: Record<string, unknown>[] = []
    inner.componentProperties = { 'Rows#12:3': {} }
    inner.setProperties = (v: Record<string, unknown>) => {
      written.push(v)
    }
    const child = freshNode(page)
    appendVia('slot-property', innerSlotLive, child)
    expect(written).toEqual([{ 'Rows#12:3': '900:1' }])
  })

  it("'slot-property': a route the runtime cannot offer SAYS SO — silence would read as success", () => {
    const { page, innerSlotLive } = nestedSlotFile()
    const child = freshNode(page)
    expect(() =>
      appendVia('slot-property', innerSlotLive, child),
    ).toThrow(
      routeUnavailableMessage(
        'slot-property',
        'the enclosing INSTANCE exposes no setProperties',
      ),
    )
  })

  it("'inner-handle' outside any instance says so rather than appending somewhere", () => {
    const page = figmaParent({ id: '0:1', type: 'PAGE' })
    const frame = figmaParent({
      id: '1:2',
      type: 'FRAME',
      parent: page,
    })
    expect(() =>
      appendVia('inner-handle', frame, { id: '9:9' }),
    ).toThrow('no INSTANCE encloses the target')
  })
})

describe('B81 — what the reply says', () => {
  it('the staged create names the route, the host and the id it hands back', () => {
    const message = stagedLandingMessage({
      operation: 'create_tree',
      parentId: 'I581:58274;581:58287',
      host: { id: '581:58274', name: 'Table' },
    })
    expect(message).toContain('built at page level and moved into')
    expect(message).toContain('I581:58274;581:58287')
    expect(message).toContain('"Table" (581:58274)')
    expect(message).toContain('AFTER the move')
  })

  it("a refused candidate route quotes Figma's own words for the probe to read", () => {
    const message = routeFellBackMessage(
      'inner-handle',
      FIGMA_REFUSAL,
    )
    expect(message).toContain('slot route "inner-handle"')
    expect(message).toContain(DEFAULT_SLOT_ROUTE)
    expect(message).toContain(
      'instance sublayer or table cell',
    )
  })
})

// The seam is worth nothing if `code.ts` never reaches it. `code.ts` cannot be
// imported outside Figma (it calls `figma.showUI(__html__)` at module scope),
// so this is the source scan `apply-wiring.test.ts` established — with its own
// liveness assertion, because an empty scan must not look like a pass.
describe('B81 — code.ts actually takes the route', () => {
  const src = readFileSync(
    join(import.meta.dir, 'code.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('read the file (liveness)', () => {
    expect(src).toContain('case COMMANDS.CREATE_TREE:')
  })

  it('selects the route from plugin data, not from a tool parameter', () => {
    expect(src).toContain('readSlotRoute(')
    expect(src).toContain('SLOT_ROUTE_KEY')
    // A public param would put a Figma-runtime unknown into the tool surface.
    expect(src).not.toContain('params.slotRoute')
  })

  it('stages the create doors, and says so on the reply', () => {
    expect(src).toContain('needsStaging(')
    expect(src).toContain('stagedLandingMessage(')
  })

  it('sends the append through the seam, so a candidate route reaches Figma', () => {
    expect(src).toContain('appendVia(')
    expect(src).toContain('routeFellBackMessage(')
  })
})
