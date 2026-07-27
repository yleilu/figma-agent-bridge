// Folds admitted records immediately; the timer only decides WHEN to flush,
// never WHAT to keep (change-feed.md, Plugin-side pipeline §3).
import {
  collapse,
  toEntry,
  toRecord,
  type BufferEntry,
  type ChangeRecord,
} from '@figma-agent-bridge/shared/change-feed'

export type ChangeAccumulator = {
  add(rec: ChangeRecord): void
  markIndexStale(): void
  size(): number
  indexStale(): boolean
  overflowed(): boolean
  drain(): {
    changes: ChangeRecord[]
    indexStale: boolean
    overflow: boolean
  }
}

export const createAccumulator = (
  cap: number,
): ChangeAccumulator => {
  const nodes = new Map<string, BufferEntry>()
  const styles = new Map<string, BufferEntry>()
  let page: ChangeRecord | null = null
  let select: ChangeRecord | null = null
  let stale = false
  let overflow = false

  const fold = (
    map: Map<string, BufferEntry>,
    rec: ChangeRecord,
  ): void => {
    const id = rec.id
    if (id === undefined) return
    const next = collapse(map.get(id), toEntry(rec))
    if (next === null) {
      map.delete(id)
      return
    }
    if (!map.has(id) && map.size >= cap) {
      // Map iteration is insertion-ordered, so the first key is the oldest
      // DISTINCT id. Loss is reported via `overflow`, never silent.
      const oldest = map.keys().next().value as string
      map.delete(oldest)
      overflow = true
    }
    map.set(id, next)
  }

  return {
    add(rec) {
      if (rec.op === 'page') {
        page = rec
        return
      }
      if (rec.op === 'select') {
        select = rec
        return
      }
      fold(
        rec.op.startsWith('style_') ? styles : nodes,
        rec,
      )
    },
    markIndexStale() {
      stale = true
    },
    size: () => nodes.size + styles.size,
    indexStale: () => stale,
    overflowed: () => overflow,
    drain() {
      const changes: ChangeRecord[] = []
      for (const [id, e] of nodes) {
        changes.push(toRecord(id, e))
      }
      for (const [id, e] of styles) {
        changes.push(toRecord(id, e))
      }
      if (page !== null) changes.push(page)
      if (select !== null) changes.push(select)
      const out = {
        changes,
        indexStale: stale,
        overflow,
      }
      nodes.clear()
      styles.clear()
      page = null
      select = null
      stale = false
      overflow = false
      return out
    },
  }
}
