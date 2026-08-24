// apply-wiring.test.ts — the field appliers are actually CALLED.
//
// `apply-node-fields.ts` is unit-testable precisely because it is free of the
// figma runtime, and that is also its blind spot: every one of its helpers can
// be perfectly tested while `code.ts` never calls it. Deleting a call site is
// then a silent no-op — the helper's own tests stay green, the mock (a SERVER
// test double) never sees the plugin at all, and only a live Figma session
// notices that the write stopped landing. B27 was found this way: the whole
// per-side stroke path was green with the call site removed.
//
// `code.ts` cannot be imported to check this properly — it calls
// `figma.showUI(__html__)` at module scope, so importing it outside Figma
// throws — hence a source scan, in the shape of the server's
// error-envelope-guard: an empty offender list is the PASS value, so this file
// carries its own liveness assertions rather than looking identical to a
// scanner that read nothing.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (name: string): string =>
  // eslint-disable-next-line n/no-sync -- test-only source scan
  readFileSync(join(import.meta.dir, name), 'utf8')

const helpers = read('apply-node-fields.ts')
const callers = read('code.ts')

/** Every `applyX` this module exports. */
const exported = [
  ...helpers.matchAll(/export const (apply\w+) =/g),
].map(m => m[1])

/** Called — `applyX(`, which an import line (`applyX,`) is not. */
const isCalled = (name: string, src: string): boolean =>
  src.includes(name + '(')

describe('apply-node-fields wiring', () => {
  it('actually found the helpers (liveness)', () => {
    expect(exported.length).toBeGreaterThanOrEqual(4)
    expect(exported).toContain('applyStrokeWeights')
  })

  it('tells a call from an import (liveness)', () => {
    expect(
      isCalled('applyGrids', 'applyGrids(node, g)'),
    ).toBe(true)
    expect(
      isCalled('applyGrids', '  applyGrids,\n} from "./x"'),
    ).toBe(false)
  })

  it('code.ts calls every one of them', () => {
    expect(
      exported.filter(name => !isCalled(name, callers)),
    ).toEqual([])
  })
})

// B30 — the same blind spot, one level in: the slot loop can lose its apply
// calls and stay green everywhere (the server would still convert the spec,
// the mock would still model the apply, and only a live slot would come back
// white and 100×100). So scan the loop ITSELF, not just the file.
const slotLoop = ((): string => {
  const from = callers.indexOf('compWithSlot.createSlot!()')
  const to = callers.indexOf(
    'case COMMANDS.COMBINE_VARIANTS',
  )
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('UPDATE_COMPONENT slot-spec wiring', () => {
  it('actually found the slot loop (liveness)', () => {
    expect(slotLoop.length).toBeGreaterThan(200)
    expect(slotLoop.length).toBeLessThan(callers.length)
    expect(slotLoop).toContain('slotsCreated')
  })

  it('applies a slot entry spec through the standard pipeline', () => {
    for (const applier of [
      'applyCommonProperties(',
      'applyPostAppendProperties(',
      'applyWrapperBindings(',
      // T7: and names what the slot could not carry, as update_node does.
      'capabilityWarnings(',
    ]) {
      expect(slotLoop).toContain(applier)
    }
  })

  it('runs the capability check on BOTH targets that can be any node type', () => {
    // update_node and the slot loop. `capabilityWarnings` returns rather than
    // pushes, so a dropped call site loses the warnings with nothing failing.
    const calls =
      callers.split('capabilityWarnings(').length - 1
    expect(calls).toBe(2)
  })

  it('counts the slot created BEFORE anything that can fail without un-creating it', () => {
    // createSlot() alone decides created-vs-skipped: naming, claiming and the
    // spec apply all run after it on a node that already exists, so reporting
    // one of those failures as SKIPPED would send the agent looking for a node
    // that is really there. Runtime-only ordering — nothing else pins it.
    expect(
      slotLoop.indexOf('slotsCreated.push'),
    ).toBeLessThan(slotLoop.indexOf('slot.name = name'))
  })

  it('hands the appliers a LOCAL sink, so each degrade can name its slot', () => {
    // Pushing straight into the reply's `ucWarnings` would emit N identical
    // strings for N slots failing the same way — the spec promises the slot's
    // name on every note, and only the call site knows it.
    const applyBlock = slotLoop.slice(
      slotLoop.indexOf('applyCommonProperties('),
      slotLoop.indexOf('capabilityWarnings('),
    )
    expect(applyBlock.length).toBeGreaterThan(100)
    expect(applyBlock).toContain('slotWarnings')
    expect(applyBlock).not.toContain('ucWarnings')
    expect(slotLoop).toContain("'slot \"' + name")
  })
})

// B55 — reparent_node's position preservation is pure and unit-tested in
// reparent-position.test.ts, which is exactly the blind spot above: the math
// can be perfect while the case never calls it, and only a live reparent
// notices the node jumping to the canvas origin.
const reparentCase = ((): string => {
  const from = callers.indexOf(
    'case COMMANDS.REPARENT_NODE',
  )
  const to = callers.indexOf(
    'case COMMANDS.REORDER_CHILDREN',
  )
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('REPARENT_NODE position wiring', () => {
  it('actually found the case (liveness)', () => {
    expect(reparentCase.length).toBeGreaterThan(200)
    expect(reparentCase.length).toBeLessThan(callers.length)
    expect(reparentCase).toContain('appendChild')
  })

  it('reads the child origin BEFORE the move and re-places it after', () => {
    expect(reparentCase).toContain('originOf(')
    expect(reparentCase).toContain('reparentPlacement(')
    // Order matters: the parent-relative x/y the origin is derived from is
    // reinterpreted the instant the node changes parent.
    const theMove = reparentCase.indexOf(
      'parent.appendChild(child)',
    )
    expect(theMove).toBeGreaterThan(0)
    expect(reparentCase.indexOf('originOf(')).toBeLessThan(
      theMove,
    )
    expect(
      reparentCase.indexOf('reparentPlacement('),
    ).toBeGreaterThan(theMove)
  })
})
