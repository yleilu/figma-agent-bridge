import { describe, it, expect } from 'bun:test'
import { createSelfWriteFilter } from './self-write-filter'
import type { WriteScope } from './write-scope'

const scope = (o: {
  open: boolean
  touched?: string[]
  reflow?: string[]
}): WriteScope => ({
  enter: () => Promise.resolve(() => undefined),
  exit: () => undefined,
  isOpen: () => o.open,
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
  it('keeps everything while the window is CLOSED', () => {
    const f = createSelfWriteFilter(
      scope({ open: false, touched: ['n1'] }),
    )
    expect(f.admit(propChange('n1', ['x']))?.op).toBe(
      'update',
    )
    expect(f.admitContext()).toBe(true)
  })

  it('drops a touched id whole, with no per-property attribution', () => {
    const f = createSelfWriteFilter(
      scope({ open: true, touched: ['n1'] }),
    )
    expect(f.admit(propChange('n1', ['x', 'name']))).toBe(
      null,
    )
  })

  it('SUBTRACTS cascade props for a reflow member and keeps the rest', () => {
    const f = createSelfWriteFilter(
      scope({ open: true, reflow: ['n2'] }),
    )
    const rec = f.admit(
      propChange('n2', ['x', 'y', 'name']),
    )
    expect(rec?.props).toEqual(['name'])
  })

  it('drops a reflow member whose props are ALL cascade', () => {
    const f = createSelfWriteFilter(
      scope({ open: true, reflow: ['n2'] }),
    )
    expect(f.admit(propChange('n2', ['x', 'height']))).toBe(
      null,
    )
  })

  it('KEEPS a create/delete of a reflow member', () => {
    const f = createSelfWriteFilter(
      scope({ open: true, reflow: ['n2'] }),
    )
    expect(
      f.admit({
        type: 'DELETE',
        node: { id: 'n2', type: 'TEXT', removed: true },
      })?.op,
    ).toBe('delete')
  })

  it('omits name on delete (RemovedNode has none)', () => {
    const f = createSelfWriteFilter(scope({ open: false }))
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
  // exposes only `removed` / `type` / `id` and THROWS on anything else; a throw
  // here would take the whole batch with it in production (Task 3's listener
  // has no try/catch) and, in the POC probe, silently delete the change from
  // the kept-count the gate is read from — a false PASS on the one criterion
  // that matters.
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
      const f = createSelfWriteFilter(
        scope({ open: false }),
      )
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
    const f = createSelfWriteFilter(scope({ open: false }))
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
      scope({ open: true, reflow: ['S:1'] }),
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
    const f = createSelfWriteFilter(scope({ open: false }))
    expect(f.admit(null)).toBe(null)
    expect(f.admit('PROPERTY_CHANGE')).toBe(null)
    expect(f.admit({ type: 42, id: 'n1' })).toBe(null)
    // Inherited Object.prototype keys are not change types.
    expect(f.admit({ type: 'constructor', id: 'n1' })).toBe(
      null,
    )
  })

  it('drops context events inside the window', () => {
    expect(
      createSelfWriteFilter(
        scope({ open: true }),
      ).admitContext(),
    ).toBe(false)
  })

  it('sorts and dedupes props', () => {
    const f = createSelfWriteFilter(scope({ open: false }))
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
        scope({ open: true, touched: [`S:${KEY},`] }),
      )
      expect(f.admit(styleChange(`S:${KEY},1:8`))).toBe(null)
    })

    it('drops it when the touched entry has no trailing comma either', () => {
      const f = createSelfWriteFilter(
        scope({ open: true, touched: [`S:${KEY}`] }),
      )
      expect(f.admit(styleChange(`S:${KEY},1:8`))).toBe(null)
    })

    it('does NOT drop a DIFFERENT style key', () => {
      const f = createSelfWriteFilter(
        scope({ open: true, touched: [`S:${KEY},`] }),
      )
      expect(
        f.admit(styleChange('S:0000000000000000000000000000000000000000,1:8'))
          ?.op,
      ).toBe('style_create')
    })

    it('keeps a user style edit while the window is closed', () => {
      const f = createSelfWriteFilter(
        scope({ open: false, touched: [`S:${KEY},`] }),
      )
      expect(f.admit(styleChange(`S:${KEY},1:8`))?.op).toBe(
        'style_create',
      )
    })

    it('leaves NODE ids matching exactly — no key normalisation', () => {
      const f = createSelfWriteFilter(
        scope({ open: true, touched: ['1:8'] }),
      )
      // A node id must not be truncated at a comma or matched by prefix.
      expect(f.admit(propChange('1:80', ['x']))?.op).toBe(
        'update',
      )
    })
  })
})
