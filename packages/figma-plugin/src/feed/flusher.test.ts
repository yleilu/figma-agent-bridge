import { describe, it, expect } from 'bun:test'
import { createFlusher } from './flusher'

describe('Flusher', () => {
  it('trailing-debounces a burst into one emit', async () => {
    let n = 0
    const f = createFlusher({
      debounceMs: 30,
      maxWaitMs: 1000,
      minIntervalMs: 0,
      emit: () => {
        n += 1
      },
    })
    for (let i = 0; i < 5; i += 1) {
      f.schedule()
      await Bun.sleep(5)
    }
    await Bun.sleep(60)
    expect(n).toBe(1)
  })

  it('the max-wait CEILING fires during a continuous stream', async () => {
    let n = 0
    const f = createFlusher({
      debounceMs: 50,
      maxWaitMs: 60,
      minIntervalMs: 0,
      emit: () => {
        n += 1
      },
    })
    const until = Date.now() + 200
    while (Date.now() < until) {
      f.schedule()
      await Bun.sleep(10)
    }
    await Bun.sleep(70)
    expect(n).toBeGreaterThanOrEqual(2)
  })

  it('never emits faster than minIntervalMs', async () => {
    const at: number[] = []
    const f = createFlusher({
      debounceMs: 1,
      maxWaitMs: 5,
      minIntervalMs: 80,
      emit: () => at.push(Date.now()),
    })
    for (let i = 0; i < 6; i += 1) {
      f.schedule()
      await Bun.sleep(10)
    }
    await Bun.sleep(200)
    // Precondition, not decoration: a spacing assertion over fewer than two
    // emits passes vacuously, so a flusher that never re-armed would score as
    // "never too fast" (POC correction 2).
    expect(at.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < at.length; i += 1) {
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(70)
    }
  })

  it('flushNow emits at once and disarms the debounce', async () => {
    let n = 0
    const f = createFlusher({
      debounceMs: 1000,
      maxWaitMs: 5000,
      minIntervalMs: 0,
      emit: () => {
        n += 1
      },
    })
    f.schedule()
    f.flushNow()
    expect(n).toBe(1)
    await Bun.sleep(30)
    expect(n).toBe(1)
  })

  it('cancel drops the armed emit', async () => {
    let n = 0
    const f = createFlusher({
      debounceMs: 10,
      maxWaitMs: 50,
      minIntervalMs: 0,
      emit: () => {
        n += 1
      },
    })
    f.schedule()
    f.cancel()
    await Bun.sleep(40)
    expect(n).toBe(0)
  })
})
