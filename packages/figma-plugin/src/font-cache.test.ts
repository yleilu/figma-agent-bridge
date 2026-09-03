import { describe, expect, it } from 'bun:test'
import { createFontLoader } from './font-cache'

const inter = { family: 'Inter', style: 'Regular' }

describe('createFontLoader', () => {
  it('asks for a font once, however many nodes want it', async () => {
    const calls: string[] = []
    const l = createFontLoader(async (f) => {
      calls.push(f.family + '/' + f.style)
    })
    for (let i = 0; i < 25; i++) await l.ensure(inter)
    expect(calls).toEqual(['Inter/Regular'])
    expect(l.size()).toBe(1)
  })

  it('still asks once per DISTINCT font', async () => {
    const calls: string[] = []
    const l = createFontLoader(async (f) => {
      calls.push(f.style)
    })
    for (const style of ['Regular', 'Bold', 'Regular', 'Bold', 'Italic'])
      await l.ensure({ family: 'Inter', style })
    expect(calls).toEqual(['Regular', 'Bold', 'Italic'])
  })

  // The point of the whole module: create_tree loaded a font per text child
  // and one of those calls blocked ~11s, timing the command out at ~7 texts.
  it('collapses a tree-shaped load pattern to one call', async () => {
    let n = 0
    const l = createFontLoader(async () => {
      n += 1
    })
    // 8 text children, same font — the shape that timed out live.
    await Promise.all(
      Array.from({ length: 8 }, () => l.ensure(inter)),
    )
    expect(n).toBe(1)
  })

  it('does NOT remember a failed load', async () => {
    let attempts = 0
    const l = createFontLoader(async () => {
      attempts += 1
      if (attempts < 3) throw new Error('font unavailable')
    })
    await expect(l.ensure(inter)).rejects.toThrow('unavailable')
    await expect(l.ensure(inter)).rejects.toThrow('unavailable')
    await l.ensure(inter)
    expect(attempts).toBe(3)
    // once it succeeds, it is remembered
    await l.ensure(inter)
    expect(attempts).toBe(3)
  })

  it('keeps families and styles distinct', async () => {
    const seen: string[] = []
    const l = createFontLoader(async (f) => {
      seen.push(f.family + '|' + f.style)
    })
    await l.ensure({ family: 'A B', style: 'C' })
    await l.ensure({ family: 'A', style: 'B C' })
    expect(seen.length).toBe(2)
  })
})
