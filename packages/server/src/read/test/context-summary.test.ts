import { describe, expect, it } from 'bun:test'
import { contextSummaryOf } from '../context-summary'

describe('contextSummaryOf', () => {
  const fm = '---\npurpose: CTA\nrole: button/primary\n---\n## Notes\nbody'
  it('returns the inner frontmatter slice (not the fences)', () => {
    expect(contextSummaryOf(fm)).toBe('purpose: CTA\nrole: button/primary')
  })
  it('tolerates a CRLF opening fence', () => {
    expect(contextSummaryOf('---\r\npurpose: x\r\n---\r\nbody')).toBe('purpose: x')
  })
  it('is undefined with no leading frontmatter', () => {
    expect(contextSummaryOf('## Notes\nno frontmatter')).toBeUndefined()
  })
  it('is undefined when the opening fence is never closed', () => {
    expect(contextSummaryOf('---\npurpose: x\nno close')).toBeUndefined()
  })
  it('does not treat a body --- (thematic break) as the close', () => {
    expect(contextSummaryOf('---\npurpose: x\n---\nintro\n---\nmore')).toBe('purpose: x')
  })
  it('caps the slice to 512 bytes with a trailing marker on a codepoint boundary', () => {
    const s = contextSummaryOf('---\n' + 'x'.repeat(1000) + '\n---\n')!
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(512)
    expect(s.endsWith('…')).toBe(true)
  })
})
