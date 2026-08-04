import { describe, expect, it } from 'bun:test'
import { importComponentByKeyWithDeadline } from './import-by-key'

// `figma.importComponentByKeyAsync` returns a promise that NEVER settles for a
// key it cannot import — verified live against a fake key, a malformed key and
// a real unpublished one. This is that behaviour.
const never = <T>() => new Promise<T>(() => {})
const boom = () => Promise.reject(new Error('nope'))

describe('importComponentByKeyWithDeadline', () => {
  it('resolves from the component importer', async () => {
    const r = await importComponentByKeyWithDeadline(
      'k',
      {
        component: () => Promise.resolve('COMP'),
        set: () => never(),
      },
      100,
    )
    expect(r).toBe('COMP')
  })

  // The case a sequential try/catch can never reach: the component importer
  // hangs rather than rejecting, so its `catch` never runs.
  it('resolves from the set importer while the component one hangs', async () => {
    const r = await importComponentByKeyWithDeadline(
      'k',
      {
        component: () => never<string>(),
        set: () =>
          Promise.resolve({ defaultVariant: 'VAR' }),
      },
      100,
    )
    expect(r).toBe('VAR')
  })

  it('rejects with a message naming the key when neither settles', async () => {
    await expect(
      importComponentByKeyWithDeadline(
        'kk',
        { component: () => never(), set: () => never() },
        50,
      ),
    ).rejects.toThrow(/kk.*PUBLISHED/)
  })

  it('rejects when both importers reject', async () => {
    await expect(
      importComponentByKeyWithDeadline(
        'k',
        { component: boom, set: boom },
        100,
      ),
    ).rejects.toThrow('nope')
  })

  it('a single rejection does not settle it — the other may still fulfil', async () => {
    const r = await importComponentByKeyWithDeadline(
      'k',
      {
        component: boom,
        set: () =>
          new Promise(res =>
            setTimeout(
              () => res({ defaultVariant: 'LATE' }),
              20,
            ),
          ),
      },
      200,
    )
    expect(r).toBe('LATE')
  })
})
