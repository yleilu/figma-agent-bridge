import { describe, it, expect } from 'bun:test'
import { buildRoster } from './roster'
import type { StatusRecord } from '@figma-agent-bridge/shared'

const rec = (o: Partial<StatusRecord>): StatusRecord => ({
  key: o.agentId ?? o.sessionId ?? 'k',
  level: 'normal',
  text: 'x',
  activity: 'busy',
  updatedAt: 1,
  ...o,
})

describe('buildRoster', () => {
  it('renders a lone agent as a single flat row (no group header)', () => {
    const rows = buildRoster({
      s1: rec({ key: 's1', sessionId: 's1' }),
    })
    expect(rows).toEqual([
      {
        kind: 'flat',
        record: expect.objectContaining({ key: 's1' }),
      },
    ])
  })

  it('groups a session with >=2 agents: header (top-level, no agentId) + nested children', () => {
    const records = {
      s1: rec({
        key: 's1',
        sessionId: 's1',
        text: 'Building nav',
      }), // top-level
      a1: rec({
        key: 'a1',
        sessionId: 's1',
        agentId: 'a1',
        agentType: 'Explore',
      }),
      a2: rec({
        key: 'a2',
        sessionId: 's1',
        agentId: 'a2',
        agentType: 'figma-designer',
      }),
    }
    const rows = buildRoster(records)
    expect(rows.map(r => r.kind)).toEqual([
      'group-header',
      'child',
      'child',
    ])
    expect(rows[0].record.key).toBe('s1')
    expect(
      rows
        .slice(1)
        .map(r => r.record.key)
        .sort(),
    ).toEqual(['a1', 'a2'])
  })

  it('two independent sessions are two separate flat rows/groups', () => {
    const rows = buildRoster({
      s1: rec({ key: 's1', sessionId: 's1' }),
      s2: rec({ key: 's2', sessionId: 's2' }),
    })
    expect(
      rows.filter(r => r.kind === 'flat'),
    ).toHaveLength(2)
  })

  it('a session of only subagents (no top-level record) still groups under a synthetic header', () => {
    const rows = buildRoster({
      a1: rec({
        key: 'a1',
        sessionId: 's1',
        agentId: 'a1',
        agentType: 'Explore',
      }),
      a2: rec({
        key: 'a2',
        sessionId: 's1',
        agentId: 'a2',
        agentType: 'Reviewer',
      }),
    })
    expect(rows[0].kind).toBe('group-header')
    expect(rows[0].record.synthetic).toBe(true)
    expect(
      rows.filter(r => r.kind === 'child'),
    ).toHaveLength(2)
  })

  it('a record with no sessionId renders as its own flat row', () => {
    const rows = buildRoster({
      agent: rec({ key: 'agent', label: 'nav-builder' }),
    })
    expect(rows).toEqual([
      {
        kind: 'flat',
        record: expect.objectContaining({ key: 'agent' }),
      },
    ])
  })
})
