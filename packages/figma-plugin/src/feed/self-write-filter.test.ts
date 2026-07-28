import { describe, it, expect } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import { createSelfWriteFilter } from './self-write-filter'
import { createWriteScope } from './write-scope'
import type { WriteScope } from './write-scope'

const scope = (o: {
  inFlight?: boolean
  touched?: string[]
  reflow?: string[]
}): WriteScope => ({
  enter: () => Promise.resolve(() => undefined),
  exit: () => undefined,
  inFlight: () => o.inFlight ?? false,
  claim: () => undefined,
  touched: () => new Set(o.touched ?? []),
  reflow: () => new Set(o.reflow ?? []),
})

const propChange = (id: string, properties: string[]) => ({
  type: 'PROPERTY_CHANGE',
  node: { id, type: 'FRAME', name: 'Card' },
  properties,
})

describe('SelfWriteFilter', () => {
  it('suppresses a DEFERRED self-write — no dispatch in flight', () => {
    // The headline fix. `documentchange` delivery is unbounded, so the event
    // for the agent's own write routinely lands long after its command
    // exited. Membership decides ALONE: nothing in the question refers to
    // when the event was delivered. The old rule asked `isOpen()` first and
    // therefore admitted exactly this case — the agent's work reported back
    // to itself as the user's.
    const f = createSelfWriteFilter(
      scope({ inFlight: false, touched: ['n1'] }),
    )
    expect(f.admit(propChange('n1', ['x']))).toBe(null)
  })

  it('keeps a user edit on a node the agent never touched', () => {
    const f = createSelfWriteFilter(
      scope({ inFlight: false, touched: ['n1'] }),
    )
    expect(f.admit(propChange('n2', ['x']))?.op).toBe(
      'update',
    )
  })

  it('drops a touched id whole, with no per-property attribution', () => {
    const f = createSelfWriteFilter(
      scope({ touched: ['n1'] }),
    )
    expect(f.admit(propChange('n1', ['x', 'name']))).toBe(
      null,
    )
  })

  it('SUBTRACTS cascade props for a reflow member and keeps the rest', () => {
    const f = createSelfWriteFilter(
      scope({ reflow: ['n2'] }),
    )
    const rec = f.admit(
      propChange('n2', ['x', 'y', 'name']),
    )
    expect(rec?.props).toEqual(['name'])
  })

  it('drops a reflow member whose props are ALL cascade', () => {
    const f = createSelfWriteFilter(
      scope({ reflow: ['n2'] }),
    )
    expect(f.admit(propChange('n2', ['x', 'height']))).toBe(
      null,
    )
  })

  it('KEEPS a create/delete of a reflow member', () => {
    const f = createSelfWriteFilter(
      scope({ reflow: ['n2'] }),
    )
    expect(
      f.admit({
        type: 'DELETE',
        node: { id: 'n2', type: 'TEXT', removed: true },
      })?.op,
    ).toBe('delete')
  })

  it('omits name on delete (RemovedNode has none)', () => {
    const f = createSelfWriteFilter(scope({}))
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
  // prevent. The filter must not throw in the first place.
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
      const f = createSelfWriteFilter(scope({}))
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
    const f = createSelfWriteFilter(scope({}))
    expect(
      f.admit({
        type: 'STYLE_PROPERTY_CHANGE',
        style: { id: 'S:1', type: 'PAINT', name: 'Brand' },
        properties: ['paint'],
      })?.op,
    ).toBe('style_update')
  })

  it('NEVER subtracts cascade props from a style record', () => {
    // Synthetic: no real StyleChangeProperty is in CASCADE_PROPS, and the
    // reflow set holds node ids. This locks the `op === 'update'` conjunct in
    // the subtraction guard — the only thing scoping the reflow rule to nodes.
    const f = createSelfWriteFilter(
      scope({ reflow: ['S:1'] }),
    )
    expect(
      f.admit({
        type: 'STYLE_PROPERTY_CHANGE',
        style: { id: 'S:1', type: 'PAINT', name: 'Brand' },
        properties: ['x'],
      })?.props,
    ).toEqual(['x'])
  })

  it('rejects a change that is not a DocumentChange', () => {
    const f = createSelfWriteFilter(scope({}))
    expect(f.admit(null)).toBe(null)
    expect(f.admit('PROPERTY_CHANGE')).toBe(null)
    expect(f.admit({ type: 42, id: 'n1' })).toBe(null)
    // Inherited Object.prototype keys are not change types.
    expect(f.admit({ type: 'constructor', id: 'n1' })).toBe(
      null,
    )
  })

  it('sorts and dedupes props', () => {
    const f = createSelfWriteFilter(scope({}))
    expect(
      f.admit(propChange('n1', ['name', 'x', 'name']))
        ?.props,
    ).toEqual(['name', 'x'])
  })

  // A style's id is NOT the same string in the command result and in the
  // documentchange event: the result's trailing segment is empty
  // (`S:<key>,`) while the event carries the page id (`S:<key>,1:8`).
  // Matching the whole string never succeeds, so every agent-created style
  // leaked into the feed as a user edit (POC finding F1).
  describe('style identity is the key, not the whole id', () => {
    const styleChange = (id: string) => ({
      type: 'STYLE_CREATE',
      style: { id, type: 'PAINT', name: 'brand/primary' },
    })
    const KEY = 'f6688a30b6045f2b39ecfd4a34afe04b0d154955'

    it('drops an agent style whose event id carries a page suffix', () => {
      const f = createSelfWriteFilter(
        scope({ touched: [`S:${KEY},`] }),
      )
      expect(f.admit(styleChange(`S:${KEY},1:8`))).toBe(
        null,
      )
    })

    it('drops it when the touched entry has no trailing comma either', () => {
      const f = createSelfWriteFilter(
        scope({ touched: [`S:${KEY}`] }),
      )
      expect(f.admit(styleChange(`S:${KEY},1:8`))).toBe(
        null,
      )
    })

    it('does NOT drop a DIFFERENT style key', () => {
      const f = createSelfWriteFilter(
        scope({ touched: [`S:${KEY},`] }),
      )
      expect(
        f.admit(
          styleChange(
            'S:0000000000000000000000000000000000000000,1:8',
          ),
        )?.op,
      ).toBe('style_create')
    })

    it('leaves NODE ids matching exactly — no key normalisation', () => {
      const f = createSelfWriteFilter(
        scope({ touched: ['1:8'] }),
      )
      // A node id must not be truncated at a comma or matched by prefix.
      expect(f.admit(propChange('1:80', ['x']))?.op).toBe(
        'update',
      )
    })
  })

  describe('admitContext', () => {
    const pageRec = { op: 'page' as const, id: '0:1' }
    const selectRec = {
      op: 'select' as const,
      ids: ['1:1', '1:2'],
    }

    it('drops BOTH slots while a dispatch is in flight', () => {
      const f = createSelfWriteFilter(
        scope({ inFlight: true }),
      )
      expect(f.admitContext(pageRec)).toBe(false)
      expect(f.admitContext(selectRec)).toBe(false)
    })

    it('drops a page record whose id the agent touched', () => {
      // set_current_page's pageId is harvested like any other id. Delivery
      // is deferred, so the in-flight flag alone would let the agent's own
      // page switch back in as "the user just switched page" (T7).
      const f = createSelfWriteFilter(
        scope({ touched: ['0:1'] }),
      )
      expect(f.admitContext(pageRec)).toBe(false)
    })

    it('keeps a page record the agent did not navigate to', () => {
      const f = createSelfWriteFilter(
        scope({ touched: ['0:9'] }),
      )
      expect(f.admitContext(pageRec)).toBe(true)
    })

    it('keeps a select record even when every id is touched', () => {
      // A `select` carries NO id, and its `ids` are the CURRENT selection
      // rather than an identity — testing them against touched() would drop
      // the user's selection of the very nodes the agent just built, the
      // most likely thing a user selects and exactly what the slot exists to
      // report.
      const f = createSelfWriteFilter(
        scope({ touched: ['1:1', '1:2'] }),
      )
      expect(f.admitContext(selectRec)).toBe(true)
    })
  })
})

// The unit-level twin of "a user edit after hand-over is kept" — an empty
// fake scope — does not prove the eviction ran. These drive the real scope.
describe('SelfWriteFilter over a real WriteScope', () => {
  const build = (retentionCeilingMs: number) => {
    const c = { t: 0 }
    const s = createWriteScope({
      resolve: () => Promise.resolve(null),
      now: () => c.t,
      retentionCeilingMs,
    })
    return { c, s, f: createSelfWriteFilter(s) }
  }

  it('still suppresses a write whose event lands 60 s after exit', async () => {
    // 150x the retired SETTLE_MS. The POC measured deliveries at 395 /
    // 1121 / 1239 / 1910 / 2435 / 3907 ms after exit, and once at 49.2 s.
    const { c, s, f } = build(5 * 60_000)
    const done = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'n1',
    })
    done(null)
    c.t = 60_000
    expect(f.admit(propChange('n1', ['x']))).toBe(null)
  })

  it('releases the node once the agent has handed over', async () => {
    const { c, s, f } = build(1000)
    const done = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'n1',
    })
    done(null)
    c.t = 999
    expect(f.admit(propChange('n1', ['x']))).toBe(null)
    c.t = 1000
    expect(f.admit(propChange('n1', ['x']))?.op).toBe(
      'update',
    )
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
    const done = await s.enter(COMMANDS.CREATE_STYLES, {})
    done({ ids: [`S:${KEY},`] })
    expect(f.admit(styleChange)).toBe(null)
    c.t = 1000
    expect(f.admit(styleChange)?.op).toBe('style_create')
  })

  it('drops the agent OWN page switch, deferred, then releases it', async () => {
    const { c, s, f } = build(1000)
    const done = await s.enter(COMMANDS.SET_CURRENT_PAGE, {
      pageId: '0:1',
    })
    done(null)
    const rec = { op: 'page' as const, id: '0:1' }
    expect(s.inFlight()).toBe(false)
    expect(f.admitContext(rec)).toBe(false)
    c.t = 1000
    expect(f.admitContext(rec)).toBe(true)
  })

  it('a page switch does NOT silence the user dragging a frame on that page', async () => {
    // The page id must reach touched() (so the agent's own switch is not
    // reported as the user's) but must NOT drag the page's contents into
    // reflow(): a top-level frame's PROPERTY_CHANGE carries only cascade
    // props, so a page-wide closure would subtract them to empty and drop
    // the single commonest user action in silence — for up to
    // RETAINED_COMMANDS dispatches or RETENTION_CEILING_MS of idle.
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
    const f = createSelfWriteFilter(s)
    const done = await s.enter(COMMANDS.SET_CURRENT_PAGE, {
      pageId: '0:1',
    })
    done(null)
    expect(f.admitContext({ op: 'page', id: '0:1' })).toBe(
      false,
    )
    // …and the user's drag of a top-level frame survives.
    expect(
      f.admit(propChange('1:1', ['x', 'y']))?.props,
    ).toEqual(['x', 'y'])
  })

  it('a READ never suppresses the user edits it merely looked at', async () => {
    // `search` returns hundreds of ids; harvesting them would put most of
    // the document into touched() for minutes and drop the user's real edits
    // wholesale — silence, the direction the design refuses.
    const { s, f } = build(1000)
    const done = await s.enter(COMMANDS.SEARCH, {})
    done({ results: [{ id: 'n1' }, { id: 'n2' }] })
    expect(f.admit(propChange('n1', ['x']))?.op).toBe(
      'update',
    )
  })
})
