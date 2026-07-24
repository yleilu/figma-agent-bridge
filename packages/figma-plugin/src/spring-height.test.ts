import { describe, expect, test } from 'bun:test'
import {
  MIN_WINDOW_HEIGHT,
  MAX_WINDOW_HEIGHT,
  ONE_MESSAGE_HEIGHT,
  WINDOW_WIDTH,
  clamp,
  measuredTarget,
  nextHeight,
} from './spring-height'

describe('window-height bounds', () => {
  test('min is one message (title + description)', () => {
    expect(MIN_WINDOW_HEIGHT).toBe(64)
    expect(MIN_WINDOW_HEIGHT).toBe(ONE_MESSAGE_HEIGHT)
  })
  test('max is a 9:16 portrait of the fixed width', () => {
    expect(MAX_WINDOW_HEIGHT).toBe(
      Math.round(WINDOW_WIDTH * (16 / 9)),
    )
    expect(MAX_WINDOW_HEIGHT).toBe(604)
  })
})

describe('clamp', () => {
  test('floors below one message', () => {
    expect(clamp(10)).toBe(MIN_WINDOW_HEIGHT)
  })
  test('caps at the portrait max', () => {
    expect(clamp(9999)).toBe(MAX_WINDOW_HEIGHT)
  })
  test('passes a mid value through', () => {
    expect(clamp(200)).toBe(200)
  })
})

describe('measuredTarget', () => {
  test('ceils then clamps', () => {
    expect(measuredTarget(200.2)).toBe(201)
    expect(measuredTarget(5)).toBe(MIN_WINDOW_HEIGHT)
  })
})

describe('nextHeight', () => {
  test('rounds + clamps', () => {
    expect(nextHeight(200.4, -1)).toBe(200)
  })
  test('dedupes against the last sent integer', () => {
    expect(nextHeight(200, 200)).toBe(null)
  })
})
