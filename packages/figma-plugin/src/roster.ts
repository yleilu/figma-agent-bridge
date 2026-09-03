import type { StatusRecord } from '@figma-agent-bridge/shared'

// A row carries either a real StatusRecord or a synthetic session header
// (when a session has >=2 agents but no top-level record to head the group).
export type RosterRecord = StatusRecord & {
  synthetic?: boolean
}
export type RosterRow = {
  kind: 'flat' | 'group-header' | 'child'
  record: RosterRecord
}

const byKey = (a: RosterRow, b: RosterRow) =>
  a.record.key.localeCompare(b.record.key)

export const buildRoster = (
  records: Record<string, StatusRecord>,
): RosterRow[] => {
  const all = Object.values(records)
  // partition: records with a sessionId group; those without are standalone flats
  const bySession = new Map<string, StatusRecord[]>()
  const loose: StatusRecord[] = []
  for (const r of all) {
    if (r.sessionId === undefined) loose.push(r)
    else {
      const g = bySession.get(r.sessionId) ?? []
      g.push(r)
      bySession.set(r.sessionId, g)
    }
  }

  const rows: RosterRow[] = []
  // stable session order by sessionId
  for (const sessionId of [...bySession.keys()].sort()) {
    const group = bySession.get(sessionId)!
    if (group.length === 1) {
      rows.push({ kind: 'flat', record: group[0] })
      continue
    }
    // >=2 agents → header + children. Header = the top-level record (no agentId);
    // if absent, a synthetic header standing in for the session.
    const topLevel = group.find(
      r => r.agentId === undefined,
    )
    if (topLevel) {
      rows.push({ kind: 'group-header', record: topLevel })
    } else {
      rows.push({
        kind: 'group-header',
        record: {
          key: `session:${sessionId}`,
          sessionId,
          level: 'normal',
          text: null,
          activity: 'busy',
          updatedAt: 0,
          synthetic: true,
        },
      })
    }
    const children = group
      .filter(r => r !== topLevel)
      .map(
        (record): RosterRow => ({ kind: 'child', record }),
      )
      .sort(byKey)
    rows.push(...children)
  }
  // loose records (no sessionId) as flat rows, stable by key
  loose
    .map((record): RosterRow => ({ kind: 'flat', record }))
    .sort(byKey)
    .forEach(r => rows.push(r))
  return rows
}
