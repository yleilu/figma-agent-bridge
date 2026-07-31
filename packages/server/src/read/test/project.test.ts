import { describe, expect, it } from 'bun:test'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import { PROFILES, projectNode } from '../project'

const sampleNode: NodeSpec = {
  type: 'FRAME',
  name: 'MyFrame',
  id: 'frame-1',
  size: [200, 100],
  position: [10, 20],
  layout: { mode: 'H', gap: 8 },
  fills: ['#FF0000'],
  strokes: ['#000000'],
  opacity: 0.9,
  text: {
    content: 'hello',
    font: 'font(Inter,Regular,16)',
  },
}

describe('projectNode', () => {
  it('fields: returns only the specified keys', () => {
    const result = projectNode(sampleNode, {
      fields: ['id', 'name'],
    })
    expect(Object.keys(result).sort()).toEqual([
      'id',
      'name',
    ])
    expect(result.id).toBe('frame-1')
    expect(result.name).toBe('MyFrame')
  })

  it('fields: unknown field is ignored (no throw)', () => {
    expect(() =>
      projectNode(sampleNode, {
        fields: ['id', 'nonexistent'],
      }),
    ).not.toThrow()
    const result = projectNode(sampleNode, {
      fields: ['id', 'nonexistent'],
    })
    expect(result.id).toBe('frame-1')
    // nonexistent should not appear
    expect('nonexistent' in result).toBe(false)
  })

  it('profile:minimal returns type, name, id only', () => {
    const result = projectNode(sampleNode, {
      profile: 'minimal',
    })
    for (const k of PROFILES.minimal) {
      if (k in sampleNode) {
        expect(k in result).toBe(true)
      }
    }
    // Should not include layout-only fields
    expect('layout' in result).toBe(false)
    expect('fills' in result).toBe(false)
  })

  it('profile:layout returns layout fields', () => {
    const result = projectNode(sampleNode, {
      profile: 'layout',
    })
    expect('layout' in result).toBe(true)
    expect('size' in result).toBe(true)
    // Should not include text or fills
    expect('text' in result).toBe(false)
    expect('fills' in result).toBe(false)
  })

  it('profile:style returns style fields', () => {
    const result = projectNode(sampleNode, {
      profile: 'style',
    })
    expect('fills' in result).toBe(true)
    expect('strokes' in result).toBe(true)
    expect('opacity' in result).toBe(true)
    // Should not include layout
    expect('layout' in result).toBe(false)
    expect('text' in result).toBe(false)
  })

  it('profile:text returns text fields', () => {
    const result = projectNode(sampleNode, {
      profile: 'text',
    })
    expect('text' in result).toBe(true)
    expect('fills' in result).toBe(false)
    expect('layout' in result).toBe(false)
  })

  it('profile:full returns all keys present on the node', () => {
    const result = projectNode(sampleNode, {
      profile: 'full',
    })
    for (const k of Object.keys(sampleNode)) {
      expect(k in result).toBe(true)
    }
  })

  it('no selector: returns node unchanged (identity)', () => {
    const result = projectNode(sampleNode)
    expect(result).toBe(sampleNode)
  })

  it('fields take precedence over profile when both given', () => {
    const result = projectNode(sampleNode, {
      fields: ['id'],
      profile: 'layout',
    })
    expect(Object.keys(result)).toEqual(['id'])
  })

  it('empty fields array falls through to the profile', () => {
    const result = projectNode(sampleNode, {
      fields: [],
      profile: 'layout',
    })
    // An empty fields list is not a meaningful projection — the profile wins.
    expect('layout' in result).toBe(true)
    expect('size' in result).toBe(true)
    expect('text' in result).toBe(false)
  })

  it('empty fields array with no profile falls through to identity', () => {
    const result = projectNode(sampleNode, { fields: [] })
    expect(result).toBe(sampleNode)
  })
  // `full` means every field. It used to be an enumerated list, which fell
  // eight fields behind NodeSpec — `component`, the INSTANCE round-trip
  // anchor, among them. Identity is the only definition that cannot drift.
  it('profile:full keeps every field, including ones no list names', () => {
    const rich = {
      ...sampleNode,
      component: { id: '2:3' },
      isMask: true,
      vectorPaths: ['M0 0'],
      childCount: 3,
    } as unknown as Parameters<typeof projectNode>[0]
    expect(projectNode(rich, { profile: 'full' })).toBe(
      rich,
    )
  })

  it('profile:full ignores an empty fields array', () => {
    expect(
      projectNode(sampleNode, {
        profile: 'full',
        fields: [],
      }),
    ).toBe(sampleNode)
  })

  it('explicit fields still win over profile:full', () => {
    const result = projectNode(sampleNode, {
      profile: 'full',
      fields: ['name'],
    })
    expect(Object.keys(result)).toEqual(['name'])
  })

  it('a narrowing profile still narrows', () => {
    const result = projectNode(sampleNode, {
      profile: 'minimal',
    })
    expect(Object.keys(result).sort()).toEqual([
      'id',
      'name',
      'type',
    ])
  })
})
