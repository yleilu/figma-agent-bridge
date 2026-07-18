import { describe, it, expect } from 'bun:test'
import {
  relayIncomingSchema,
  relayOutgoingSchema,
  statusRecordSchema,
} from '../src/ws-schemas'

const rec = {
  key: 'a1',
  level: 'normal',
  text: 'x',
  activity: 'busy',
  updatedAt: 1,
}

describe('status schemas', () => {
  it('accepts a valid record', () => {
    expect(statusRecordSchema.safeParse(rec).success).toBe(
      true,
    )
  })
  it('parses incoming agent-status + status-sync', () => {
    expect(
      relayIncomingSchema.safeParse({
        type: 'agent-status',
        channel: 'c',
        record: rec,
      }).success,
    ).toBe(true)
    expect(
      relayIncomingSchema.safeParse({
        type: 'status-sync',
        channel: 'c',
      }).success,
    ).toBe(true)
  })
  it('parses outgoing broadcast + remove + sync', () => {
    expect(
      relayOutgoingSchema.safeParse({
        type: 'agent-status',
        record: rec,
      }).success,
    ).toBe(true)
    expect(
      relayOutgoingSchema.safeParse({
        type: 'agent-status-remove',
        sessionId: 's',
      }).success,
    ).toBe(true)
    expect(
      relayOutgoingSchema.safeParse({
        type: 'agent-status-sync',
        records: [rec],
      }).success,
    ).toBe(true)
  })
  it('rejects a bad level / text-required', () => {
    expect(
      statusRecordSchema.safeParse({
        ...rec,
        level: 'warning',
      }).success,
    ).toBe(false)
    expect(
      statusRecordSchema.safeParse({
        ...rec,
        text: undefined,
      }).success,
    ).toBe(false)
  })
})
