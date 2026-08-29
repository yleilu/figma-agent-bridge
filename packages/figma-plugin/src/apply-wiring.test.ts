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

/** Source with comments removed — a scan must not trip over its own prose. */
const codeOf = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

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

  // I60 — the placement is pure (slot-entries.ts) and fully tested there, which
  // is this file's whole subject: the check can be perfect while the loop never
  // calls it, and a `parentId` would then be accepted, converted, sent, and
  // dropped in silence. Only a live component would notice the slot at the root.
  it('places the slot through the shared refusal check', () => {
    expect(slotLoop).toContain('slotParentRefusal(')
    expect(slotLoop).toContain('spec?.parentId')
    expect(slotLoop).toContain('appendChild(')
  })

  it('moves the slot BEFORE its spec is applied', () => {
    // A layout written to a node still at the component root is written against
    // the wrong parent — the same order B59 had to fix for the clamps.
    const thePlacement = slotLoop.indexOf(
      'slotParentRefusal(',
    )
    const theSpec = slotLoop.indexOf(
      'applyCommonProperties(',
    )
    expect(thePlacement).toBeGreaterThan(0)
    expect(theSpec).toBeGreaterThan(thePlacement)
  })

  it('reports a refused placement to the slot’s OWN sink', () => {
    // Attributed by name like every other slot note: N slots refused the same
    // way would otherwise emit N identical strings.
    const placement = slotLoop.slice(
      slotLoop.indexOf('slotParentRefusal('),
      slotLoop.indexOf('applyCommonProperties('),
    )
    expect(placement).toContain('slotWarnings')
    expect(placement).not.toContain('ucWarnings')
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

// B59 / B60 — the two writes Figma judges against a node's PARENT. Both are
// pure and unit-tested in apply-node-fields.test.ts, and both were wrong here:
// a clamp applied while the fresh node was still parented to the page, and a
// FILL collapse applied before the node had the children the collapse was
// supposed to re-anchor. Only the ORDER in this file decides either one, and
// only a live create would notice — the mock is a SERVER double and never runs
// this code at all.
//
// Comments are stripped first: the prose right above each call site names the
// very calls being ordered, and a scan that read its own explanation would
// pass on a file that does nothing.
const code = codeOf(callers)

const between = (from: string, to: string): string => {
  const start = code.indexOf(from)
  const end = code.indexOf(to)
  return start === -1 || end === -1
    ? ''
    : code.slice(start, end)
}

const commonApply = between(
  'const applyCommonProperties = async (',
  'const applyPostAppendProperties = (',
)
const postAppendApply = between(
  'const applyPostAppendProperties = (',
  'const setRangeProperty = (',
)
const buildSingle = between(
  'const buildSingleNode = async (',
  'const createSingleNode = async (',
)
const treeBuilder = between(
  'const createTreeNode = async (',
  'const applyVariableMeta = async (',
)

describe('min/max clamp wiring (B59)', () => {
  it('actually found both appliers (liveness)', () => {
    expect(commonApply.length).toBeGreaterThan(200)
    expect(commonApply).toContain('applyLayout(')
    expect(postAppendApply.length).toBeGreaterThan(200)
    expect(postAppendApply).toContain('constraints')
  })

  it('never writes a clamp before the node has its real parent', () => {
    // Figma answers "Can only set maxWidth on auto layout nodes and their
    // children" — and until appendChild the parent is whatever page Figma
    // auto-parented the fresh node to. Neither the helper nor a raw assign
    // belongs on the pre-append path.
    expect(commonApply).not.toContain('applyMinMax(')
    for (const field of [
      'minWidth',
      'maxWidth',
      'minHeight',
      'maxHeight',
    ]) {
      expect(commonApply).not.toContain(field)
    }
  })

  it('writes the clamps post-append, where the parent is the one the spec named', () => {
    expect(postAppendApply).toContain('applyMinMax(')
    // …and that applier only ever runs after the append.
    expect(buildSingle.length).toBeGreaterThan(200)
    const theAppend = buildSingle.indexOf(
      'parent.appendChild(node)',
    )
    expect(theAppend).toBeGreaterThan(0)
    expect(
      buildSingle.indexOf('applyPostAppendProperties('),
    ).toBeGreaterThan(theAppend)
  })
})

describe('create_tree sizing order (B60)', () => {
  it('actually found the tree builder (liveness)', () => {
    expect(treeBuilder.length).toBeGreaterThan(200)
    expect(treeBuilder).toContain('createSingleNode(')
    expect(treeBuilder).toContain(
      'for (const childSpec of children',
    )
  })

  it('defers a parent’s own FILL/HUG resize while its subtree is built', () => {
    // A FILL or HUG axis makes Figma resize the node. Applied at the node's
    // own append — before its children exist — the collapse happens behind
    // their back and no constraint of theirs is ever re-anchored by it. A LEAF
    // defers nothing: it has no children to place, so its sizing stays exactly
    // where every other caller writes it.
    expect(postAppendApply).toContain('deferSizing')
    expect(treeBuilder).toContain(
      'deferSizing: hasChildren',
    )
  })

  it('applies the deferred sizing AFTER the children are placed and constrained', () => {
    const theLoop = treeBuilder.indexOf(
      'for (const childSpec of children',
    )
    const theResize = treeBuilder.indexOf('applySizing(')
    expect(theLoop).toBeGreaterThan(0)
    expect(theResize).toBeGreaterThan(theLoop)
    // …and the placement report is read after the resize, so the x/y it
    // judges each child on is the one that child ended the level with.
    expect(
      treeBuilder.indexOf('discardedPositionsWarning('),
    ).toBeGreaterThan(theResize)
  })

  it('leaves the child’s own constraints where they were: post-append, pre-resize', () => {
    // The re-anchor Figma performs on the parent's collapse reads constraints
    // that are already on the child. They are written by
    // applyPostAppendProperties, which runs inside the child's own build.
    expect(postAppendApply).toContain('spec.constraints')
    expect(buildSingle).toContain(
      'applyPostAppendProperties(',
    )
  })
})

// B61 — the create paths owe the same answer update has given since B46, and
// `verifyCreatedSize` is pure: it can be perfect while neither create path ever
// calls it, and the reply then carries no `warnings` key at all — which is the
// exact silence B61 is. WHERE it is called decides whether it is even true: a
// parent judged before its subtree is built, or before its deferred FILL/HUG
// collapse (B60), would report every hugging frame as a failure.
describe('created-size verification wiring (B61)', () => {
  it('judges a LEAF only after its sizing is written', () => {
    expect(buildSingle).toContain('verifyCreatedSize(')
    const theSizing = buildSingle.indexOf(
      'applyPostAppendProperties(',
    )
    expect(theSizing).toBeGreaterThan(0)
    expect(
      buildSingle.indexOf('verifyCreatedSize('),
    ).toBeGreaterThan(theSizing)
  })

  it('leaves a DEFERRED node to its caller', () => {
    // Judging it here would measure the box between the node's own append and
    // the children that decide it.
    expect(buildSingle).toContain(
      'opts?.deferSizing !== true',
    )
  })

  it('judges a parent after the deferred collapse AND after its children', () => {
    expect(treeBuilder).toContain('verifyCreatedSize(')
    const theResize = treeBuilder.indexOf('applySizing(')
    const theLoop = treeBuilder.indexOf(
      'for (const childSpec of children',
    )
    expect(theResize).toBeGreaterThan(theLoop)
    expect(
      treeBuilder.indexOf('verifyCreatedSize('),
    ).toBeGreaterThan(theResize)
  })

  it('hands it the spec’s own sizing, so a self-contradiction is named as one', () => {
    // Without `spec.sizing` the message advises a pin the spec already refused.
    for (const site of [buildSingle, treeBuilder]) {
      const call = site.slice(
        site.indexOf('verifyCreatedSize('),
        site.indexOf('verifyCreatedSize(') + 200,
      )
      expect(call).toContain('spec.size')
      expect(call).toContain('spec.sizing')
    }
  })
})

// I59 — a gradient STOP binds through a VariableAlias, and the factory that
// mints one is a DEP. `bind-wrappers.ts` is fully tested against a fake that
// supplies it, so every one of those tests stays green on a `paintBindDeps()`
// that hands over nothing — and live, every stop binding degrades to "the
// literal colour is applied" with the token silently lost.
describe('gradient-stop binding wiring (I59)', () => {
  const paintDeps = between(
    'const paintBindDeps = (',
    'const wrapperBindDeps = (',
  )

  it('actually found the deps (liveness)', () => {
    expect(paintDeps.length).toBeGreaterThan(100)
    expect(paintDeps).toContain('setBoundVariableForPaint')
  })

  it('supplies the alias factory from the real Figma API', () => {
    expect(paintDeps).toContain('createVariableAlias')
    expect(paintDeps).toContain('figma.variables')
  })

  // `bind_variable` and the inline route share one deps builder, so the stop
  // route cannot be present on one and missing on the other.
  it('hands the SAME deps to the inline-wrapper binder', () => {
    const wrapperDeps = between(
      'const wrapperBindDeps = (',
      'const readDepth = (',
    )
    expect(wrapperDeps).toContain('...paintBindDeps()')
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
// B58 — applyLayout reads every field back and names the ones that did not
// hold, but it can only report through the sink its caller passes. It was
// called with NO sink, so the notes had nowhere to go: the module's own tests
// stayed green and update_node kept answering ok with empty warnings.
describe('applyLayout call-site wiring', () => {
  const applyCall = callers.slice(
    callers.indexOf('applyLayout(\n'),
    // The clamps used to close this block and moved to the post-append
    // applier (B59); the grids are what follows the layout write now.
    callers.indexOf('// Layout grids.'),
  )

  it('actually found the call (liveness)', () => {
    expect(applyCall.length).toBeGreaterThan(20)
    expect(applyCall.length).toBeLessThan(1000)
    expect(applyCall).toContain('AppliedLayout')
  })

  it('hands applyLayout the warnings sink', () => {
    expect(applyCall).toContain('warnings')
  })

  // Rounds 2-4 deselected the target, waited for the deselection to render,
  // and restored the selection afterwards — all chasing a trigger that turned
  // out to be the var-bound gap, not the selection. A plain literal gap writes
  // fine under a live selection. None of that machinery should return by
  // accident: it blinked the user's selection on every layout write, for
  // nothing.
  it('manipulates no selection in the layout write path', () => {
    // Comments are stripped first: this file's own history notes describe the
    // machinery that was removed, and a scan that tripped over the explanation
    // of a fix would be unmaintainable.
    const applierCode = codeOf(read('apply-layout.ts'))
    const callerCode = codeOf(callers)
    expect(applierCode).not.toContain('selection')
    for (const trace of ['SelectionGuard', 'deselect']) {
      expect(callerCode).not.toContain(trace)
      expect(applierCode).not.toContain(trace)
    }
    // Liveness, twice over: `set_selection` is a real tool that legitimately
    // assigns the selection, so the stripper has to leave real code alone —
    // and this assertion proves the scan read something.
    expect(callerCode).toContain(
      'figma.currentPage.selection = nodes',
    )
  })
})

// B58's REAL fix — the pair guard. The plugin half answers what only the live
// node can, and it is pure, so it would stay green with both call sites
// deleted. Only a live write would notice the guard had stopped running.
const bindCase = callers.slice(
  callers.indexOf('case COMMANDS.BIND_VARIABLE'),
  callers.indexOf('case COMMANDS.GET_VARIABLES'),
)

describe('SPACE_BETWEEN gap-guard wiring', () => {
  it('update_node refuses the pair BEFORE applying anything', () => {
    const updateCase = callers.slice(
      callers.indexOf('case COMMANDS.UPDATE_NODE'),
      callers.indexOf('case COMMANDS.DELETE_NODE'),
    )
    expect(updateCase.length).toBeGreaterThan(200)
    expect(updateCase).toContain('updateLayoutConflict(')
    // Before the apply, or a refused write has already changed the node.
    expect(
      updateCase.indexOf('updateLayoutConflict('),
    ).toBeLessThan(
      updateCase.indexOf('applyCommonProperties('),
    )
  })

  it('bind_variable refuses binding the gap of a SPACE_BETWEEN node', () => {
    expect(bindCase.length).toBeGreaterThan(200)
    expect(bindCase).toContain('bindFieldConflict(')
  })
})

// B58 — the guard's own advice depends on this branch existing. It tells a
// caller with an already-bound gap to clear the token first; if the clear
// silently fell through to the ordinary binding path it would fail on a
// missing `variableId`, and the instruction would be a dead end.
describe('bind_variable clear wiring', () => {
  it('has a clear branch that unbinds', () => {
    expect(bindCase).toContain('params.clear === true')
    expect(bindCase).toContain('clearNodeField(')
  })

  it('clears BEFORE looking a variable up — a clear names none', () => {
    expect(
      bindCase.indexOf('params.clear === true'),
    ).toBeLessThan(bindCase.indexOf('getVariableByIdAsync'))
  })
})

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

// B66 — the same blind spot as the slot loop. `variable-shadowing.ts` is pure
// and fully tested, and every one of its tests stays green with the call site
// deleted. Only a live file holding two collections with one name would notice,
// which is exactly the situation the warning exists for.
const createVariablesCase = ((): string => {
  const from = callers.indexOf(
    'case COMMANDS.CREATE_VARIABLES',
  )
  const to = callers.indexOf(
    'case COMMANDS.UPDATE_VARIABLES',
    from,
  )
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('CREATE_VARIABLES shadow-name wiring', () => {
  it('actually found the case (liveness)', () => {
    expect(createVariablesCase.length).toBeGreaterThan(200)
    expect(createVariablesCase).toContain(
      'createVariableCollection',
    )
  })

  it('reports a created name another collection already holds', () => {
    expect(createVariablesCase).toContain(
      'otherCollectionsHolding(',
    )
    expect(createVariablesCase).toContain(
      'createShadowWarning(',
    )
  })

  it('snapshots the file BEFORE the collection exists', () => {
    // Taken afterwards, the new collection's own variables are in the list and
    // every created name shadows itself.
    expect(
      createVariablesCase.indexOf(
        'localVariablesSnapshot()',
      ),
    ).toBeLessThan(
      createVariablesCase.indexOf(
        'vars.createVariableCollection(',
      ),
    )
  })
})

// B69 — the deferred collapse is an ORDER, and the order is the fix. Nothing
// but a live create_tree can tell that `repinFixedSize` moved after the sizing
// and before the verify: the helper's own tests pass wherever it is called
// from, and a call site that drifted one line up would silently restore the
// pre-hug box and then let the hug eat it again.
const deferredCollapse = ((): string => {
  const from = callers.indexOf(
    'The deferred FILL/HUG resize.',
  )
  const to = callers.indexOf('childPlacements.length', from)
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('create_tree deferred-sizing wiring', () => {
  it('actually found the collapse (liveness)', () => {
    expect(deferredCollapse.length).toBeGreaterThan(200)
    expect(deferredCollapse).toContain('applySizing(')
  })

  it('re-applies the stated size AFTER the sizing and BEFORE the verify', () => {
    const sizing = deferredCollapse.indexOf('applySizing(')
    const repin = deferredCollapse.indexOf(
      'repinFixedSize(',
    )
    const verify = deferredCollapse.indexOf(
      'verifyCreatedSize(',
    )
    expect(sizing).toBeGreaterThanOrEqual(0)
    expect(repin).toBeGreaterThan(sizing)
    expect(verify).toBeGreaterThan(repin)
  })
})

// B70 — the mock accepts any string for an INSTANCE_SWAP defaultValue, so a
// headless test of the whole path proves nothing about the currency Figma
// wants. `instanceSwapKey` is pure and covered; that it is REACHED on both
// arms of update_component is what only a scan can hold.
const updateComponentCase = ((): string => {
  const from = callers.indexOf(
    'case COMMANDS.UPDATE_COMPONENT',
  )
  const to = callers.indexOf(
    'case COMMANDS.COMBINE_VARIANTS',
    from,
  )
  return from === -1 || to === -1
    ? ''
    : callers.slice(from, to)
})()

describe('INSTANCE_SWAP default currency wiring', () => {
  it('actually found the case (liveness)', () => {
    expect(updateComponentCase.length).toBeGreaterThan(200)
    expect(updateComponentCase).toContain(
      'addComponentProperty(',
    )
  })

  it('resolves the default on BOTH arms — add and edit', () => {
    const calls =
      updateComponentCase.split('resolveSwapDefault(')
        .length - 1
    expect(calls).toBe(2)
  })

  it('resolves BEFORE Figma sees the value', () => {
    expect(
      updateComponentCase.indexOf('resolveSwapDefault('),
    ).toBeLessThan(
      updateComponentCase.indexOf('editComponentProperty('),
    )
  })
})

describe('inline var() value-mismatch wiring', () => {
  it('hands the binder the shadow lookup it reports with', () => {
    // `variableShadows` is optional on the deps, so a dropped wiring degrades
    // to a mismatch warning that names no collection — green everywhere, and
    // half the message gone.
    expect(callers).toContain(
      'variableShadows: bindingLookups.variableShadows',
    )
    expect(callers).toContain('listCollections:')
  })
})
