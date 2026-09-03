import { describe, expect, it } from 'bun:test'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import { buildMatcher } from '../match'

// MatchableNode: NodeSpec augmented with extra fields buildMatcher can test
type MatchableNode = NodeSpec & {
  componentKey?: string
  styleId?: string
  variableId?: string
  instancesOf?: string
  // B3 — the plugin scan emits the PLURAL forms (a node can carry several
  // style refs / bound variable ids); the matcher matches if ANY equals.
  styleIds?: string[]
  variableIds?: string[]
}

const frame = (
  overrides: Partial<MatchableNode> = {},
): MatchableNode => ({
  type: 'FRAME',
  name: 'Card 1',
  id: 'n1',
  ...overrides,
})

describe('buildMatcher', () => {
  describe('name glob', () => {
    it('matches with * wildcard at end', () => {
      const match = buildMatcher({ name: 'Card*' })
      expect(match(frame({ name: 'Card 1' }))).toBe(true)
      expect(match(frame({ name: 'Card' }))).toBe(true)
    })

    it('does not match a different name', () => {
      const match = buildMatcher({ name: 'Card*' })
      expect(match(frame({ name: 'Box' }))).toBe(false)
    })

    it('* wildcard at start', () => {
      const match = buildMatcher({ name: '*Button' })
      expect(match(frame({ name: 'Primary Button' }))).toBe(
        true,
      )
      expect(match(frame({ name: 'ButtonX' }))).toBe(false)
    })

    it('exact match (no wildcard)', () => {
      const match = buildMatcher({ name: 'Exact' })
      expect(match(frame({ name: 'Exact' }))).toBe(true)
      expect(match(frame({ name: 'ExactMore' }))).toBe(
        false,
      )
    })
  })

  describe('regex', () => {
    it('matches name against regex', () => {
      const match = buildMatcher({ regex: '^Card' })
      expect(match(frame({ name: 'Card 1' }))).toBe(true)
      expect(match(frame({ name: 'Box Card' }))).toBe(false)
    })

    it('uses full regex power', () => {
      const match = buildMatcher({ regex: '\\d+$' })
      expect(match(frame({ name: 'Item 42' }))).toBe(true)
      expect(match(frame({ name: 'Item' }))).toBe(false)
    })

    it('malformed regex throws a clear validation error (not match-all)', () => {
      expect(() =>
        buildMatcher({ regex: '[unterminated' }),
      ).toThrow(/invalid regex/i)
    })
  })

  describe('type', () => {
    it('single type string: matches when equal', () => {
      const match = buildMatcher({ type: 'FRAME' })
      expect(match(frame({ type: 'FRAME' }))).toBe(true)
      expect(match(frame({ type: 'TEXT' }))).toBe(false)
    })

    it('type array: matches any of the listed types', () => {
      const match = buildMatcher({
        type: ['FRAME', 'COMPONENT', 'TEXT'],
      })
      expect(match(frame({ type: 'FRAME' }))).toBe(true)
      expect(match(frame({ type: 'TEXT' }))).toBe(true)
      expect(match(frame({ type: 'COMPONENT' }))).toBe(true)
      expect(match(frame({ type: 'RECTANGLE' }))).toBe(
        false,
      )
    })
  })

  describe('componentKey', () => {
    it('matches on augmented componentKey field', () => {
      const match = buildMatcher({ componentKey: 'abc123' })
      expect(match(frame({ componentKey: 'abc123' }))).toBe(
        true,
      )
      expect(match(frame({ componentKey: 'other' }))).toBe(
        false,
      )
      expect(match(frame())).toBe(false)
    })
  })

  describe('styleId', () => {
    it('matches on augmented styleId field', () => {
      const match = buildMatcher({ styleId: 'S:1' })
      expect(match(frame({ styleId: 'S:1' }))).toBe(true)
      expect(match(frame({ styleId: 'S:2' }))).toBe(false)
      expect(match(frame())).toBe(false)
    })

    // B3 — the plugin scan emits styleIds[] (a node has fill/text/effect/…
    // style ids); the matcher matches when ANY equals the requested id.
    it('matches when the requested id is ANY of styleIds[]', () => {
      const match = buildMatcher({ styleId: 'S:1' })
      expect(
        match(frame({ styleIds: ['S:9', 'S:1'] })),
      ).toBe(true)
      expect(
        match(frame({ styleIds: ['S:9', 'S:8'] })),
      ).toBe(false)
    })

    // B85 — a style reference reaches the matcher in two spellings now. A LIVE
    // row carries the Plugin API's `fillStyleId`, which is `S:<key>,` — an
    // `S:` prefix and a trailing comma. An EXPORT-served row carries what
    // JSON_REST_V1 put under `styles`, and the two need not agree on the
    // decoration. The KEY is what identifies the style, so the comparison is
    // made on the key.
    it('matches across the two spellings of one style reference', () => {
      const match = buildMatcher({ styleId: 'S:60f91cd0,' })
      expect(match(frame({ styleId: '60f91cd0' }))).toBe(
        true,
      )
      expect(match(frame({ styleIds: ['60f91cd0'] }))).toBe(
        true,
      )
      const bare = buildMatcher({ styleId: '60f91cd0' })
      expect(bare(frame({ styleId: 'S:60f91cd0,' }))).toBe(
        true,
      )
      expect(bare(frame({ styleId: 'S:60f91cd1,' }))).toBe(
        false,
      )
    })
  })

  describe('variableId', () => {
    it('matches on augmented variableId field', () => {
      const match = buildMatcher({ variableId: 'V:42' })
      expect(match(frame({ variableId: 'V:42' }))).toBe(
        true,
      )
      expect(match(frame({ variableId: 'V:0' }))).toBe(
        false,
      )
      expect(match(frame())).toBe(false)
    })

    // B3 — the plugin scan emits variableIds[] (every boundVariables id on the
    // node); the matcher matches when ANY equals the requested id.
    it('matches when the requested id is ANY of variableIds[]', () => {
      const match = buildMatcher({ variableId: 'V:42' })
      expect(
        match(frame({ variableIds: ['V:1', 'V:42'] })),
      ).toBe(true)
      expect(
        match(frame({ variableIds: ['V:1', 'V:2'] })),
      ).toBe(false)
    })
  })

  describe('instancesOf', () => {
    it('matches INSTANCE nodes with correct instancesOf field', () => {
      const match = buildMatcher({ instancesOf: 'Button' })
      const instance: MatchableNode = {
        type: 'INSTANCE',
        name: 'Button copy',
        id: 'i1',
        instancesOf: 'Button',
      }
      expect(match(instance)).toBe(true)
    })

    it('does not match non-INSTANCE nodes even if instancesOf matches', () => {
      const match = buildMatcher({ instancesOf: 'Button' })
      // A FRAME that happens to have instancesOf set should not match
      const nonInstance: MatchableNode = {
        type: 'FRAME',
        name: 'Button',
        id: 'f1',
        instancesOf: 'Button',
      }
      // Per spec: instancesOf matches n.type === 'INSTANCE' AND instancesOf field
      // But the simpler impl just checks the instancesOf field — let's check what spec says
      // Spec says: match `n.type === 'INSTANCE'` AND `(n as any).instancesOf === m.instancesOf`
      expect(match(nonInstance)).toBe(false)
    })

    it('does not match INSTANCE with different instancesOf', () => {
      const match = buildMatcher({ instancesOf: 'Button' })
      const instance: MatchableNode = {
        type: 'INSTANCE',
        name: 'Icon copy',
        id: 'i2',
        instancesOf: 'Icon',
      }
      expect(match(instance)).toBe(false)
    })
  })

  describe('composed AND', () => {
    it('both predicates must hold', () => {
      const match = buildMatcher({
        type: 'FRAME',
        name: 'Card*',
      })
      expect(
        match(frame({ type: 'FRAME', name: 'Card 1' })),
      ).toBe(true)
      // Wrong type
      expect(
        match(frame({ type: 'TEXT', name: 'Card 1' })),
      ).toBe(false)
      // Wrong name
      expect(
        match(frame({ type: 'FRAME', name: 'Box' })),
      ).toBe(false)
    })

    it('three predicates all must hold', () => {
      const match = buildMatcher({
        type: ['FRAME', 'COMPONENT'],
        name: '*Button',
        componentKey: 'key-1',
      })
      expect(
        match(
          frame({
            type: 'FRAME',
            name: 'Primary Button',
            componentKey: 'key-1',
          }),
        ),
      ).toBe(true)
      expect(
        match(
          frame({
            type: 'FRAME',
            name: 'Primary Button',
            componentKey: 'other',
          }),
        ),
      ).toBe(false)
    })
  })

  describe('empty match', () => {
    it('empty {} matches everything', () => {
      const match = buildMatcher({})
      expect(match(frame())).toBe(true)
      expect(
        match(frame({ type: 'TEXT', name: 'anything' })),
      ).toBe(true)
    })
  })
})
