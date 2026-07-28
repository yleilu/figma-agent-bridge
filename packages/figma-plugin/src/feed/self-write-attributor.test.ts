import { describe, it, expect } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import { createSelfWriteAttributor } from './self-write-attributor'
import { createWriteScope } from './write-scope'
import type { WriteScope } from './write-scope'

const WRITER = 'session-a'

const scope = (o: {
  inFlight?: boolean
  touched?: string[]
  reflow?: string[]
}): WriteScope => ({
  enter: () => Promise.resolve(() => undefined),
  exit: () => undefined,
  inFlight: () => o.inFlight ?? false,
  claim: () => undefined,
  writersOf: id =>
    new Set((o.touched ?? []).includes(id) ? [WRITER] : []),
  reflowWritersOf: id =>
    new Set((o.reflow ?? []).includes(id) ? [WRITER] : []),
})

const propChange = (
  id: string,
  properties: string[],
  node: Record<string, unknown> = {},
) => ({
  type: 'PROPERTY_CHANGE',
  node: { id, type: 'FRAME', name: 'Card', ...node },
  properties,
})

const mine: ReadonlySet<string> = new Set([WRITER])

describe('SelfWriteAttributor', () => {
  it('STAMPS a deferred self-write rather than dropping it', () => {
    // The drop moved LAYERS with the wire cut. One plugin serves every session
    // on the file and one frame is broadcast to all of them, so a drop taken
    // here is a drop taken for readers whose answer is different — and their
    // `pending_edits: 0` would then mean "the snapshot is good" over a file
    // somebody else just changed.
    //
    // What must NOT change is the membership question: it is asked at EVENT
    // time and answered from what the scope retains THEN. Nothing in it refers
    // to when the event was delivered.
    const f = createSelfWriteAttributor(
      scope({ inFlight: false, touched: ['n1'] }),
    )
    const rec = f.admit(propChange('n1', ['x']))
    expect(rec?.op).toBe('update')
    expect(rec?.by).toEqual(mine)
  })

  it('leaves a user edit on an untouched node UNATTRIBUTED', () => {
    // Absent means unattributed, and unattributed means EVERYBODY keeps it.
    const f = createSelfWriteAttributor(
      scope({ inFlight: false, touched: ['n1'] }),
    )
    const rec = f.admit(propChange('n2', ['x']))
    expect(rec?.op).toBe('update')
    expect(rec?.by).toBeUndefined()
    expect(rec?.rf).toBeUndefined()
  })

  it('stamps the WHOLE record on membership — no per-property attribution', () => {
    const f = createSelfWriteAttributor(
      scope({ touched: ['n1'] }),
    )
    const rec = f.admit(propChange('n1', ['x', 'name']))
    expect(rec?.props).toEqual(['name', 'x'])
    expect(rec?.by).toEqual(mine)
  })

  it('stamps `rf` for a reflow member and NEVER subtracts here', () => {
    // The subtraction is per CONSUMER now: `props` is complete and
    // unconditional on the wire, and the server removes CASCADE_PROPS against
    // its OWN closure. A cascade is noise to the session that caused it and
    // NEWS to a session that did not — a global subtraction here would destroy
    // that for every consumer at once.
    const f = createSelfWriteAttributor(
      scope({ reflow: ['n2'] }),
    )
    const rec = f.admit(
      propChange('n2', ['x', 'y', 'name']),
    )
    expect(rec?.props).toEqual(['name', 'x', 'y'])
    expect(rec?.rf).toEqual(mine)
    expect(rec?.by).toBeUndefined()
  })

  it('stamps a record that is in BOTH masks, read independently', () => {
    const f = createSelfWriteAttributor(
      scope({ touched: ['n2'], reflow: ['n2'] }),
    )
    const rec = f.admit(propChange('n2', ['x']))
    expect(rec?.by).toEqual(mine)
    expect(rec?.rf).toEqual(mine)
  })

  it('stamps a create/delete of a reflow member too', () => {
    const f = createSelfWriteAttributor(
      scope({ reflow: ['n2'] }),
    )
    const rec = f.admit({
      type: 'DELETE',
      node: { id: 'n2', type: 'TEXT', removed: true },
    })
    expect(rec?.op).toBe('delete')
    expect(rec?.rf).toEqual(mine)
  })

  it('omits name on delete (RemovedNode has none)', () => {
    const f = createSelfWriteAttributor(scope({}))
    const rec = f.admit({
      type: 'DELETE',
      node: { id: 'n9', type: 'TEXT', removed: true },
    })
    expect(rec?.name).toBeUndefined()
    expect(rec?.type).toBe('TEXT')
  })

  // @figma/plugin-typings declares `node: SceneNode | RemovedNode` on EVERY
  // BaseNodeChange, not only DeleteChange — documentchange is BATCHED, so a
  // node created-or-edited and then deleted inside one batch window arrives as
  // a CREATE / PROPERTY_CHANGE whose node is already removed. A removed node
  // exposes only `removed` / `type` / `id` and THROWS on anything else. The
  // sandbox listener guards PER CHANGE, so a throw here costs one record
  // rather than the batch's tail — but a record silently lost is a user edit
  // the agent never hears about, which is the failure this feature exists to
  // prevent. The attributor must not throw in the first place.
  const removedNode = (id: string, type: string): unknown =>
    new Proxy(
      { removed: true, type, id } as Record<
        string,
        unknown
      >,
      {
        get(t, k) {
          if (
            k === 'removed' ||
            k === 'type' ||
            k === 'id'
          ) {
            return t[k as string]
          }
          throw new Error(
            `Cannot read "${String(k)}" of a removed node`,
          )
        },
      },
    )

  it.each(['CREATE', 'PROPERTY_CHANGE', 'DELETE'])(
    'does not throw on %s whose node is already removed',
    type => {
      const f = createSelfWriteAttributor(scope({}))
      let rec: unknown
      expect(() => {
        rec = f.admit({
          type,
          id: 'n7',
          node: removedNode('n7', 'FRAME'),
          properties: ['x'],
        })
      }).not.toThrow()
      expect((rec as { id?: string } | null)?.id).toBe('n7')
      // No name is recoverable from a removed node, so none is claimed.
      expect(
        (rec as { name?: string } | null)?.name,
      ).toBeUndefined()
    },
  )

  it('maps STYLE_* subtypes to style ops', () => {
    const f = createSelfWriteAttributor(scope({}))
    expect(
      f.admit({
        type: 'STYLE_PROPERTY_CHANGE',
        style: { id: 'S:1', type: 'PAINT', name: 'Brand' },
        properties: ['paint'],
      })?.op,
    ).toBe('style_update')
  })

  it('NEVER stamps `rf` on a style record — rf is node-only', () => {
    // Synthetic: no real StyleChangeProperty is a cascade property, and the
    // reflow set holds node ids. This locks the node-only guard, which is what
    // keeps the server's cascade row off style records entirely.
    const f = createSelfWriteAttributor(
      scope({ reflow: ['S:1'] }),
    )
    const rec = f.admit({
      type: 'STYLE_PROPERTY_CHANGE',
      style: { id: 'S:1', type: 'PAINT', name: 'Brand' },
      properties: ['x'],
    })
    expect(rec?.props).toEqual(['x'])
    expect(rec?.rf).toBeUndefined()
  })

  it('rejects a change that is not a DocumentChange', () => {
    const f = createSelfWriteAttributor(scope({}))
    expect(f.admit(null)).toBe(null)
    expect(f.admit('PROPERTY_CHANGE')).toBe(null)
    expect(f.admit({ type: 42, id: 'n1' })).toBe(null)
    // Inherited Object.prototype keys are not change types.
    expect(f.admit({ type: 'constructor', id: 'n1' })).toBe(
      null,
    )
  })

  it('sorts and dedupes props', () => {
    const f = createSelfWriteAttributor(scope({}))
    expect(
      f.admit(propChange('n1', ['name', 'x', 'name']))
        ?.props,
    ).toEqual(['name', 'x'])
  })

  // A style's id is NOT the same string in the command result and in the
  // documentchange event: the result's trailing segment is empty
  // (`S:<key>,`) while the event carries the page id (`S:<key>,1:8`).
  // Matching the whole string never succeeds, so every agent-created style
  // leaked into the feed as a user edit (POC finding F1). The fix survives the
  // rename: matching now decides which WRITER a record names rather than
  // whether it is dropped, but it is the same match.
  describe('style identity is the key, not the whole id', () => {
    const styleChange = (id: string) => ({
      type: 'STYLE_CREATE',
      style: { id, type: 'PAINT', name: 'brand/primary' },
    })
    const KEY = 'f6688a30b6045f2b39ecfd4a34afe04b0d154955'

    it('attributes an agent style whose event id carries a page suffix', () => {
      const f = createSelfWriteAttributor(
        scope({ touched: [`S:${KEY},`] }),
      )
      expect(
        f.admit(styleChange(`S:${KEY},1:8`))?.by,
      ).toEqual(mine)
    })

    it('attributes it when the touched entry has no trailing comma either', () => {
      const f = createSelfWriteAttributor(
        scope({ touched: [`S:${KEY}`] }),
      )
      expect(
        f.admit(styleChange(`S:${KEY},1:8`))?.by,
      ).toEqual(mine)
    })

    it('does NOT attribute a DIFFERENT style key', () => {
      const f = createSelfWriteAttributor(
        scope({ touched: [`S:${KEY},`] }),
      )
      const rec = f.admit(
        styleChange(
          'S:0000000000000000000000000000000000000000,1:8',
        ),
      )
      expect(rec?.op).toBe('style_create')
      expect(rec?.by).toBeUndefined()
    })

    it('leaves NODE ids matching exactly — no key normalisation', () => {
      const f = createSelfWriteAttributor(
        scope({ touched: ['1:8'] }),
      )
      // A node id must not be truncated at a comma or matched by prefix.
      const rec = f.admit(propChange('1:80', ['x']))
      expect(rec?.op).toBe('update')
      expect(rec?.by).toBeUndefined()
    })
  })

  // A record that NAMES `x` as changed poses a question; one that says
  // `x = 20` answers one. The values ride the record the change already
  // carries, read off the node the event handed over.
  describe('values', () => {
    it('carries the final value of each changed property', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit(
        propChange('n1', ['x', 'y'], { x: 20, y: 40 }),
      )
      expect(rec?.props).toEqual(['x', 'y'])
      expect(rec?.set).toEqual({ x: 20, y: 40 })
    })

    it('keeps `set` a SUBSET of `props`', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit(
        propChange('n2', ['name'], {
          x: 20,
          name: 'Card',
        }),
      )
      expect(rec?.props).toEqual(['name'])
      expect(rec?.set).toEqual({ name: 'Card' })
    })

    it('carries NO set on a create — its final value is a whole node spec', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit({
        type: 'CREATE',
        node: {
          id: 'n1',
          type: 'FRAME',
          name: 'Card',
          x: 1,
        },
      })
      expect(rec?.op).toBe('create')
      expect(rec?.set).toBeUndefined()
      expect(rec?.props).toBeUndefined()
    })

    it('carries NO set on a delete — a delete has no value to report', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit({
        type: 'DELETE',
        node: { id: 'n1', type: 'FRAME', removed: true },
      })
      expect(rec?.set).toBeUndefined()
    })

    it('carries values on a style_update too', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit({
        type: 'STYLE_PROPERTY_CHANGE',
        style: { id: 'S:1', type: 'PAINT', name: 'Brand' },
        properties: ['name'],
      })
      expect(rec?.set).toEqual({ name: 'Brand' })
    })

    it('omits `set` entirely when nothing could be read', () => {
      // Names-only is the fallback the whole values design fails toward, and
      // an empty `set` would be wire cost carrying no answer.
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit({
        type: 'PROPERTY_CHANGE',
        node: removedNode('n7', 'FRAME'),
        id: 'n7',
        properties: ['x'],
      })
      expect(rec?.props).toEqual(['x'])
      expect(rec?.set).toBeUndefined()
    })
  })

  describe('the locator', () => {
    const located = (
      id: string,
      properties: string[] = ['x'],
    ) => {
      const page = { id: '0:1', type: 'PAGE', parent: null }
      const frame = {
        id: '1:1',
        type: 'FRAME',
        parent: page,
      }
      return {
        type: 'PROPERTY_CHANGE',
        node: {
          id,
          type: 'TEXT',
          name: 'Label',
          parent: frame,
          x: 3,
        },
        properties,
      }
    }

    it('names the page and the frame a node record sits under', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit(located('1:9'))
      expect(rec?.pg).toBe('0:1')
      expect(rec?.fr).toBe('1:1')
    })

    it('never locates a DELETE — a RemovedNode has no parent', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit({
        type: 'DELETE',
        node: { id: 'n1', type: 'TEXT', removed: true },
      })
      expect(rec?.pg).toBeUndefined()
      expect(rec?.fr).toBeUndefined()
    })

    it('never locates a STYLE — a style has no place in the node tree', () => {
      const f = createSelfWriteAttributor(scope({}))
      const rec = f.admit({
        type: 'STYLE_PROPERTY_CHANGE',
        style: { id: 'S:1', type: 'PAINT', name: 'Brand' },
        properties: ['name'],
      })
      expect(rec?.pg).toBeUndefined()
      expect(rec?.fr).toBeUndefined()
    })

    it('walks once per id per FLUSH WINDOW, and resetWindow clears the memo', () => {
      // The walk is per-record cost inside the synchronous handler, and a
      // forty-tick drag is forty records for one id.
      let walks = 0
      const page = { id: '0:1', type: 'PAGE', parent: null }
      const frame = {
        id: '1:1',
        type: 'FRAME',
        parent: page,
      }
      const change = (): unknown => ({
        type: 'PROPERTY_CHANGE',
        properties: ['x'],
        node: {
          id: '1:9',
          type: 'TEXT',
          name: 'Label',
          x: 1,
          get parent() {
            walks += 1
            return frame
          },
        },
      })
      const f = createSelfWriteAttributor(scope({}))
      expect(f.admit(change())?.fr).toBe('1:1')
      expect(f.admit(change())?.fr).toBe('1:1')
      expect(walks).toBe(1)
      f.resetWindow()
      expect(f.admit(change())?.fr).toBe('1:1')
      expect(walks).toBe(2)
    })
  })

  describe('admitContext', () => {
    // Factories: a shared record would carry one test's stamp into the next.
    const pageRec = () => ({
      op: 'page' as const,
      id: '0:1',
    })
    const selectRec = () => ({
      op: 'select' as const,
      ids: ['1:1', '1:2'],
    })

    it('drops BOTH slots while a dispatch is in flight', () => {
      const f = createSelfWriteAttributor(
        scope({ inFlight: true }),
      )
      expect(f.admitContext(pageRec())).toBe(null)
      expect(f.admitContext(selectRec())).toBe(null)
    })

    it('STAMPS a page record whose id the agent touched', () => {
      // set_current_page's pageId is harvested like any other id. Delivery is
      // deferred, so the in-flight flag alone would let the agent's own page
      // switch back in as "the user just switched page" (T7) — but the drop is
      // the consumer's: the session that navigated discards its own at ingest
      // while the OTHERS learn that the page changed under them.
      const f = createSelfWriteAttributor(
        scope({ touched: ['0:1'] }),
      )
      expect(f.admitContext(pageRec())?.by).toEqual(mine)
    })

    it('leaves a page record the agent did not navigate to unattributed', () => {
      const f = createSelfWriteAttributor(
        scope({ touched: ['0:9'] }),
      )
      expect(f.admitContext(pageRec())?.by).toBeUndefined()
    })

    it('a select record carries NEITHER mask, even when every id is touched', () => {
      // A `select` carries NO id, and its `ids` are the CURRENT selection
      // rather than an identity — testing them against membership would drop
      // the user's selection of the very nodes the agent just built, the most
      // likely thing a user selects and exactly what the slot exists to
      // report.
      const f = createSelfWriteAttributor(
        scope({ touched: ['1:1', '1:2'] }),
      )
      const rec = f.admitContext(selectRec())
      expect(rec).not.toBe(null)
      expect(rec?.by).toBeUndefined()
      expect(rec?.rf).toBeUndefined()
    })
  })
})

// The unit-level twin of "a user edit after hand-over is unattributed" — an
// empty fake scope — does not prove the eviction ran. These drive the real
// scope.
describe('SelfWriteAttributor over a real WriteScope', () => {
  const build = (retentionCeilingMs: number) => {
    const c = { t: 0 }
    const s = createWriteScope({
      resolve: () => Promise.resolve(null),
      now: () => c.t,
      retentionCeilingMs,
    })
    return {
      c,
      s,
      f: createSelfWriteAttributor(s),
    }
  }

  it('still attributes a write whose event lands 60 s after exit', async () => {
    // 150x the retired SETTLE_MS. The POC measured deliveries at 395 /
    // 1121 / 1239 / 1910 / 2435 / 3907 ms after exit, and once at 49.2 s.
    // Retention is keyed on the COMMAND, not on the clock: nothing here may
    // reintroduce a wall-clock dependence.
    const { c, s, f } = build(5 * 60_000)
    const done = await s.enter(
      WRITER,
      COMMANDS.UPDATE_NODE,
      { nodeId: 'n1' },
    )
    done(null)
    c.t = 60_000
    expect(f.admit(propChange('n1', ['x']))?.by).toEqual(
      mine,
    )
  })

  it('releases the node once the agent has handed over', async () => {
    const { c, s, f } = build(1000)
    const done = await s.enter(
      WRITER,
      COMMANDS.UPDATE_NODE,
      { nodeId: 'n1' },
    )
    done(null)
    c.t = 999
    expect(f.admit(propChange('n1', ['x']))?.by).toEqual(
      mine,
    )
    c.t = 1000
    const rec = f.admit(propChange('n1', ['x']))
    expect(rec?.op).toBe('update')
    expect(rec?.by).toBeUndefined()
  })

  it('releases a style the same way', async () => {
    const KEY = 'f6688a30b6045f2b39ecfd4a34afe04b0d154955'
    const styleChange = {
      type: 'STYLE_CREATE',
      style: {
        id: `S:${KEY},1:8`,
        type: 'PAINT',
        name: 'brand/primary',
      },
    }
    const { c, s, f } = build(1000)
    const done = await s.enter(
      WRITER,
      COMMANDS.CREATE_STYLES,
      {},
    )
    done({ ids: [`S:${KEY},`] })
    expect(f.admit(styleChange)?.by).toEqual(mine)
    c.t = 1000
    expect(f.admit(styleChange)?.by).toBeUndefined()
  })

  it('stamps the agent OWN page switch, deferred, then releases it', async () => {
    const { c, s, f } = build(1000)
    const done = await s.enter(
      WRITER,
      COMMANDS.SET_CURRENT_PAGE,
      { pageId: '0:1' },
    )
    done(null)
    const rec = { op: 'page' as const, id: '0:1' }
    expect(s.inFlight()).toBe(false)
    expect(f.admitContext({ ...rec })?.by).toEqual(mine)
    c.t = 1000
    expect(f.admitContext({ ...rec })?.by).toBeUndefined()
  })

  it('a page switch does NOT put the page CONTENTS into the reflow mask', async () => {
    // The page id must reach `writersOf` (so the agent's own switch is not
    // reported back to it as the user's) but must NOT drag the page's contents
    // into the closure: a top-level frame's PROPERTY_CHANGE carries only
    // cascade props, so a page-wide closure would let the server subtract them
    // to empty and drop the single commonest user action in silence — for up
    // to RETAINED_COMMANDS dispatches or RETENTION_CEILING_MS of idle.
    const c = { t: 0 }
    const page = {
      id: '0:1',
      type: 'PAGE',
      parent: null,
      children: [
        { id: '1:1', parent: null, children: [] },
        { id: '1:2', parent: null, children: [] },
      ],
    }
    const s = createWriteScope({
      resolve: id =>
        Promise.resolve(
          id === '0:1'
            ? (page as unknown as SceneNode)
            : null,
        ),
      now: () => c.t,
    })
    const f = createSelfWriteAttributor(s)
    const done = await s.enter(
      WRITER,
      COMMANDS.SET_CURRENT_PAGE,
      { pageId: '0:1' },
    )
    done(null)
    expect(
      f.admitContext({ op: 'page', id: '0:1' })?.by,
    ).toEqual(mine)
    // …and the user's drag of a top-level frame is unattributed on BOTH masks,
    // so no consumer subtracts anything from it.
    const drag = f.admit(propChange('1:1', ['x', 'y']))
    expect(drag?.props).toEqual(['x', 'y'])
    expect(drag?.by).toBeUndefined()
    expect(drag?.rf).toBeUndefined()
  })

  it('a READ never attributes the user edits it merely looked at', async () => {
    // `search` returns hundreds of ids; harvesting them would put most of the
    // document into that session's mask and let its own server drop the user's
    // real edits wholesale — silence, the direction the design refuses.
    const { s, f } = build(1000)
    const done = await s.enter(WRITER, COMMANDS.SEARCH, {})
    done({ results: [{ id: 'n1' }, { id: 'n2' }] })
    expect(
      f.admit(propChange('n1', ['x']))?.by,
    ).toBeUndefined()
  })

  it('BOTH creation claim sites contribute, and only the post-append one carries the closure', async () => {
    // At creation the node has no parent, so its closure is EMPTY; the closure
    // only becomes reachable post-append. Neither call replaces the other: the
    // pre-append claim exists for the path where the append throws and the node
    // is removed again — Figma still emits CREATE + DELETE for it.
    const c = { t: 0 }
    const page = {
      id: '0:1',
      type: 'PAGE',
      parent: null,
      children: [],
    }
    const orphan = {
      id: '1:5',
      type: 'FRAME',
      parent: null,
      children: [],
    }
    const s = createWriteScope({
      resolve: () => Promise.resolve(null),
      now: () => c.t,
    })
    const f = createSelfWriteAttributor(s)
    await s.enter(WRITER, COMMANDS.CREATE_NODE, {})

    // Pre-append: the TOUCHED half only.
    s.claim(WRITER, orphan as unknown as SceneNode)
    expect(f.admit(propChange('1:5', ['x']))?.by).toEqual(
      mine,
    )
    expect(
      f.admit(propChange('1:5', ['x']))?.rf,
    ).toBeUndefined()

    // Post-append, in an auto-layout parent: now the closure is the real one.
    const sibling = {
      id: '1:7',
      parent: null,
      children: [],
    }
    const stack = {
      id: '1:9',
      type: 'FRAME',
      layoutMode: 'VERTICAL',
      layoutSizingVertical: 'FIXED',
      parent: page,
      children: [orphan, sibling],
    }
    orphan.parent = stack as never
    s.claim(WRITER, orphan as unknown as SceneNode)
    // The SIBLING an agent write can move without naming it.
    expect(f.admit(propChange('1:7', ['y']))?.rf).toEqual(
      mine,
    )
  })
})
