import { describe, it, expect } from 'bun:test'
import type { ChannelInfo } from '@figma-agent-bridge/shared'
import { resolveTarget } from '@figma-agent-bridge/server/tools/session'

const ch = (
  channel: string,
  fileKey: string | null,
  fileName: string | null,
): ChannelInfo => ({
  channel,
  fileKey,
  fileName,
  connectedAt: 0,
})

describe('resolveTarget', () => {
  const A = ch('ch-a', 'key-a', 'Design A')
  const B = ch('ch-b', 'key-b', 'Design B')

  it('matches a unique fileKey', () => {
    const r = resolveTarget([A, B], { fileKey: 'key-b' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.info.channel).toBe('ch-b')
    }
  })

  it('matches by fileName when no fileKey is given', () => {
    const r = resolveTarget([A, B], {
      fileName: 'Design A',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.info.channel).toBe('ch-a')
    }
  })

  it('prefers fileKey over fileName when both are given', () => {
    const r = resolveTarget([A, B], {
      fileKey: 'key-a',
      fileName: 'Design B',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.info.channel).toBe('ch-a')
    }
  })

  it('reports none when the fileKey matches nothing', () => {
    const r = resolveTarget([A, B], { fileKey: 'key-z' })
    expect(r).toEqual({ ok: false, reason: 'none' })
  })

  it('reports ambiguous when a fileName matches two files', () => {
    const dupe = ch('ch-c', 'key-c', 'Design A')
    const r = resolveTarget([A, dupe], {
      fileName: 'Design A',
    })
    expect(r).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('does NOT auto-select the sole file when no target is given (B3)', () => {
    expect(resolveTarget([A], {})).toEqual({
      ok: false,
      reason: 'unspecified',
    })
  })

  it('reports unspecified for a bare connect with multiple files', () => {
    expect(resolveTarget([A, B], {})).toEqual({
      ok: false,
      reason: 'unspecified',
    })
  })

  it('reports none for a bare connect with no files', () => {
    const r = resolveTarget([], {})
    expect(r).toEqual({ ok: false, reason: 'none' })
  })
})
