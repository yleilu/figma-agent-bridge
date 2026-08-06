import { describe, expect, it } from 'bun:test'
import {
  type RemovableNode,
  rollbackCreated,
} from './rollback'

// A stand-in for a live Figma node, plus the lookup a document would answer
// with. `gone` ids resolve to null the way a removed node does.
const makeDoc = (
  ids: string[],
  opts: { refuse?: string[] } = {},
) => {
  const removed: string[] = []
  const nodes = new Map<string, RemovableNode>()
  for (const id of ids) {
    nodes.set(id, {
      get removed() {
        return removed.includes(id)
      },
      remove: () => {
        if (opts.refuse?.includes(id)) {
          throw new Error('cannot remove ' + id)
        }
        removed.push(id)
      },
    })
  }
  return {
    removed,
    getNodeById: async (id: string) =>
      removed.includes(id) ? null : (nodes.get(id) ?? null),
  }
}

describe('rollbackCreated', () => {
  it('removes every id it was given', async () => {
    const doc = makeDoc(['root', 'a', 'b'])
    const stranded = await rollbackCreated(
      ['root', 'a', 'b'],
      doc.getNodeById,
    )
    expect(stranded).toEqual([])
    expect(doc.removed.sort()).toEqual(['a', 'b', 'root'])
  })

  it('removes deepest-first, so an ancestor never orphans an id', async () => {
    const doc = makeDoc(['root', 'a', 'b'])
    await rollbackCreated(
      ['root', 'a', 'b'],
      doc.getNodeById,
    )
    // Creation order is root-first; removal is its reverse.
    expect(doc.removed).toEqual(['b', 'a', 'root'])
  })

  it('treats an already-gone id as done, not as a failure', async () => {
    // Only `root` still exists — the children went with an earlier removal.
    const doc = makeDoc(['root'])
    const stranded = await rollbackCreated(
      ['root', 'a', 'b'],
      doc.getNodeById,
    )
    expect(stranded).toEqual([])
    expect(doc.removed).toEqual(['root'])
  })

  it('treats a node flagged removed as done', async () => {
    const node: RemovableNode = {
      removed: true,
      remove: () => {
        throw new Error('should not be called')
      },
    }
    const stranded = await rollbackCreated(
      ['x'],
      async () => node,
    )
    expect(stranded).toEqual([])
  })

  it('reports what it could not remove and keeps sweeping', async () => {
    const doc = makeDoc(['root', 'a', 'b'], {
      refuse: ['a'],
    })
    const stranded = await rollbackCreated(
      ['root', 'a', 'b'],
      doc.getNodeById,
    )
    expect(stranded).toEqual(['a'])
    // The refusal did not abort the rest.
    expect(doc.removed).toEqual(['b', 'root'])
  })

  it('reports an id whose lookup itself throws', async () => {
    const stranded = await rollbackCreated(
      ['x'],
      async () => {
        throw new Error('lookup exploded')
      },
    )
    expect(stranded).toEqual(['x'])
  })

  it('does nothing for an empty ledger', async () => {
    let looked = 0
    const stranded = await rollbackCreated([], async () => {
      looked++
      return null
    })
    expect(stranded).toEqual([])
    expect(looked).toBe(0)
  })
})
