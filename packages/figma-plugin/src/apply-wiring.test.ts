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

// B56 — repairScan can only name an export-served instance's main component
// from what the SEARCH case hands it: the export's `components` /
// `componentSets` maps, and a live resolver for the runtime that omits them.
// The pure side is fully tested in search-candidates.test.ts and would stay
// green with either dropped, and the server mock is a double — only a live
// search would notice `instancesOf` answering zero again, which is exactly how
// the first cut of this fix reached live verification and failed there.
const searchCase = ((): string => {
  const from = callers.indexOf(
    'const repaired = await repairScan(',
  )
  const to = callers.indexOf(
    'skipped.push(...repaired.warnings)',
  )
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('SEARCH repair wiring', () => {
  it('actually found the repairScan call (liveness)', () => {
    expect(searchCase.length).toBeGreaterThan(200)
    expect(searchCase).toContain('exportHost')
  })

  it('hints for component refs and supplies the resolver', () => {
    expect(searchCase).toContain(
      'componentRef: collectComponentRef',
    )
    expect(searchCase).toContain('componentRefOf')
    expect(searchCase).toContain('getNodeByIdAsync')
  })

  // The export is `{document, components, componentSets, …}`. Keeping only
  // `document` is what left a repaired INSTANCE holding a componentId with no
  // name for it — the maps are the primary source, the live resolver only the
  // fallback.
  it('keeps the export maps, not just the document', () => {
    expect(searchCase).toContain('raw.components')
    expect(searchCase).toContain('raw.componentSets')
  })

  // A variant's own name is `State=Error`; the family is named on the set, and
  // the set name is the one an operator writes.
  it('carries the family name on the live fallback too', () => {
    expect(searchCase).toContain('componentSetOf(')
  })
})

// M22a — the delete arm's honesty lives in component-properties.ts, which is
// pure and fully tested there. The server mock models the CONTRACT, not this
// code, so both stay green if the arm stops calling the resolver or stops
// re-reading the definitions. Only a live removal would notice.
const deleteArm = ((): string => {
  const from = callers.indexOf('// delete (M22a)')
  const to = callers.indexOf('// description', from)
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('UPDATE_COMPONENT delete-property wiring', () => {
  it('actually found the arm (liveness)', () => {
    expect(deleteArm.length).toBeGreaterThan(200)
    expect(deleteArm).toContain('deleteComponentProperty')
  })

  it('resolves the key, then VERIFIES the property is gone', () => {
    expect(deleteArm).toContain('resolvePropertyKey(')
    expect(deleteArm).toContain('undeletedMessage(')
    // The verify has to read the definitions AGAIN — checking the copy taken
    // before the delete would always agree with itself.
    expect(
      deleteArm.lastIndexOf(
        'comp.componentPropertyDefinitions',
      ),
    ).toBeGreaterThan(
      deleteArm.indexOf('comp.deleteComponentProperty('),
    )
  })

  it('never continues past a refusal as though it worked', () => {
    // Each of the three arms warns and then skips this entry.
    const continues = deleteArm.split('continue').length - 1
    expect(continues).toBe(2)
  })
})

// B58 — applyLayout reads every field back and names the ones that did not
// hold, but it can only report through the sink its caller passes. It was
// called with NO sink, so the notes had nowhere to go: the module's own tests
// stayed green and update_node kept answering ok with empty warnings.
//
// The deselect/restore mitigation has the same shape of blind spot, one step
// further out: it is fully unit-tested against a fake selection host, and it
// does nothing at all unless update_node hands over the REAL
// `figma.currentPage`. Drop that argument and every test here stays green while
// the live revert comes straight back.
describe('applyLayout call-site wiring', () => {
  const applyCall = callers.slice(
    callers.indexOf('applyLayout(\n'),
    callers.indexOf('// Min/max sizing'),
  )

  it('actually found the call (liveness)', () => {
    expect(applyCall.length).toBeGreaterThan(20)
    expect(applyCall).toContain('AppliedLayout')
  })

  it('hands applyLayout the warnings sink', () => {
    expect(applyCall).toContain('warnings')
  })

  it('hands applyLayout the selection host', () => {
    expect(applyCall).toContain('opts?.page')
  })

  const updateCase = callers.slice(
    callers.indexOf('case COMMANDS.UPDATE_NODE'),
    callers.indexOf('case COMMANDS.DELETE_NODE'),
  )

  it('update_node is the path that supplies the real page', () => {
    expect(updateCase.length).toBeGreaterThan(200)
    expect(updateCase).toContain('page: figma.currentPage')
  })

  // The restore runs after the reply, so `warnings` cannot carry its failure.
  // Without a notifier a failed restore leaves the user silently deselected.
  it('gives the deferred restore a failure channel', () => {
    expect(updateCase).toContain('onError')
    expect(updateCase).toContain('figma.notify')
  })

  // Passing a `defer` here would override the timer with whatever it names —
  // the production path must take the module's real deferral.
  it('does not override the deferral at the call site', () => {
    expect(updateCase).not.toContain('defer:')
  })

  // A create cannot have a user-selected target, and the slot loop writes a
  // node it made a moment ago. Neither should pay selection churn.
  it('the create and slot paths supply no page', () => {
    // A negative assertion has to prove it looked at something first: a slice
    // taken from a string that was not found would pass this vacuously.
    const createAt = callers.indexOf(
      'await applyCommonProperties(node, spec, parent, warnings)',
    )
    expect(createAt).toBeGreaterThan(0)
    expect(
      callers.slice(createAt, createAt + 80),
    ).not.toContain('page:')

    const slotApplyAt = slotLoop.indexOf(
      'applyCommonProperties(',
    )
    const slotPostAt = slotLoop.indexOf(
      'applyPostAppendProperties(',
    )
    expect(slotApplyAt).toBeGreaterThan(0)
    expect(slotPostAt).toBeGreaterThan(slotApplyAt)
    expect(
      slotLoop.slice(slotApplyAt, slotPostAt),
    ).not.toContain('page:')
  })
})

// B56 — and the path the live repro actually travelled. Both slot-nested
// instances read fine (whether a handle answers is session state, not shape),
// so their rows came from the LIVE candidate build, not from a repair. That
// build must carry the family name too, or `instancesOf:'State block'` answers
// zero on a document with nothing degraded about it at all.
const liveCandidateRef = ((): string => {
  const from = callers.indexOf('getMainComponentAsync()')
  const to = callers.indexOf('collectStyleId', from)
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('SEARCH live-candidate component ref wiring', () => {
  it('actually found the enrichment (liveness)', () => {
    expect(liveCandidateRef.length).toBeGreaterThan(100)
    expect(liveCandidateRef).toContain('instancesOf')
  })

  it('emits the family name beside the main component name', () => {
    expect(liveCandidateRef).toContain('componentSetOf(')
    expect(liveCandidateRef).toContain('instancesOfSet')
  })
})
