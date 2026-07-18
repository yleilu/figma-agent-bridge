import { describe, it, expect } from 'bun:test'
import { projectNode } from '../../src/read/project'
import type { NodeSpec } from '@figma-agent-bridge/shared'

const node = {
  id: '1:1',
  name: 'X',
  type: 'FRAME',
} as unknown as NodeSpec

describe('projectNode — B4: unknown profile falls through, no throw', () => {
  it('returns the node unchanged for an out-of-enum profile (no crash)', () => {
    // A non-SDK caller can bypass the Zod enum with an unknown profile.
    // PROFILES[bogus] is `undefined` (not null) — the guard must return the
    // node unchanged, not throw "undefined is not an object" in the key loop.
    expect(() =>
      projectNode(node, { profile: 'bogus' as any }),
    ).not.toThrow()

    expect(
      projectNode(node, { profile: 'bogus' as any }),
    ).toBe(node)
  })

  it('returns the node unchanged when no selection is given', () => {
    expect(projectNode(node)).toBe(node)
  })

  it('returns the node unchanged for an empty fields array', () => {
    expect(projectNode(node, { fields: [] })).toBe(node)
  })

  it('projects only the requested fields', () => {
    expect(
      projectNode(node, { fields: ['id', 'type'] }),
    ).toEqual({
      id: '1:1',
      type: 'FRAME',
    })
  })
})
