// component-properties.test.ts — M22a: a removal names a property the caller
// can actually hold, and every refusal is spoken.
//
// The repro: `update_component` on a Top bar whose `Show date` BOOLEAN had been
// orphaned (its bound node was deleted with the old Actions frame) answered ok,
// warnings [], property list unchanged. Nothing removed the property and
// nothing said so.

import { describe, expect, it } from 'bun:test'
import {
  propertyName,
  resolvePropertyKey,
  undeletedMessage,
} from './component-properties'

const defs = {
  'Show date#453:63': { type: 'BOOLEAN' },
  'Label#453:64': { type: 'TEXT' },
  'Plot area#453:65': { type: 'SLOT' },
}

describe('propertyName', () => {
  it('strips the canonical id suffix', () => {
    expect(propertyName('Show date#453:63')).toBe(
      'Show date',
    )
  })

  it('leaves a bare variant-property name alone', () => {
    expect(propertyName('Size')).toBe('Size')
  })

  it('splits on the LAST # so a name may contain one', () => {
    expect(propertyName('Tag #1#453:63')).toBe('Tag #1')
  })
})

describe('resolvePropertyKey', () => {
  it('takes the canonical id verbatim', () => {
    expect(
      resolvePropertyKey(defs, 'Show date#453:63').key,
    ).toBe('Show date#453:63')
  })

  // The M22 shape: the reply shows `name: "Show date"`, so that is what a
  // caller passes back. Refusing it as unknown would be technically true and
  // practically useless.
  it('takes the bare NAME the reply showed', () => {
    expect(resolvePropertyKey(defs, 'Show date').key).toBe(
      'Show date#453:63',
    )
  })

  it('takes a variant property keyed by its bare name', () => {
    expect(
      resolvePropertyKey(
        { Size: { type: 'VARIANT' } },
        'Size',
      ).key,
    ).toBe('Size')
  })

  it('refuses an ambiguous bare name, naming the candidates', () => {
    const r = resolvePropertyKey(
      {
        'Label#1:1': { type: 'TEXT' },
        'Label#1:2': { type: 'TEXT' },
      },
      'Label',
    )
    expect(r.key).toBeUndefined()
    expect(r.error).toContain('Label#1:1')
    expect(r.error).toContain('Label#1:2')
  })

  it('refuses an unknown name and lists what IS defined', () => {
    const r = resolvePropertyKey(defs, 'Show week')
    expect(r.key).toBeUndefined()
    expect(r.error).toContain('Show week')
    expect(r.error).toContain('Show date#453:63')
  })

  it('says so plainly when the component has no properties', () => {
    const r = resolvePropertyKey({}, 'Show date')
    expect(r.error).toContain('has none')
  })
})

describe('undeletedMessage', () => {
  it('names the property that survived the delete', () => {
    const m = undeletedMessage('Plot area#453:65')
    expect(m).toContain('Plot area#453:65')
    expect(m).toContain('SLOT')
  })
})
