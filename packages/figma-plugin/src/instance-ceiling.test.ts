import { describe, expect, it } from 'bun:test'
import {
  appendRefusal,
  sealedInstanceHost,
} from './instance-ceiling'

/** A tiny ancestor chain, leaf first. */
const chain = (
  ...types: { id: string; name: string; type: string }[]
) => {
  let parent: unknown = null
  for (const spec of [...types].reverse()) {
    parent = { ...spec, parent }
  }
  return parent as {
    id: string
    name: string
    type: string
    parent: unknown
  }
}

describe('sealedInstanceHost (I66)', () => {
  it('finds nothing on a plain frame under a page', () => {
    const node = chain(
      { id: '0:1', name: 'Page 1', type: 'PAGE' },
      { id: '1:1', name: 'Screen', type: 'FRAME' },
    )
    expect(sealedInstanceHost(node)).toBeUndefined()
  })

  it('names the INSTANCE when the target IS one', () => {
    const node = chain(
      { id: '0:1', name: 'Page 1', type: 'PAGE' },
      { id: '2:1', name: 'Card', type: 'INSTANCE' },
    )
    expect(sealedInstanceHost(node)).toEqual({
      id: '2:1',
      name: 'Card',
    })
  })

  it('names the NEAREST instance above a descendant', () => {
    const node = chain(
      { id: '0:1', name: 'Page 1', type: 'PAGE' },
      { id: '2:1', name: 'Outer', type: 'INSTANCE' },
      { id: '2:2', name: 'Body', type: 'FRAME' },
      { id: '2:3', name: 'Row', type: 'FRAME' },
    )
    expect(sealedInstanceHost(node)?.id).toBe('2:1')
  })

  it('survives a handle that refuses to answer', () => {
    const hostile = {
      id: '3:1',
      name: 'Broken',
      type: 'FRAME',
      get parent(): unknown {
        throw new Error('The node … does not exist')
      },
    }
    expect(sealedInstanceHost(hostile)).toBeUndefined()
  })

  it('stops rather than looping on a cyclic chain', () => {
    const a: Record<string, unknown> = {
      id: 'a',
      name: 'A',
      type: 'FRAME',
    }
    a.parent = a
    expect(sealedInstanceHost(a)).toBeUndefined()
  })
})

describe('appendRefusal (I66)', () => {
  it('names the ceiling, the host, and the taught workaround', () => {
    const message = appendRefusal({
      operation: 'create',
      parentId: '2:2',
      parentType: 'FRAME',
      host: { id: '2:1', name: 'Card' },
      raw: 'Cannot add a child',
    })
    // The ceiling.
    expect(message).toContain('INSTANCE')
    expect(message).toContain('Card')
    expect(message).toContain('2:1')
    expect(message).toContain('SLOT')
    // The workaround, both halves (S44).
    expect(message).toContain('update_component')
    expect(message).toContain('reparent_node')
    // The target it was actually given.
    expect(message).toContain('2:2')
  })

  it('does NOT claim an instance when there is none — it reports what Figma said', () => {
    // The old text asserted the instance story from a bare `catch {}`, whatever
    // the real cause was. That is the self-contradiction the backlog records.
    const message = appendRefusal({
      operation: 'move',
      parentId: '9:9',
      parentType: 'TEXT',
      host: undefined,
      raw: 'Cannot add children to a TEXT node',
    })
    expect(message).not.toContain('INSTANCE')
    expect(message).not.toContain('SLOT')
    expect(message).toContain(
      'Cannot add children to a TEXT node',
    )
    expect(message).toContain('9:9')
  })

  it('says the same thing for a move as for a create — one sentence, one rule', () => {
    const host = { id: '2:1', name: 'Card' }
    const created = appendRefusal({
      operation: 'create',
      parentId: '2:2',
      parentType: 'FRAME',
      host,
      raw: 'x',
    })
    const moved = appendRefusal({
      operation: 'move',
      parentId: '2:2',
      parentType: 'FRAME',
      host,
      raw: 'x',
    })
    expect(created.replace('create', 'move')).toBe(moved)
  })
})
