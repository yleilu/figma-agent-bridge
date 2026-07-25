import { describe, expect, it, test } from 'bun:test'
import {
  selectPanelView,
  showSelectionBar,
} from './panel-view'

describe('selectPanelView', () => {
  it('connecting pre-empts everything', () => {
    expect(
      selectPanelView('connecting', null, 3).kind,
    ).toBe('connecting')
  })

  it('disconnected → offline (pre-empts mismatch)', () => {
    const v = selectPanelView(
      'disconnected',
      { plugin: '0.3.0', server: '0.4.0' },
      0,
    )
    expect(v.kind).toBe('offline')
  })

  it('a set mismatch pre-empts a non-empty roster', () => {
    expect(
      selectPanelView(
        'connected',
        { plugin: '0.3.0', server: '0.4.0' },
        5,
      ),
    ).toEqual({
      kind: 'mismatch',
      plugin: '0.3.0',
      server: '0.4.0',
    })
  })

  it('connected + no mismatch + rows → roster', () => {
    expect(selectPanelView('connected', null, 2).kind).toBe(
      'roster',
    )
  })

  it('connected + no mismatch + no rows → idle', () => {
    expect(selectPanelView('connected', null, 0).kind).toBe(
      'idle',
    )
  })
})

describe('showSelectionBar', () => {
  test('roster + a live selection → shown', () => {
    expect(showSelectionBar({ kind: 'roster' }, 2)).toBe(
      true,
    )
    expect(showSelectionBar({ kind: 'roster' }, 1)).toBe(
      true,
    )
  })
  test('nothing selected → hidden', () => {
    expect(showSelectionBar({ kind: 'roster' }, 0)).toBe(
      false,
    )
  })
  test('never outside the roster', () => {
    expect(showSelectionBar({ kind: 'idle' }, 2)).toBe(
      false,
    )
    expect(
      showSelectionBar({ kind: 'connecting' }, 2),
    ).toBe(false)
    expect(showSelectionBar({ kind: 'offline' }, 2)).toBe(
      false,
    )
    expect(
      showSelectionBar(
        {
          kind: 'mismatch',
          plugin: '0.3.0',
          server: '0.4.0',
        },
        2,
      ),
    ).toBe(false)
  })
})
