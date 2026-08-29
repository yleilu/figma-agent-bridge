import { describe, expect, it } from 'bun:test'
import { depthProjectionConflict } from '../depth-projection'

describe('depthProjectionConflict (I64)', () => {
  it('says nothing when no descent was asked for', () => {
    expect(
      depthProjectionConflict({ profile: 'minimal' }),
    ).toBeNull()
    expect(
      depthProjectionConflict({
        depth: 0,
        profile: 'minimal',
      }),
    ).toBeNull()
  })

  it('says nothing when the projection keeps children', () => {
    // No selector at all — projectNode is identity.
    expect(depthProjectionConflict({ depth: 2 })).toBeNull()
    // `full` is identity too, by projectNode's own short-circuit.
    expect(
      depthProjectionConflict({
        depth: 2,
        profile: 'full',
      }),
    ).toBeNull()
    // Named explicitly in `fields`.
    expect(
      depthProjectionConflict({
        depth: 2,
        fields: ['id', 'name', 'children'],
      }),
    ).toBeNull()
    // An empty `fields` array selects nothing and falls through to identity,
    // exactly as projectNode treats it.
    expect(
      depthProjectionConflict({ depth: 2, fields: [] }),
    ).toBeNull()
  })

  it('REFUSES depth:2 + profile:minimal — the triage repro', () => {
    const message = depthProjectionConflict({
      depth: 2,
      profile: 'minimal',
    })
    expect(message).not.toBeNull()
    expect(message).toContain('depth')
    expect(message).toContain('minimal')
    // Both ways out are named, so the refusal ends the problem.
    expect(message).toContain('children')
    expect(message).toContain("profile:'full'")
  })

  it('REFUSES a fields list that omits children', () => {
    const message = depthProjectionConflict({
      depth: 1,
      fields: ['type', 'name'],
    })
    expect(message).not.toBeNull()
    expect(message).toContain('type, name')
  })

  it('REFUSES depth:-1 too — every level is still a descent', () => {
    expect(
      depthProjectionConflict({
        depth: -1,
        profile: 'layout',
      }),
    ).not.toBeNull()
  })

  it('`fields` wins over `profile`, as projectNode does', () => {
    // profile would drop children, but the non-empty fields list decides.
    expect(
      depthProjectionConflict({
        depth: 2,
        profile: 'minimal',
        fields: ['id', 'children'],
      }),
    ).toBeNull()
  })

  it('an out-of-enum profile is identity (B4), so it keeps children', () => {
    expect(
      depthProjectionConflict({
        depth: 2,
        profile: 'bogus' as never,
      }),
    ).toBeNull()
  })
})
