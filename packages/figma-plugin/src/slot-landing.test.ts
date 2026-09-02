// slot-landing.test.ts — B81/B94: a create into a slot LANDS, the route it took
// is selectable so a live probe can retire the default, and the id it answers
// is the id the node actually has.
//
// WHAT THE FIRST VERSION GOT WRONG, AND THE LIVE RUN PROVED (2026-09-03):
//
//   THE ARMS NEVER RAN. Every route was chosen off `sealedInstanceHost`, an
//   UPWARD `.parent` walk — and the handles this whole item exists for refuse
//   `.parent`. So the walk answered "no instance", staging was skipped, the
//   candidate arms threw "not available here", and all five configurations
//   fell through to the same `direct` append and the same refusal:
//   `Cannot create into I585:73434;585:73430;585:73440;585:73433 (SLOT):
//   Refusing to write to …: the file describes this node, but no live handle
//   answers it`. Not one arm made a meaningful Figma call.
//
//   So the target is now reached the way the coordinator's probe reached it:
//   DOWNWARD, from the nearest LIVE ancestor. `585:73434` (the outer instance
//   A) answers `getNodeByIdAsync`, and walking its children — Body → B → Cell —
//   reaches a handle Figma's own tree holds. No `.parent` read anywhere.
//
//   THE STAGED ANSWER WAS A DEAD ID. The one-level fill into A's Body answered
//   `585:73437` while the live id was `I585:73434;585:73430;585:73440` — Figma
//   RE-MINTS the node when it enters an instance slot, and the local segment
//   changed 73437 → 73440. Re-checked: answered `585:73446`, live
//   `I585:73434;585:73430;585:73447`. And `update_node` on the answered id
//   ACKED `{id, name, warnings:[]}` — a phantom write, law 2 (B94).
//
// THE FAKES MODEL FIGMA, NOT A PLAIN OBJECT.
//
//   `appendChild` MOVES a node — it detaches the child from its old parent
//   first. A list-push fake would let the staged route look right while the
//   page kept a duplicate (B14's debris).
//
//   `appendChild` INTO AN INSTANCE SLOT re-mints: a NEW node with a new local
//   id appears in the slot and the staged handle is dropped. That is the whole
//   of B94 and a plain-object fake cannot show it.
//
//   `appendChild` REFUSES on a nested slot in Figma's own words, quoting an
//   address composed off a pre-append id: *"in appendChild: The node (instance
//   sublayer or table cell) with id 'I581:58099;581:58287' does not exist"*.
//
//   The handles refuse `.parent` — the live signature every upward walk died on.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_SLOT_ROUTE,
  SLOT_ROUTES,
  SLOT_ROUTE_KEY,
  appendVia,
  TRACE_ROUTE,
  childIdsOf,
  childrenRefusal,
  descendToTarget,
  landingTargetRefusal,
  traceDescent,
  landedChildId,
  needsStaging,
  readSlotRoute,
  routeFellBackMessage,
  routeUnavailableMessage,
  stagedLandingMessage,
  unverifiedLandingMessage,
  type LandingNode,
} from './slot-landing'

/** Figma's own refusal, verbatim in shape (2026-09-03, live). */
const FIGMA_REFUSAL =
  'in appendChild: The node (instance sublayer or table cell) with id ' +
  '"I581:58099;581:58287" does not exist'

/** What a handle whose ancestry Figma composed off a stale id says. */
const REFUSES_PARENT = {
  get parent(): never {
    throw new Error(
      'in get_parent: The node (instance sublayer or table cell) does not exist',
    )
  },
}

/**
 * A container that behaves the way Figma's does.
 *
 * `refuses`  — the nested-slot append, in Figma's own words.
 * `reminting` — an INSTANCE slot: the append creates a NEW node with a new
 *               local id and DROPS the handle it was given (B94).
 * Every one of these refuses `.parent`, which is the live signature that
 * defeated the first version's upward walk.
 */
const figmaParent = ({
  id,
  type = 'FRAME',
  name = 'box',
  refuses = false,
  reminting,
}: {
  id: string
  type?: string
  name?: string
  refuses?: boolean
  /** The local segment the re-mint gives the landed node. */
  reminting?: string
}): LandingNode & { kids: LandingNode[] } => {
  const kids: LandingNode[] = []
  const node = {
    id,
    name,
    type,
    kids,
    appendChild(child: LandingNode & { kids?: LandingNode[] }) {
      if (refuses) throw new Error(FIGMA_REFUSAL)
      if (reminting !== undefined) {
        // Figma re-mints: a NEW node, under the parent's own chain.
        kids.push({
          id: node.id + ';' + reminting,
          name: child.name,
          type: child.type,
          kids: child.kids ?? [],
        })
        // …and the handle we were given is dropped.
        child.removed = true
        child.parent = null
        return
      }
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
    insertChild(
      index: number,
      child: LandingNode & { kids?: LandingNode[] },
    ) {
      if (refuses) throw new Error(FIGMA_REFUSAL)
      kids.splice(index, 0, child)
    },
  }
  Object.defineProperty(node, 'children', {
    configurable: true,
    enumerable: true,
    get: () => kids,
  })
  Object.defineProperty(
    node,
    'parent',
    Object.getOwnPropertyDescriptor(
      REFUSES_PARENT,
      'parent',
    ) as PropertyDescriptor,
  )
  return node as LandingNode & { kids: LandingNode[] }
}

/**
 * The coordinator's own construction, with its own ids.
 *
 *   A  = Card instance                585:73434
 *   ├─ Body  SLOT                     I585:73434;585:73430
 *   │   └─ B = Row instance           I585:73434;585:73430;585:73440
 *   │        └─ Cell SLOT             I585:73434;585:73430;585:73440;585:73433
 */
const cardRowFile = (opts?: { refuseCell?: boolean }) => {
  const a = figmaParent({
    id: '585:73434',
    type: 'INSTANCE',
    name: 'Card',
  })
  const body = figmaParent({
    id: 'I585:73434;585:73430',
    type: 'SLOT',
    name: 'Body',
    reminting: '585:73440',
  })
  a.kids.push(body)
  const b = figmaParent({
    id: 'I585:73434;585:73430;585:73440',
    type: 'INSTANCE',
    name: 'Row',
  })
  body.kids.push(b)
  const cell = figmaParent({
    id: 'I585:73434;585:73430;585:73440;585:73433',
    type: 'SLOT',
    name: 'Cell',
    refuses: opts?.refuseCell ?? false,
  })
  b.kids.push(cell)
  return { a, body, b, cell }
}

const CELL_ID = 'I585:73434;585:73430;585:73440;585:73433'

const freshNode = (id = '585:73437') => {
  const node: LandingNode & { kids: LandingNode[] } = {
    id,
    name: 'Row content',
    type: 'FRAME',
    kids: [],
  }
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
  })

  it('reads an override off plugin data, and a typo degrades to the working route', () => {
    expect(SLOT_ROUTE_KEY).toBe('figma-bridge:slotRoute')
    expect(readSlotRoute('inner-handle')).toBe('inner-handle')
    expect(readSlotRoute('slot-property')).toBe('slot-property')
    expect(readSlotRoute('')).toBe(DEFAULT_SLOT_ROUTE)
    expect(readSlotRoute('inner_handle')).toBe(
      DEFAULT_SLOT_ROUTE,
    )
  })
})

describe('B81 — reaching the target DOWNWARD (the live-wrong half)', () => {
  it('walks Body → B → Cell from the live ancestor, with no .parent read', () => {
    const { a, body, b, cell } = cardRowFile()
    const found = descendToTarget(a, CELL_ID)
    expect(found?.target).toBe(cell)
    // The chain is what the arms use to find an enclosing INSTANCE without
    // ever reading `.parent` — the read that defeated the first version.
    expect(found?.chain).toEqual([a, body, b, cell])
  })

  it('recovers when a MIDDLE segment was re-minted', () => {
    // The caller states an id read before the move; Figma has since re-minted
    // the instance's own segment (73437 → 73440), so neither the prefix nor
    // the local segment matches at that level. One child, one way down.
    const { a, cell } = cardRowFile()
    const stale =
      'I585:73434;585:73430;585:73437;585:73433'
    expect(descendToTarget(a, stale)?.target).toBe(cell)
  })

  it('will not GUESS past an ambiguous level', () => {
    const { a, body } = cardRowFile()
    body.kids.push(
      figmaParent({
        id: 'I585:73434;585:73430;585:73441',
        type: 'INSTANCE',
        name: 'Row',
      }),
    )
    const stale =
      'I585:73434;585:73430;585:73437;585:73433'
    expect(descendToTarget(a, stale)).toBeUndefined()
  })

  it('answers undefined when nothing on the chain matches', () => {
    const { a } = cardRowFile()
    expect(
      descendToTarget(a, 'I585:73434;999:1;999:2'),
    ).toBeUndefined()
  })

  it('answers undefined for a plain id — there is no chain to walk', () => {
    const { a } = cardRowFile()
    expect(descendToTarget(a, '585:73434')).toBeUndefined()
  })
})

describe('B81 — when a create has to be staged', () => {
  it('stages a COMPOUND parent id even though .parent refuses', () => {
    // The exact live-wrong condition: `sealedInstanceHost` cannot answer, so
    // the first version skipped staging entirely and every arm fell to
    // `direct`. A compound id says "inside an instance" without any walk.
    const { cell } = cardRowFile()
    expect(
      needsStaging('stage-then-move', CELL_ID, cell),
    ).toBe(true)
  })

  it('does NOT stage a plain frame — nothing seals it', () => {
    const frame = figmaParent({ id: '1:2', type: 'FRAME' })
    expect(
      needsStaging('stage-then-move', '1:2', frame),
    ).toBe(false)
  })

  it('does NOT stage when a candidate route is selected — the probe wants the raw answer', () => {
    const { cell } = cardRowFile()
    for (const route of SLOT_ROUTES) {
      if (route === DEFAULT_SLOT_ROUTE) continue
      expect(needsStaging(route, CELL_ID, cell)).toBe(false)
    }
  })
})

describe('B81 — the routes, each on the WALKED handle', () => {
  it("'direct': raises Figma's refusal unchanged for the caller to restate", () => {
    const { a } = cardRowFile({ refuseCell: true })
    const chain = descendToTarget(a, CELL_ID)
    expect(() =>
      appendVia('direct', chain!, freshNode()),
    ).toThrow(FIGMA_REFUSAL)
  })

  it("'direct': lands on the handle the downward walk found", () => {
    const { a, cell } = cardRowFile()
    const chain = descendToTarget(a, CELL_ID)
    const child = freshNode()
    appendVia('direct', chain!, child)
    expect(cell.kids).toContain(child)
  })

  it("'insert-child': goes through insertChild, not appendChild", () => {
    const { a, cell } = cardRowFile()
    cell.kids.push({ id: '800:1', name: 'Head' })
    const chain = descendToTarget(a, CELL_ID)
    const child = freshNode()
    appendVia('insert-child', chain!, child)
    expect(cell.kids[0]).toBe(child)
  })

  it("'inner-handle': appends through the ENCLOSING INSTANCE's own child, re-read at append time", () => {
    const { a, cell } = cardRowFile()
    const chain = descendToTarget(a, CELL_ID)
    const child = freshNode()
    appendVia('inner-handle', chain!, child)
    // B is the nearest INSTANCE on the chain, and the handle it hands back for
    // Cell is the one Figma's tree holds right now.
    expect(cell.kids).toContain(child)
  })

  it("'slot-property': drives the content through the instance's own override surface", () => {
    const { a, b } = cardRowFile()
    const written: Record<string, unknown>[] = []
    b.componentProperties = { 'Cell#12:3': {} }
    b.setProperties = (v: Record<string, unknown>) => {
      written.push(v)
    }
    const chain = descendToTarget(a, CELL_ID)
    appendVia('slot-property', chain!, freshNode())
    expect(written).toEqual([{ 'Cell#12:3': '585:73437' }])
  })

  it("'slot-property': a route the runtime cannot offer SAYS SO — silence would read as success", () => {
    const { a } = cardRowFile()
    const chain = descendToTarget(a, CELL_ID)
    expect(() =>
      appendVia('slot-property', chain!, freshNode()),
    ).toThrow(
      routeUnavailableMessage(
        'slot-property',
        'the enclosing INSTANCE exposes no setProperties',
      ),
    )
  })

  it("'inner-handle' with no INSTANCE on the chain says so rather than appending somewhere", () => {
    const frame = figmaParent({ id: '1:2', type: 'FRAME' })
    expect(() =>
      appendVia(
        'inner-handle',
        { target: frame, chain: [frame] },
        freshNode(),
      ),
    ).toThrow('no INSTANCE')
  })
})

describe('B94 — the id a staged create answers is the id the node HAS', () => {
  it('reads the landed id off the parent, because Figma RE-MINTS on the way in', () => {
    const { a, body } = cardRowFile()
    const chain = descendToTarget(
      a,
      'I585:73434;585:73430',
    )
    const staged = freshNode('585:73437')
    const before = childIdsOf(chain!.target)
    appendVia('direct', chain!, staged)
    const after = childIdsOf(chain!.target)
    // The staged handle is gone and a new node is in the slot.
    expect(staged.removed).toBe(true)
    expect(landedChildId(before, after)).toBe(
      'I585:73434;585:73430;585:73440',
    )
    // …which is NOT the id the create would have answered.
    expect(landedChildId(before, after)).not.toBe(
      '585:73437',
    )
    // B was already there; the landed node joins it rather than replacing it.
    expect(body.kids).toHaveLength(2)
    expect(body.kids).not.toContain(staged)
  })

  it('answers undefined when no new child can be identified — an unverifiable landing is not a success', () => {
    expect(landedChildId(['a'], ['a'])).toBeUndefined()
    expect(
      landedChildId(['a'], ['a', 'b', 'c']),
    ).toBeUndefined()
    expect(landedChildId(undefined, ['a', 'b'])).toBeUndefined()
  })

  it('reads a parent that refuses its children as UNKNOWN, not as empty', () => {
    const refusing: LandingNode = {
      get children(): never {
        throw new Error('in get_children: does not exist')
      },
    }
    expect(childIdsOf(refusing)).toBeUndefined()
  })
})

describe('B81/B94 — the WALKED handle is what gets checked', () => {
  it('says nothing about a healthy target', () => {
    const { a } = cardRowFile()
    const chain = descendToTarget(a, CELL_ID)
    expect(
      landingTargetRefusal(chain!.target, CELL_ID),
    ).toBeUndefined()
  })

  it('a ZOMBIE that Figma also calls `removed` is still a ZOMBIE', () => {
    // THE FOURTH-ROUND DEFECT, exactly. `removed` reads TRUE on these handles,
    // so the drop branch fired first and produced a sentence that names no
    // remedy and sends the caller in a loop: "read the enclosing INSTANCE and
    // address the target by the id that read emits" — which is the id they
    // already had. The children refusal is the discriminator and it is checked
    // FIRST; `removed` alone decides nothing.
    const zombie: LandingNode = {
      id: CELL_ID,
      name: 'Cell',
      type: 'SLOT',
      removed: true,
      get children(): never {
        throw new Error(
          'in get_children: The node (instance sublayer or table cell) with id ' +
            '"I587:73534;587:73528" does not exist',
        )
      },
    }
    const refusal = landingTargetRefusal(zombie, CELL_ID)
    expect(refusal).toContain(
      'instance sublayer or table cell',
    )
    expect(refusal).not.toContain('no longer holds')
    // …and it names the remedy that actually works.
    expect(refusal).toContain('reparent_node')
  })

  it('names the working REMEDY, never just the diagnosis', () => {
    const zombie: LandingNode = {
      id: CELL_ID,
      type: 'SLOT',
      get children(): never {
        throw new Error('in get_children: boom')
      },
    }
    const refusal = landingTargetRefusal(zombie, CELL_ID)
    // The old restated refusal named a remedy and this one dropped it. A
    // refusal without a way through is worse than the bug it reports.
    expect(refusal).toContain('reparent_node')
    expect(refusal).toContain('page level')
  })

  it("names Figma's OWN words when the walked target refuses its children", () => {
    // The zombie signature the live probe read back: `get_node` on that id
    // answers id/name/type and carries `readError: the live handle … refused to
    // list its children`. If the append target is one of those, SAY SO — that
    // is the investigation's answer, not a sentence about a dropped node.
    const zombie: LandingNode = {
      id: CELL_ID,
      name: 'Cell',
      type: 'SLOT',
      get children(): never {
        throw new Error(
          'in get_children: The node (instance sublayer or table cell) with id ' +
            '"I586:73515;586:73507" does not exist',
        )
      },
    }
    const refusal = landingTargetRefusal(zombie, CELL_ID)
    expect(refusal).toContain(CELL_ID)
    expect(refusal).toContain(
      'instance sublayer or table cell',
    )
    // It must NOT claim the node is gone: it is right there, and it reads.
    expect(refusal).not.toContain('no longer holds')
  })

  it('keeps "no longer holds" for a target that is REALLY gone', () => {
    // Removed AND able to list its children: nothing zombie-ish about it, so
    // the re-mint sentence is the right one.
    const dropped: LandingNode = {
      id: '585:73437',
      type: 'FRAME',
      removed: true,
      children: [],
    }
    expect(
      landingTargetRefusal(dropped, '585:73437'),
    ).toContain('no longer holds')
  })

  it('reports the throw itself, so nothing is paraphrased away', () => {
    const zombie: LandingNode = {
      get children(): never {
        throw new Error('in get_children: boom')
      },
    }
    expect(childrenRefusal(zombie)).toContain('boom')
    expect(childrenRefusal({ children: [] })).toBeUndefined()
  })
})

// The dispatcher has run four rounds of probes and every one of them was
// stopped before it reached Figma. No more blind fixes: `trace` makes the
// plugin report what it actually did, in Figma's own words, and writes nothing
// the caller keeps.
describe('B81 — the trace route', () => {
  it('is selectable on the same key, and is NOT part of the probe order', () => {
    expect(TRACE_ROUTE).toBe('trace')
    expect(readSlotRoute('trace')).toBe('trace')
    expect([...SLOT_ROUTES]).not.toContain(TRACE_ROUTE)
  })

  it('records every level the walk executed: asked, got, and the children count', () => {
    const { a } = cardRowFile()
    const { steps, chain } = traceDescent(a, CELL_ID)
    expect(chain?.target).toBeDefined()
    expect(steps).toHaveLength(3)
    expect(steps[0].asked).toBe('I585:73434;585:73430')
    expect(steps[0].got).toBe('I585:73434;585:73430')
    expect(steps[0].type).toBe('SLOT')
    expect(steps[0].children).toBe(1)
    expect(steps[2].got).toBe(CELL_ID)
    expect(steps[2].matchedBy).toBe('id')
  })

  it("records Figma's VERBATIM throw when a level will not list its children", () => {
    const a = figmaParent({
      id: '585:73434',
      type: 'INSTANCE',
      name: 'Card',
    })
    const zombie: LandingNode = {
      id: 'I585:73434;585:73430',
      name: 'Body',
      type: 'SLOT',
      get children(): never {
        throw new Error(
          'in get_children: The node (instance sublayer or table cell) with id ' +
            '"I585:73440;585:73433" does not exist',
        )
      },
    }
    a.kids.push(zombie)
    const { steps, chain } = traceDescent(a, CELL_ID)
    expect(chain).toBeUndefined()
    const refused = steps.find(
      st => st.refusal !== undefined,
    )
    expect(refused?.refusal).toContain(
      'instance sublayer or table cell',
    )
    expect(refused?.got).toBe('I585:73434;585:73430')
  })

  it('says WHY it could not reach the target, rather than going quiet', () => {
    const { a } = cardRowFile()
    const { steps, chain } = traceDescent(
      a,
      'I585:73434;999:1;999:2',
    )
    expect(chain).toBeUndefined()
    expect(steps[steps.length - 1].matchedBy).toBe('none')
  })

  it('records which rule matched each level, so a re-mint is visible', () => {
    const { a } = cardRowFile()
    const stale =
      'I585:73434;585:73430;585:73437;585:73433'
    const { steps } = traceDescent(a, stale)
    expect(steps[1].matchedBy).toBe('only-child')
    expect(steps[1].asked).toBe(
      'I585:73434;585:73430;585:73437',
    )
    expect(steps[1].got).toBe(
      'I585:73434;585:73430;585:73440',
    )
  })
})

describe('B81 — what the reply says', () => {
  it('the staged create names the route, the host and the id it hands back', () => {
    const message = stagedLandingMessage({
      operation: 'create_tree',
      parentId: CELL_ID,
      hostName: 'Row',
      hostId: 'I585:73434;585:73430;585:73440',
    })
    expect(message).toContain(
      'built at page level and moved into',
    )
    expect(message).toContain(CELL_ID)
    expect(message).toContain(
      '"Row" (I585:73434;585:73430;585:73440)',
    )
    expect(message).toContain('re-mints')
  })

  it('an unverifiable landing says so, and names what to read', () => {
    const message = unverifiedLandingMessage(CELL_ID)
    expect(message).toContain(CELL_ID)
    expect(message).toContain('could not')
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
    expect(src).not.toContain('params.slotRoute')
  })

  it('reaches the target by the DOWNWARD walk, from the live ancestor', () => {
    expect(src).toContain('descendToTarget(')
    // The upward walk must not be what decides the route any more.
    expect(src).toContain('needsStaging(')
    expect(src).toContain('stagedLandingMessage(')
  })

  it('sends the append through the seam, so a candidate route reaches Figma', () => {
    expect(src).toContain('appendVia(')
    expect(src).toContain('routeFellBackMessage(')
  })

  it('answers the id read back off the parent, never the staged one', () => {
    expect(src).toContain('landedChildId(')
    expect(src).toContain('childIdsOf(')
    expect(src).toContain('unverifiedLandingMessage(')
  })

  it('answers the COMPOSED id, which is what the reply sentence promises', () => {
    // The landed child answers a plain alias while the file names it by the
    // instance chain. The reply says "the id AFTER the move", so it has to be
    // the id the file uses — the same oracle B89 renamed search rows with.
    expect(src).toContain('canonicalIdFor(')
  })

  it('WALKS before it resolves, so no gate can pre-empt the walk', () => {
    const arm = src.slice(
      src.indexOf('case COMMANDS.CREATE_NODE:'),
      src.indexOf('case COMMANDS.CREATE_TREE:'),
    )
    const walk = arm.indexOf('walkToLandingTarget(')
    const resolve = arm.indexOf('resolveNodeId(')
    expect(walk).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(-1)
    // Live: the resolver's own gate refused the target before the walk ran,
    // and all four probe arms made no Figma call.
    expect(walk).toBeLessThan(resolve)
  })

  it('checks the WALKED handle, not the resolver’s', () => {
    expect(src).toContain('landingTargetRefusal(')
  })

  it('runs the trace route, and cleans up after itself', () => {
    expect(src).toContain('TRACE_ROUTE')
    expect(src).toContain('traceDescent(')
    expect(src).toContain('runSlotRouteTrace')
  })
})
