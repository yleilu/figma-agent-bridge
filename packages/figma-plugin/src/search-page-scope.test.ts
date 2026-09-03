import { describe, expect, it } from 'bun:test'
import { resolvePageScope } from './search-page-scope'

const current = { id: '0:1', name: 'Overview' }

describe('resolvePageScope (I65)', () => {
  it('takes the pageId it was given, and says nothing', () => {
    expect(resolvePageScope('12:34', current)).toEqual({
      pageId: '12:34',
    })
  })

  it('falls back to the CURRENT page when no pageId was named', () => {
    const out = resolvePageScope(undefined, current)
    expect(out.pageId).toBe('0:1')
    // …and the reply says which page it chose, by name AND id.
    expect(out.note).toContain('Overview')
    expect(out.note).toContain('0:1')
    expect(out.note).toContain('pageId')
  })

  it('treats an empty pageId as absent — an empty string names no page', () => {
    expect(resolvePageScope('', current).pageId).toBe('0:1')
  })

  it('reports the fallback when even the current page cannot be named', () => {
    const out = resolvePageScope(undefined, undefined)
    expect(out.pageId).toBeUndefined()
    expect(out.note).toBeUndefined()
  })
})
