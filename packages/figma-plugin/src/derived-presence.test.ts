import { describe, it, expect } from 'bun:test'
import type { StatusRecord } from '@figma-agent-bridge/shared'
import {
  DERIVED_TTL_MS,
  classifyCommand,
  deriveRow,
  mergeStatus,
  sweepDerived,
  upsertDerived,
} from './derived-presence'
import { buildRoster } from './roster'
import { selectPanelView } from './panel-view'

const NOW = 1_000_000

const reported = (
  o: Partial<StatusRecord>,
): StatusRecord => ({
  key: o.agentId ?? o.sessionId ?? 'agent',
  level: 'normal',
  text: 'Building the nav',
  activity: 'busy',
  updatedAt: NOW,
  ...o,
})

describe('the spec numbers', () => {
  it('a derived row expires 30s after the last frame (status-monitor.md)', () => {
    expect(DERIVED_TTL_MS).toBe(30_000)
  })
})

describe('classifyCommand', () => {
  it('reads read as Reading, writes as Editing, export as Exporting', () => {
    expect(classifyCommand('get_node')).toBe('Reading')
    expect(classifyCommand('search')).toBe('Reading')
    expect(classifyCommand('create_tree')).toBe('Editing')
    expect(classifyCommand('update_node')).toBe('Editing')
    expect(classifyCommand('delete_node')).toBe('Editing')
    expect(classifyCommand('export')).toBe('Exporting')
  })

  it('a context move changes no document, so it is Reading not Editing', () => {
    expect(classifyCommand('set_selection')).toBe('Reading')
    expect(classifyCommand('set_current_page')).toBe(
      'Reading',
    )
    expect(classifyCommand('set_focus')).toBe('Reading')
  })

  it('an unknown command is Working, never a guess', () => {
    expect(classifyCommand('teleport_node')).toBe('Working')
  })
})

describe('deriveRow', () => {
  it('keys by session and carries the verb class as its text', () => {
    const row = deriveRow('get_node', 's1', NOW)
    expect(row).toEqual({
      key: 'derived:s1',
      sessionId: 's1',
      level: 'normal',
      text: 'Reading',
      activity: 'busy',
      updatedAt: NOW,
      derived: true,
    })
  })

  it('a session named like the anonymous row keeps its own key', () => {
    expect(
      deriveRow('get_node', 'agent', NOW).key,
    ).not.toBe(deriveRow('get_node', undefined, NOW).key)
  })

  it('an identity-less frame folds into ONE anonymous row', () => {
    const a = deriveRow('get_node', undefined, NOW)
    const b = deriveRow('create_node', undefined, NOW + 1)
    expect(a.key).toBe(b.key)
    expect(a.sessionId).toBeUndefined()
  })
})

describe('upsertDerived', () => {
  it('a command frame with a sessionId yields one derived row', () => {
    const rows = upsertDerived({}, 'get_node', 's1', NOW)
    expect(Object.keys(rows)).toEqual(['derived:s1'])
    expect(rows['derived:s1'].text).toBe('Reading')
  })

  it('a later frame of a different class re-labels the same row', () => {
    const first = upsertDerived({}, 'get_node', 's1', NOW)
    const next = upsertDerived(
      first,
      'create_tree',
      's1',
      NOW + 100,
    )
    expect(Object.keys(next)).toEqual(['derived:s1'])
    expect(next['derived:s1'].text).toBe('Editing')
  })

  it('coalesces a burst of same-class frames (same object, no re-render)', () => {
    const first = upsertDerived({}, 'get_node', 's1', NOW)
    const again = upsertDerived(
      first,
      'get_nodes',
      's1',
      NOW + 10,
    )
    expect(again).toBe(first)
  })

  it('two sessions are two rows', () => {
    const rows = upsertDerived(
      upsertDerived({}, 'get_node', 's1', NOW),
      'create_node',
      's2',
      NOW,
    )
    expect(Object.keys(rows).sort()).toEqual([
      'derived:s1',
      'derived:s2',
    ])
  })
})

describe('sweepDerived', () => {
  it('drops a row once its traffic has been quiet past the TTL', () => {
    const rows = upsertDerived({}, 'get_node', 's1', NOW)
    expect(
      sweepDerived(rows, NOW + DERIVED_TTL_MS - 1),
    ).toBe(rows)
    expect(
      sweepDerived(rows, NOW + DERIVED_TTL_MS),
    ).toEqual({})
  })

  it('returns the SAME map when nothing expired', () => {
    const rows = upsertDerived({}, 'get_node', 's1', NOW)
    expect(sweepDerived(rows, NOW + 1)).toBe(rows)
  })

  it('sweeps only the quiet session, never a live sibling', () => {
    const rows = upsertDerived(
      upsertDerived({}, 'get_node', 'old', NOW),
      'get_node',
      'live',
      NOW + DERIVED_TTL_MS,
    )
    const swept = sweepDerived(
      rows,
      NOW + DERIVED_TTL_MS + 1,
    )
    expect(Object.keys(swept)).toEqual(['derived:live'])
  })
})

describe('mergeStatus', () => {
  it('shows a derived row when no agent has reported', () => {
    const merged = mergeStatus(
      {},
      upsertDerived({}, 'export', 's1', NOW),
      NOW,
    )
    expect(merged['derived:s1'].text).toBe('Exporting')
  })

  it('a reported row REPLACES its session’s derived row', () => {
    const derived = upsertDerived({}, 'get_node', 's1', NOW)
    const merged = mergeStatus(
      { s1: reported({ key: 's1', sessionId: 's1' }) },
      derived,
      NOW,
    )
    expect(Object.keys(merged)).toEqual(['s1'])
    expect(merged.s1.text).toBe('Building the nav')
  })

  it('a later command frame never resurrects the replaced row', () => {
    const explicit = {
      s1: reported({ key: 's1', sessionId: 's1' }),
    }
    const derived = upsertDerived(
      upsertDerived({}, 'get_node', 's1', NOW),
      'create_tree',
      's1',
      NOW + 5_000,
    )
    expect(
      Object.keys(
        mergeStatus(explicit, derived, NOW + 5_000),
      ),
    ).toEqual(['s1'])
  })

  it('a subagent’s reported row also pre-empts its session’s derived row', () => {
    const merged = mergeStatus(
      {
        a1: reported({
          key: 'a1',
          sessionId: 's1',
          agentId: 'a1',
        }),
      },
      upsertDerived({}, 'get_node', 's1', NOW),
      NOW,
    )
    expect(Object.keys(merged)).toEqual(['a1'])
  })

  it('any reported row pre-empts the anonymous row (never a phantom second agent)', () => {
    const merged = mergeStatus(
      { s1: reported({ key: 's1', sessionId: 's1' }) },
      upsertDerived({}, 'get_node', undefined, NOW),
      NOW,
    )
    expect(Object.keys(merged)).toEqual(['s1'])
  })

  it('an identity-less reported row pre-empts the anonymous row, not a session that shares its name', () => {
    const merged = mergeStatus(
      { agent: reported({ key: 'agent' }) },
      upsertDerived({}, 'get_node', 'agent', NOW),
      NOW,
    )
    expect(Object.keys(merged).sort()).toEqual([
      'agent',
      'derived:agent',
    ])
  })

  it('leaves reported rows untouched, including another session’s', () => {
    const explicit = {
      s1: reported({ key: 's1', sessionId: 's1' }),
    }
    const merged = mergeStatus(
      explicit,
      upsertDerived({}, 'get_node', 's2', NOW),
      NOW,
    )
    expect(merged.s1).toBe(explicit.s1)
    expect(Object.keys(merged).sort()).toEqual([
      'derived:s2',
      's1',
    ])
  })

  it('drops an expired derived row even before the sweep runs', () => {
    const merged = mergeStatus(
      {},
      upsertDerived({}, 'get_node', 's1', NOW),
      NOW + DERIVED_TTL_MS,
    )
    expect(merged).toEqual({})
  })
})

describe('the panel never claims silence while traffic flows', () => {
  it('one command frame keeps the panel out of "No agent active"', () => {
    const rows = buildRoster(
      mergeStatus(
        {},
        upsertDerived({}, 'create_tree', 's1', NOW),
        NOW,
      ),
    )
    expect(rows).toHaveLength(1)
    expect(
      selectPanelView('connected', null, rows.length).kind,
    ).toBe('roster')
  })

  it('and falls back to idle only once the traffic has stopped', () => {
    const derived = upsertDerived(
      {},
      'create_tree',
      's1',
      NOW,
    )
    const later = NOW + DERIVED_TTL_MS
    const rows = buildRoster(
      mergeStatus({}, sweepDerived(derived, later), later),
    )
    expect(
      selectPanelView('connected', null, rows.length).kind,
    ).toBe('idle')
  })
})
