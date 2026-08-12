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
