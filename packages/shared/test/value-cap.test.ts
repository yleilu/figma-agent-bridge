import { describe, it, expect } from 'bun:test'
import {
  measureValue,
  pickValues,
} from '@figma-agent-bridge/shared/value-cap'
import {
  VALUE_MAX_BYTES,
  VALUE_MAX_ITEMS,
  RECORD_VALUE_BUDGET,
} from '@figma-agent-bridge/shared/change-feed'

// change-feed.md, "Values, and the cap that bounds them". The rule under test
// throughout: SIZE decides which values are carried, never the property NAME —
// a table of expensive property names would drift against the runtime, a byte
// count cannot.

/** An array whose ELEMENT reads are counted, so a test can prove the O(1)
 *  pre-check refused it before anything walked it. `length` reads are not
 *  counted: reading the length IS the pre-check. */
const countingArray = (
  length: number,
): { value: unknown[]; reads: () => number } => {
  let reads = 0
  const target = Array.from({ length }, (_, i) => i % 10)
  const value = new Proxy(target, {
    get(t, prop, recv) {
      if (
        typeof prop === 'string' &&
        /^[0-9]+$/.test(prop)
      ) {
        reads += 1
      }
      return Reflect.get(t, prop, recv)
    },
  })
  return { value, reads: () => reads }
}

/** A stand-in for a Figma node: every property is a PROTOTYPE ACCESSOR, so it
 *  has no own enumerable keys at all and `JSON.stringify` renders it `{}`. */
const fakeNode = (): object =>
  Object.create({
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

const jsonBytes = (v: unknown): number =>
  Buffer.byteLength(JSON.stringify(v), 'utf8')

describe('measureValue', () => {
  it('measures the JSON serialization of a value that fits', () => {
    expect(measureValue(20)).toBe(2)
    expect(measureValue(true)).toBe(4)
    expect(measureValue(null)).toBe(4)
    expect(measureValue('hi')).toBe(4)
  })

  it('agrees with JSON.stringify on a realistic paint', () => {
    const paint = {
      type: 'SOLID',
      color: { r: 0.1, g: 0.2, b: 0.3 },
      opacity: 1,
    }
    expect(measureValue(paint)).toBe(jsonBytes(paint))
  })

  it('agrees with JSON.stringify on an escaped / multi-byte string', () => {
    const s = 'a "b"\n\\cé中😀'
    expect(measureValue(s)).toBe(jsonBytes(s))
  })

  it('counts BYTES, not characters', () => {
    // 200 ASCII chars fit; the same COUNT of 3-byte characters does not.
    // A character-count cap would admit both and blow the byte budget.
    const ascii = 'a'.repeat(200)
    const cjk = '中'.repeat(200)
    expect(measureValue(ascii)).toBe(202)
    expect(jsonBytes(cjk)).toBeGreaterThan(VALUE_MAX_BYTES)
    expect(measureValue(cjk)).toBe(null)
  })

  it('refuses a long string on the O(1) pre-check', () => {
    expect(measureValue('x'.repeat(8 * 1024))).toBe(null)
  })

  it('refuses an over-long array WITHOUT reading a single element', () => {
    const { value, reads } = countingArray(
      VALUE_MAX_ITEMS + 1,
    )
    expect(measureValue(value)).toBe(null)
    expect(reads()).toBe(0)
  })

  it('refuses on VALUE_MAX_ITEMS even when the bytes would have fit', () => {
    // 60 single digits serialize to ~121 bytes — under the byte cap. Only the
    // item pre-check can refuse this, which is what makes it the discriminating
    // case: the cheapest measure of size is still a measure of size.
    const sixty = Array.from(
      { length: 60 },
      (_, i) => i % 10,
    )
    expect(jsonBytes(sixty)).toBeLessThan(VALUE_MAX_BYTES)
    expect(sixty.length).toBeGreaterThan(VALUE_MAX_ITEMS)
    expect(measureValue(sixty)).toBe(null)
  })

  it('admits an array inside both caps', () => {
    const fills = [
      { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
    ]
    expect(measureValue(fills)).toBe(jsonBytes(fills))
  })

  it('refuses a value JSON cannot carry, and never throws', () => {
    expect(measureValue(undefined)).toBe(null)
    expect(measureValue(() => 1)).toBe(null)
    expect(measureValue(Symbol('s'))).toBe(null)
    expect(measureValue(1n)).toBe(null)
    expect(measureValue({ a: 1n })).toBe(null)
  })

  it('refuses a cyclic value instead of throwing', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(measureValue(a)).toBe(null)
  })

  it('drops undefined-valued keys the way JSON.stringify does', () => {
    const v = { a: 1, b: undefined }
    expect(measureValue(v)).toBe(jsonBytes(v))
  })

  // A Figma node exposes its properties as PROTOTYPE ACCESSORS, so
  // `Object.keys(node)` is empty and a size walk measures it at the two bytes
  // of `{}` — the SMALLEST possible size, which sorts it FIRST under ascending
  // order and carries it always. Two of the properties a change event names
  // (`parent`, `prototypeStartNode`) are node-valued, and `parent` is exactly
  // what a human's reorder inside an auto-layout frame emits. The refusal is
  // still a SIZE test, not a name table: a value JSON cannot carry has no size.
  it('refuses an object whose properties are PROTOTYPE ACCESSORS', () => {
    expect(measureValue(fakeNode())).toBe(null)
    expect(measureValue({ p: fakeNode() })).toBe(null)
    expect(measureValue([fakeNode()])).toBe(null)
  })

  it('still admits the plain data the runtime really returns', () => {
    // Paints, effects and constraint objects are plain object literals, and a
    // null-prototype bag is plain data too.
    const paint = {
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
      opacity: 1,
    }
    expect(measureValue([paint])).toBe(jsonBytes([paint]))
    const bare = Object.assign(Object.create(null), {
      a: 1,
    }) as Record<string, unknown>
    expect(measureValue(bare)).toBe(jsonBytes(bare))
  })
})

describe('pickValues', () => {
  const entry = (name: string, value: unknown) => ({
    name,
    read: () => value,
  })

  it('never carries a node-valued property, however cheap it measures', () => {
    const node = fakeNode()
    const picked = pickValues(
      [entry('parent', node), entry('x', 1234)],
      RECORD_VALUE_BUDGET,
    )
    expect(picked.has('parent')).toBe(false)
    expect(picked.get('x')).toBe(1234)
  })

  it('carries a property while it fits both caps and the budget', () => {
    const picked = pickValues(
      [entry('x', 20), entry('name', 'Card')],
      RECORD_VALUE_BUDGET,
    )
    expect(picked.get('x')).toBe(20)
    expect(picked.get('name')).toBe('Card')
    expect(picked.size).toBe(2)
  })

  it('considers properties in ASCENDING size, maximising the count admitted', () => {
    // One 80-byte property and three 12-byte ones, on a budget of 40. Input
    // order puts the expensive one first: a pass that spent the budget in
    // input order would admit nothing at all.
    const big = 'b'.repeat(78)
    const small = 'a'.repeat(10)
    const picked = pickValues(
      [
        entry('big', big),
        entry('s3', small),
        entry('s1', small),
        entry('s2', small),
      ],
      40,
    )
    expect([...picked.keys()]).toEqual(['s1', 's2', 's3'])
    expect(picked.has('big')).toBe(false)
  })

  it('breaks ties by NAME, so the outcome is deterministic', () => {
    const v = 'a'.repeat(10) // 12 bytes each
    const names = ['delta', 'alpha', 'charlie', 'bravo']
    const forward = pickValues(
      names.map(n => entry(n, v)),
      24, // room for exactly two
    )
    const reversed = pickValues(
      [...names].reverse().map(n => entry(n, v)),
      24,
    )
    expect([...forward.keys()]).toEqual(['alpha', 'bravo'])
    expect([...reversed.keys()]).toEqual([
      ...forward.keys(),
    ])
  })

  it('skips a read that THROWS without losing the record', () => {
    const picked = pickValues(
      [
        {
          name: 'boom',
          read: () => {
            throw new Error('node on an unloaded page')
          },
        },
        entry('x', 20),
      ],
      RECORD_VALUE_BUDGET,
    )
    expect(picked.has('boom')).toBe(false)
    expect(picked.get('x')).toBe(20)
  })

  it('skips an over-cap property even with budget to spare', () => {
    const picked = pickValues(
      [
        entry('path', 'M'.repeat(VALUE_MAX_BYTES + 1)),
        entry('x', 20),
      ],
      RECORD_VALUE_BUDGET,
    )
    expect(picked.has('path')).toBe(false)
    expect(picked.get('x')).toBe(20)
  })

  it('yields nothing when the budget cannot hold even the cheapest', () => {
    expect(pickValues([entry('x', 20)], 1).size).toBe(0)
    expect(pickValues([], RECORD_VALUE_BUDGET).size).toBe(0)
  })
})
