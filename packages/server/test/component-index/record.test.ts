import { describe, expect, it } from 'bun:test'
import {
  computeSignature,
  membershipFingerprint,
  recordsFromGetComponents,
  type ComponentIndexRecord,
} from '@figma-agent-bridge/server/component-index/record'

const base = {
  id: '1:2',
  key: 'abc',
  name: 'Button',
  type: 'COMPONENT' as const,
  page: 'Page 1',
  properties: [
    {
      id: 'Size',
      name: 'Size',
      type: 'VARIANT',
      defaultValue: 'M',
    },
  ],
  variantAxes: { Size: ['S', 'M'] },
}

describe('computeSignature', () => {
  it('is stable for identical content', () => {
    expect(computeSignature(base)).toBe(
      computeSignature({ ...base }),
    )
  })
  it('changes when a property default changes', () => {
    const edited = {
      ...base,
      properties: [
        { ...base.properties[0], defaultValue: 'S' },
      ],
    }
    expect(computeSignature(edited)).not.toBe(
      computeSignature(base),
    )
  })
  it('changes when the name changes', () => {
    expect(
      computeSignature({ ...base, name: 'Btn' }),
    ).not.toBe(computeSignature(base))
  })
})

describe('membershipFingerprint', () => {
  const rec = (
    id: string,
    name: string,
    key: string,
  ): ComponentIndexRecord => ({
    id,
    name,
    key,
    type: 'COMPONENT',
    page: 'p',
    source: 'local',
    fileKey: 'f',
    signature: 's',
  })
  it('is stable for the same id/name/key set regardless of order', () => {
    const a = [rec('1', 'A', 'ka'), rec('2', 'B', 'kb')]
    const b = [rec('2', 'B', 'kb'), rec('1', 'A', 'ka')]
    expect(membershipFingerprint(a)).toBe(
      membershipFingerprint(b),
    )
  })
  it('changes on rename', () => {
    const a = [rec('1', 'A', 'ka')]
    const b = [rec('1', 'A2', 'ka')]
    expect(membershipFingerprint(a)).not.toBe(
      membershipFingerprint(b),
    )
  })
})

describe('recordsFromGetComponents', () => {
  it('maps local entries to records with a signature and source=local', () => {
    const recs = recordsFromGetComponents(
      { local: [base], remote: [] },
      'file-key-1',
    )
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      id: '1:2',
      key: 'abc',
      name: 'Button',
      type: 'COMPONENT',
      page: 'Page 1',
      source: 'local',
      fileKey: 'file-key-1',
      variantAxes: { Size: ['S', 'M'] },
    })
    expect(typeof recs[0].signature).toBe('string')
  })
  it('ignores remote entries (local index only)', () => {
    const recs = recordsFromGetComponents(
      { local: [], remote: [base] },
      'file-key-1',
    )
    expect(recs).toHaveLength(0)
  })
})
