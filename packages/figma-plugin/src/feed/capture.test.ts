import { describe, it, expect } from 'bun:test'
import { VALUE_MAX_BYTES } from '@figma-agent-bridge/shared/change-feed'
import { captureValues, captureLocator } from './capture'

// The two pieces that touch the Figma runtime from INSIDE the synchronous
// documentchange handler. Both read the node the change handed over — property
// access, never an id resolution — and both fail toward the names-only record.

type Bag = Record<string, unknown>

/** A node whose named properties throw on read, the way a node on a page the
 *  runtime has not loaded does. */
const withThrowing = (base: Bag, throwing: string[]): Bag =>
  new Proxy(base, {
    get(t, k) {
      if (throwing.includes(String(k))) {
        throw new Error(`cannot read ${String(k)}`)
      }
      return t[k as string]
    },
  })

describe('captureValues', () => {
  it('reads the FINAL value of each changed property from the node in hand', () => {
    expect(
      captureValues({ x: 20, y: 40, name: 'Card' }, [
        'x',
        'y',
      ]),
    ).toEqual({ x: 20, y: 40 })
  })

  it('reads ONLY the changed properties', () => {
    const seen: string[] = []
    const node = new Proxy({ x: 1, y: 2 } as Bag, {
      get(t, k) {
        seen.push(String(k))
        return t[k as string]
      },
    })
    captureValues(node, ['x'])
    expect(seen).toEqual(['x'])
  })

  it('a throwing property yields no entry, and costs the others nothing', () => {
    // The record keeps `props` and loses only the value: reading fails toward
    // the names-only record, never toward an exception in the handler.
    const node = withThrowing({ x: 20, name: 'Card' }, [
      'name',
    ])
    let out: unknown
    expect(() => {
      out = captureValues(node, ['name', 'x'])
    }).not.toThrow()
    expect(out).toEqual({ x: 20 })
  })

  it('omits a value over VALUE_MAX_BYTES and keeps its cheap neighbours', () => {
    expect(
      captureValues(
        {
          characters: 'x'.repeat(VALUE_MAX_BYTES + 1),
          fontSize: 12,
        },
        ['characters', 'fontSize'],
      ),
    ).toEqual({ fontSize: 12 })
  })

  it('spends RECORD_VALUE_BUDGET cheapest-first, so the most properties fit', () => {
    // Ascending serialized size: the budget is spent on the many small values
    // rather than on one large one.
    const big = 'y'.repeat(VALUE_MAX_BYTES - 10)
    const node: Bag = {
      a: 1,
      b: 2,
      c: 3,
      d: big,
      e: big,
      f: big,
      g: big,
      h: big,
    }
    const out = captureValues(node, [
      'h',
      'g',
      'f',
      'e',
      'd',
      'c',
      'b',
      'a',
    ]) as Bag
    // The three cheap ones are never crowded out by the five expensive ones,
    // whatever order the runtime listed them in.
    expect(out.a).toBe(1)
    expect(out.b).toBe(2)
    expect(out.c).toBe(3)
    // RECORD_VALUE_BUDGET is 4 x VALUE_MAX_BYTES, so four of the five big
    // ones fit and the fifth — last by the name tie-break — does not.
    expect('d' in out).toBe(true)
    expect('g' in out).toBe(true)
    expect('h' in out).toBe(false)
  })

  // `parent` and `prototypeStartNode` are NodeChangeProperty names whose value
  // is a NODE, and `parent` is exactly what a human's reorder inside an
  // auto-layout frame emits. A node measures at the two bytes of `{}` — the
  // cheapest measurement there is — so before the size test learned to refuse
  // it, it was carried FIRST and always: a fabricated `{}` on the wire at
  // best, and at worst a value `postMessage` cannot clone.
  it('never carries a NODE-VALUED property, however cheap it measures', () => {
    // Every property a PROTOTYPE ACCESSOR, the way a real node's are: no own
    // enumerable keys, so `JSON.stringify` renders it `{}`.
    const fakeNode = Object.create({
      get id() {
        return '1:2'
      },
      get parent() {
        return null
      },
      get type() {
        return 'FRAME'
      },
    }) as object
    const child = {
      parent: fakeNode,
      y: 40,
    } as unknown as Bag
    expect(captureValues(child, ['parent', 'y'])).toEqual({
      y: 40,
    })
    // …and when the node was the ONLY changed property, `set` is absent.
    expect(captureValues(child, ['parent'])).toBeUndefined()
  })

  it('is UNDEFINED when nothing survived — `set` is absent, never {}', () => {
    const node = withThrowing({ x: 1 }, ['x'])
    expect(captureValues(node, ['x'])).toBeUndefined()
    expect(captureValues({}, [])).toBeUndefined()
  })

  it('survives a node that throws on EVERY read', () => {
    const removed = new Proxy({} as Bag, {
      get() {
        throw new Error('node removed')
      },
    })
    expect(
      captureValues(removed, ['x', 'y']),
    ).toBeUndefined()
  })
})

// ── the locator ─────────────────────────────────────────────────────────────

type Fake = {
  id: string
  type?: string
  parent?: Fake | null
}

const chain = (...ids: string[]): Fake => {
  // ids[0] is the outermost. Returns the innermost node.
  let parent: Fake | null = null
  let node: Fake | null = null
  for (const id of ids) {
    node = {
      id,
      type: id === '0:1' ? 'PAGE' : 'FRAME',
      parent,
    }
    parent = node
  }
  return node as Fake
}

describe('captureLocator', () => {
  it('names the page and the ancestor that is a direct child of it', () => {
    const leaf = chain('0:1', '1:1', '1:2', '1:3')
    expect(captureLocator(leaf)).toEqual({
      pg: '0:1',
      fr: '1:1',
    })
  })

  it("is the node's OWN id when it IS a direct child of a page", () => {
    const frame = chain('0:1', '1:1')
    expect(captureLocator(frame)).toEqual({
      pg: '0:1',
      fr: '1:1',
    })
  })

  it('is EMPTY when the walk reaches no page', () => {
    // Absent rather than guessed: a locator is best-effort by contract.
    expect(captureLocator(chain('1:1', '1:2'))).toEqual({})
  })

  it('is EMPTY, and does not throw, when the parent walk throws', () => {
    const removed = {
      id: '1:1',
      get parent(): never {
        throw new Error('node removed')
      },
    }
    let out: unknown
    expect(() => {
      out = captureLocator(removed)
    }).not.toThrow()
    expect(out).toEqual({})
  })

  it('terminates on a cyclic parent chain', () => {
    const a: Fake = { id: '1:1', type: 'FRAME' }
    const b: Fake = { id: '1:2', type: 'FRAME', parent: a }
    a.parent = b
    expect(captureLocator(a)).toEqual({})
  })
})
