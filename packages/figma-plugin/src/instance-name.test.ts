// instance-name.test.ts — I91: a swap must not leave the layer tree naming a
// variant the instance no longer holds.
//
// THE LIVE FINDING (2026-09-03, two reviewers independently). Six instances on
// one build carried a name contradicting their variant:
//
//   `Status chip/Confirmed`  holding Tone=Warning,   rendering PENDING
//   `Status chip/Active` ×2  rendering PAUSED and FLAGGED
//   `Chain pill/Ethereum` ×3 rendering OPTIMISM, OPTIMISM and BASE
//
// Text, paint and variantProperties were all correct. Only the name lied. The
// build made 21 `swap_component` calls. Naming legibility is a scored dimension
// of the reviewer skill, and a lying layer name is exactly what it is meant to
// catch — so the tool that created the lie has to answer for it.
//
// THE DISCRIMINATION THAT MATTERS. A name the CALLER authored ("Primary CTA")
// is a deliberate choice and must survive a swap untouched; a name Figma or
// this surface DERIVED from the old variant is a stale fact and must not. So
// the old name is matched against the templates a derived name can take, and
// only a match is rewritten — through the same template, off the new variant.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  renameOnSwap,
  swapRenameMessage,
  variantValuesOf,
} from './instance-name'

const statusChip = (value: string) => ({
  name: 'Tone=' + value,
  setName: 'Status chip',
})

describe('I91 — reading a variant component', () => {
  it('takes the VALUES out of a variant name, in order', () => {
    expect(variantValuesOf('Tone=Confirmed')).toEqual([
      'Confirmed',
    ])
    expect(
      variantValuesOf('Chain=Optimism, Size=Small'),
    ).toEqual(['Optimism', 'Small'])
  })

  it('answers nothing for a plain component name', () => {
    expect(variantValuesOf('Chart card')).toBeUndefined()
    expect(variantValuesOf('')).toBeUndefined()
  })
})

describe('I91 — a derived name follows the new variant', () => {
  it('rewrites the live case: Status chip/Confirmed → Status chip/Warning', () => {
    expect(
      renameOnSwap({
        before: 'Status chip/Confirmed',
        from: statusChip('Confirmed'),
        to: statusChip('Warning'),
      }),
    ).toBe('Status chip/Warning')
  })

  it('rewrites the other live case: Chain pill/Ethereum → Chain pill/Optimism', () => {
    expect(
      renameOnSwap({
        before: 'Chain pill/Ethereum',
        from: { name: 'Chain=Ethereum', setName: 'Chain pill' },
        to: { name: 'Chain=Optimism', setName: 'Chain pill' },
      }),
    ).toBe('Chain pill/Optimism')
  })

  it('rewrites a name that is the master’s own, set or no set', () => {
    expect(
      renameOnSwap({
        before: 'Tone=Confirmed',
        from: statusChip('Confirmed'),
        to: statusChip('Warning'),
      }),
    ).toBe('Tone=Warning')
    expect(
      renameOnSwap({
        before: 'Old card',
        from: { name: 'Old card' },
        to: { name: 'New card' },
      }),
    ).toBe('New card')
  })

  it('rewrites the set/name spelling too', () => {
    expect(
      renameOnSwap({
        before: 'Status chip/Tone=Confirmed',
        from: statusChip('Confirmed'),
        to: statusChip('Warning'),
      }),
    ).toBe('Status chip/Tone=Warning')
  })
})

describe('I91 — what a swap must NOT touch', () => {
  it('leaves a name the caller authored alone — a deliberate choice is not a stale fact', () => {
    expect(
      renameOnSwap({
        before: 'Primary CTA',
        from: statusChip('Confirmed'),
        to: statusChip('Warning'),
      }),
    ).toBeUndefined()
  })

  it('says nothing when the name would not change', () => {
    // Swapping between two variants of one set leaves the SET name identical,
    // so a name that is only the set name is not stale and renaming is a no-op.
    expect(
      renameOnSwap({
        before: 'Status chip',
        from: statusChip('Confirmed'),
        to: statusChip('Warning'),
      }),
    ).toBeUndefined()
  })

  it('says nothing when the old main could not be read', () => {
    expect(
      renameOnSwap({
        before: 'Status chip/Confirmed',
        from: undefined,
        to: statusChip('Warning'),
      }),
    ).toBeUndefined()
  })

  it('says nothing when the new main could not be read', () => {
    expect(
      renameOnSwap({
        before: 'Status chip/Confirmed',
        from: statusChip('Confirmed'),
        to: undefined,
      }),
    ).toBeUndefined()
  })
})

describe('I91 — what the reply says', () => {
  it('names both halves, so the rename is never a silent edit', () => {
    const message = swapRenameMessage(
      'Status chip/Confirmed',
      'Status chip/Warning',
    )
    expect(message).toContain('Status chip/Confirmed')
    expect(message).toContain('Status chip/Warning')
    expect(message).toContain('swap_component')
  })
})

// `code.ts` cannot be imported outside Figma — the house source-scan pattern.
describe('I91 — swap_component actually renames', () => {
  const src = readFileSync(
    join(import.meta.dir, 'code.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('read the file (liveness)', () => {
    expect(src).toContain('inst.swapComponent(scMain)')
  })

  it('reads the OLD main before the swap — afterwards it is gone', () => {
    const arm = src.slice(
      src.indexOf('case COMMANDS.SWAP_COMPONENT:'),
      src.indexOf('case COMMANDS.SET_INSTANCE:'),
    )
    expect(arm).toContain('renameOnSwap(')
    expect(arm).toContain('swapRenameMessage(')
    expect(
      arm.indexOf('scNameBefore'),
    ).toBeLessThan(arm.indexOf('inst.swapComponent(scMain)'))
  })
})
