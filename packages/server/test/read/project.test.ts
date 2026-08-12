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

// B31 — `readError` is outside projection: a narrowed read must still say the
// node could not be read. No `fields` list can ask for it, because which node
// breaks is not knowable before the read.
describe('projectNode — readError survives every selector', () => {
  const broken = {
    ...node,
    readError:
      'Error: in getSharedPluginData: The node (instance sublayer or table cell) with id "I3:1;4:5;6:7" does not exist',
  } as unknown as NodeSpec

  it('keeps readError under profile:minimal', () => {
    const out = projectNode(broken, {
      profile: 'minimal',
    })
    expect(out.readError).toBe(broken.readError)
    expect(Object.keys(out).sort()).toEqual([
      'id',
      'name',
      'readError',
      'type',
    ])
  })

  it('keeps readError under a fields allow-list that never names it', () => {
    expect(
      projectNode(broken, { fields: ['id'] }).readError,
    ).toBe(broken.readError)
  })

  it('adds nothing to a node that read cleanly', () => {
    expect(
      'readError' in
        projectNode(node, { profile: 'minimal' }),
    ).toBe(false)
    expect(
      'readErrors' in
        projectNode(node, { profile: 'minimal' }),
    ).toBe(false)
  })

  it('keeps readErrors — the ancestor-reported failures — under a narrow', () => {
    const ancestor = {
      ...node,
      readErrors: [
        'I<stale>;6:7: Error: in getSharedPluginData: … does not exist',
      ],
    } as unknown as NodeSpec
    expect(
      projectNode(ancestor, { profile: 'minimal' })
        .readErrors,
    ).toEqual(ancestor.readErrors)
    expect(
      projectNode(ancestor, { fields: ['id'] }).readErrors,
    ).toEqual(ancestor.readErrors)
  })
})
