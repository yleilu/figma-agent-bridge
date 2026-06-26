// paginate.test.ts — paginateList: the one reusable limit+cursor helper that
// bounds every list read (T10).
//
// paginateList(items, { limit?, cursor? }) → { page, truncated, cursor? }
//   • limit defaults to 100
//   • page          = bounded slice (items[start .. start+limit])
//   • truncated     = true when more items existed past the slice
//   • cursor        = opaque, version-stamped continuation token, present only
//                     when truncated. Resuming a token at a CHANGED id-set is
//                     reported STALE (typed error), not silently mis-paged.
//
// The cursor reuses read/cursor.ts (encodeCursor/decodeCursor) so the same
// opaque/versioned guarantees search already has hold for every list read.

import { describe, expect, it } from 'bun:test'
import { paginateList } from '../paginate'

// A simple id-bearing item fixture. paginateList version-stamps over `id`.
const item = (id: string) => ({ id, name: `n-${id}` })

// Build N items: 1:1 .. 1:N
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => item(`1:${i + 1}`))

describe('paginateList', () => {
  it('default limit is 100 (no limit given)', () => {
    const out = paginateList(items(250), {})
    expect(out.page).toHaveLength(100)
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('exact-limit: items === limit → not truncated, no cursor', () => {
    const out = paginateList(items(3), { limit: 3 })
    expect(out.page).toHaveLength(3)
    expect(out.truncated).toBe(false)
    expect(out.cursor).toBeUndefined()
  })

  it('over-limit: more items than limit → truncated + cursor', () => {
    const out = paginateList(items(5), { limit: 2 })
    expect(out.page).toHaveLength(2)
    expect(out.page[0].id).toBe('1:1')
    expect(out.page[1].id).toBe('1:2')
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
    expect((out.cursor as string).length).toBeGreaterThan(0)
  })

  it('cursor round-trip: resumes at the right offset', () => {
    const all = items(5)
    const page1 = paginateList(all, { limit: 2 })
    expect(page1.cursor).toBeDefined()

    const page2 = paginateList(all, {
      limit: 2,
      cursor: page1.cursor,
    })
    expect(page2.page).toHaveLength(2)
    expect(page2.page[0].id).toBe('1:3')
    expect(page2.page[1].id).toBe('1:4')
    expect(page2.truncated).toBe(true)

    const page3 = paginateList(all, {
      limit: 2,
      cursor: page2.cursor,
    })
    expect(page3.page).toHaveLength(1)
    expect(page3.page[0].id).toBe('1:5')
    expect(page3.truncated).toBe(false)
    expect(page3.cursor).toBeUndefined()
  })

  it('STALE: a cursor minted against a different id-set is rejected', () => {
    const page1 = paginateList(items(5), { limit: 2 })
    expect(() =>
      // A changed id-set → different version → STALE, not mis-page.
      paginateList(items(3), {
        limit: 2,
        cursor: page1.cursor,
      }),
    ).toThrow(/STALE/)
  })

  it('MALFORMED: garbage cursor throws a typed error', () => {
    expect(() =>
      paginateList(items(5), {
        limit: 2,
        cursor: '!!!not-a-cursor!!!',
      }),
    ).toThrow(/MALFORMED/)
  })

  it('empty list: no results, not truncated, no cursor', () => {
    const out = paginateList([], {})
    expect(out.page).toHaveLength(0)
    expect(out.truncated).toBe(false)
    expect(out.cursor).toBeUndefined()
  })

  it('the continuation cursor is opaque (not plaintext JSON)', () => {
    // Mirrors cursor.test.ts: the token is base64url-encoded, so it must not
    // expose the raw `pos` key as plaintext. (We can't assert "no digit 2" —
    // base64url's alphabet includes digits incidentally.)
    const out = paginateList(items(50), { limit: 7 })
    expect(out.cursor).not.toContain('pos')
    expect(out.cursor).not.toContain('treeVersion')
  })

  it('clamps limit<=0 to 1 — bounded page, makes forward progress (no no-progress loop)', () => {
    const out = paginateList(items(5), { limit: 0 })
    expect(out.page).toHaveLength(1) // clamped to 1, never a zero-width page
    expect(out.truncated).toBe(true)
    const next = paginateList(items(5), {
      limit: 0,
      cursor: out.cursor,
    })
    expect(next.page[0]?.id).not.toBe(out.page[0]?.id) // advanced, not stuck
  })
})
