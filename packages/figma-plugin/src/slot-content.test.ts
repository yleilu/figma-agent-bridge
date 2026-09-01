// slot-content.test.ts — B84: a delete takes the slot's content with it.
//
// THE LIVE FAILURE (2026-09-01, dev 9d306cf). `clone_node` made a Chart-card
// INSTANCE `570:21813` whose `Body` slot held a table
// (`I570:21813;570:20826;570:21817`). `delete_node(570:21813)` answered ok with
// no warnings, and the table was still on the screen — re-parented into the
// containing Content column, addressed `570:21831` by the file, and answering
// `I570:21813;570:20826;570:21817` on every live handle. `delete_node`,
// `update_node` and `set_selection` all failed on that dead address; deleting
// its children failed one level deeper. There was no id that worked, and the
// only escape was to build a sibling container, move six blocks into it one by
// one, and delete the original parent so the cascade caught the orphan.
//
// WHAT THE FAKE MODELS, AND ON WHAT AUTHORITY:
//   observed — a SLOT inside an INSTANCE answers `type: 'SLOT'` and lists the
//              content as its children (12 of them in the 2026-09-01 Overview
//              readback, e.g. `Actions` → `I570:20888;570:20878;570:20971`).
//   observed — content appended into a slot SURVIVES its instance's removal
//              (the failure above).
//   modelled — the master's own default slot content is a mirror Figma refuses
//              to `remove()` on its own. Figma refuses every other structural
//              edit of an instance sublayer (B46: a sublayer resize is refused;
//              I66: the ceiling on writes into instance sublayers), so this is
//              consistent with the surface's own live findings rather than
//              directly observed. The fix does not depend on being right about
//              it: a refusal costs nothing, because the instance's own removal
//              takes that node a moment later.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  removeSlotContent,
  slotContentIn,
  slotContentRemovedMessage,
} from './slot-content'
import type { LiveNode } from './canonical-ids'

type Fake = LiveNode & {
  id: string
  name: string
  type: string
  children?: Fake[]
  /** A master mirror: Figma refuses to remove it on its own. */
  sealed?: boolean
  /** Set by a successful `remove()`. */
  gone?: boolean
}

const node = (f: Omit<Fake, 'remove'>): Fake => {
  const handle = {
    ...f,
    remove(): void {
      if (f.sealed === true) {
        throw new Error(
          'in remove: Cannot remove a sublayer of an instance',
        )
      }
      handle.gone = true
    },
  } as Fake
  return handle
}

/** The Chart card, as the live artifact had it. */
const chartCard = () => {
  const table = node({
    id: 'I570:21813;570:20826;570:21817',
    name: 'Table',
    type: 'FRAME',
    children: [
      node({
        id: 'I570:21813;570:20826;570:21817;570:1',
        name: 'Row',
        type: 'INSTANCE',
      }),
    ],
  })
  const defaultLabel = node({
    id: 'I570:21813;570:20827',
    name: 'Empty',
    type: 'TEXT',
    sealed: true,
  })
  const body = node({
    id: 'I570:21813;570:20826',
    name: 'Body',
    type: 'SLOT',
    children: [table, defaultLabel],
  })
  const header = node({
    id: 'I570:21813;570:20824',
    name: 'Header',
    type: 'FRAME',
    sealed: true,
  })
  const card = node({
    id: '570:21813',
    name: 'Chart card',
    type: 'INSTANCE',
    children: [header, body],
  })
  return { card, table, defaultLabel, header, body }
}

describe('slotContentIn', () => {
  it('finds what a slot holds, and nothing else', () => {
    const { card, table, defaultLabel } = chartCard()
    expect(slotContentIn(card)).toEqual([
      table,
      defaultLabel,
    ])
  })

  it('does not re-enter content it already claimed', () => {
    const { card } = chartCard()
    // The row INSIDE the table is covered by the table itself; listing it
    // separately would try to remove a node whose parent is already gone.
    expect(
      slotContentIn(card).map(n => (n as Fake).name),
    ).not.toContain('Row')
  })

  it('takes the content of a SLOT passed as the root', () => {
    const { body, table } = chartCard()
    expect(slotContentIn(body)[0]).toBe(table)
  })

  it('is empty for a node with no slot under it', () => {
    expect(
      slotContentIn(
        node({
          id: '1:1',
          name: 'Frame',
          type: 'FRAME',
          children: [
            node({ id: '1:2', name: 'Kid', type: 'TEXT' }),
          ],
        }),
      ),
    ).toEqual([])
  })

  it('survives a handle that refuses to say what it is', () => {
    const broken: LiveNode = { name: 'stale' }
    Object.defineProperty(broken, 'type', {
      get() {
        throw new Error(
          'in get_type: The node with id "I3:1;4:5" does not exist',
        )
      },
      enumerable: true,
    })
    expect(
      slotContentIn(
        node({
          id: '1:1',
          name: 'Frame',
          type: 'FRAME',
          children: [broken as Fake],
        }),
      ),
    ).toEqual([])
  })
})

describe('removeSlotContent', () => {
  it('removes the appended content and reports it', () => {
    const { card, table } = chartCard()
    const removed = removeSlotContent(card)
    expect(table.gone).toBe(true)
    expect(removed).toEqual([
      {
        id: 'I570:21813;570:20826;570:21817',
        name: 'Table',
        type: 'FRAME',
      },
    ])
  })

  it('never claims a node Figma refused to remove', () => {
    const { card, defaultLabel } = chartCard()
    const removed = removeSlotContent(card)
    expect(defaultLabel.gone).toBeUndefined()
    expect(removed.map(r => r.name)).not.toContain('Empty')
  })

  it('leaves everything outside a slot alone', () => {
    const { card, header } = chartCard()
    removeSlotContent(card)
    expect(header.gone).toBeUndefined()
    expect((card as Fake).gone).toBeUndefined()
  })
})

describe('slotContentRemovedMessage', () => {
  it('names what went and how to keep it next time', () => {
    const message = slotContentRemovedMessage([
      {
        id: 'I570:21813;570:20826;570:21817',
        name: 'Table',
        type: 'FRAME',
      },
    ])
    expect(message).toContain('Table')
    expect(message).toContain(
      'I570:21813;570:20826;570:21817',
    )
    expect(message).toContain('Reparent')
  })

  it('counts the rest rather than listing them all', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: '5:' + i,
      name: 'Row ' + i,
      type: 'INSTANCE',
    }))
    const message = slotContentRemovedMessage(many)
    expect(message).toContain('removed 9 node(s)')
    expect(message).toContain('and 4 more')
    expect(message).not.toContain('Row 8')
  })
})

// `code.ts` calls `figma.showUI(__html__)` at module scope, so it cannot be
// imported outside Figma — the house pattern is a source scan with its own
// liveness assertions (apply-wiring.test.ts, search-scan.test.ts).
describe('DELETE_NODE wiring', () => {
  const source =
    // eslint-disable-next-line n/no-sync -- test-only source scan
    readFileSync(join(import.meta.dir, 'code.ts'), 'utf8')
  const deleteCase = source.slice(
    source.indexOf('case COMMANDS.DELETE_NODE'),
    source.indexOf('case COMMANDS.SET_FOCUS'),
  )

  it('actually found the case (liveness)', () => {
    expect(deleteCase.length).toBeGreaterThan(200)
    expect(deleteCase.length).toBeLessThan(source.length)
    expect(deleteCase).toContain('node.remove()')
  })

  it('clears the slot content BEFORE the node goes', () => {
    const clear = deleteCase.indexOf('removeSlotContent(')
    const remove = deleteCase.lastIndexOf('node.remove()')
    expect(clear).toBeGreaterThan(-1)
    // Order is the whole fix: the content is reachable only while its
    // instance still stands.
    expect(clear).toBeLessThan(remove)
  })

  it('says what it took', () => {
    expect(deleteCase).toContain(
      'slotContentRemovedMessage(',
    )
  })
})
