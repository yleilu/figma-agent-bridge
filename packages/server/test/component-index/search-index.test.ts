import { describe, expect, it } from 'bun:test'
import {
  buildIndex,
  searchIndex,
  serializeIndex,
  loadIndex,
  INDEX_OPTIONS_VERSION,
} from '@figma-agent-bridge/server/component-index/search-index'
import type { ComponentIndexRecord } from '@figma-agent-bridge/server/component-index/record'

const rec = (
  id: string,
  name: string,
  description?: string,
): ComponentIndexRecord => ({
  id,
  name,
  key: `k${id}`,
  type: 'COMPONENT',
  page: 'p',
  source: 'local',
  fileKey: 'f',
  signature: 's',
  description,
})

const records = [
  rec('1', 'Primary Button', 'main call to action'),
  rec('2', 'Secondary Button'),
  rec('3', 'Icon / Settings', 'gear cog'),
]

describe('buildIndex + searchIndex', () => {
  it('finds by name substring/prefix', () => {
    const idx = buildIndex(records)
    const { results } = searchIndex(idx, 'button', 10)
    expect(results.map(r => r.id).sort()).toEqual([
      '1',
      '2',
    ])
  })
  it('finds by description term', () => {
    const idx = buildIndex(records)
    const { results } = searchIndex(idx, 'gear', 10)
    expect(results.map(r => r.id)).toEqual(['3'])
  })
  it('bounds to top-N and reports truncated', () => {
    const idx = buildIndex(records)
    const { results, truncated } = searchIndex(
      idx,
      'button',
      1,
    )
    expect(results).toHaveLength(1)
    expect(truncated).toBe(true)
  })
  it('returns records only — no MiniSearch internals', () => {
    const idx = buildIndex(records)
    const { results } = searchIndex(idx, 'primary', 10)
    expect(results).toHaveLength(1)
    expect(Object.keys(results[0]).sort()).toEqual([
      'description',
      'fileKey',
      'id',
      'key',
      'name',
      'page',
      'signature',
      'source',
      'type',
    ])
  })
  it('omits an absent optional field rather than emitting undefined', () => {
    const idx = buildIndex(records)
    const { results } = searchIndex(idx, 'secondary', 10)
    expect(results).toHaveLength(1)
    expect(Object.keys(results[0])).not.toContain(
      'description',
    )
  })
})

describe('serialize + load round-trip', () => {
  it('reloads an equivalent index', () => {
    const json = serializeIndex(buildIndex(records))
    const idx = loadIndex(json)
    expect(
      searchIndex(idx, 'settings', 10).results.map(
        r => r.id,
      ),
    ).toEqual(['3'])
  })
})

describe('INDEX_OPTIONS_VERSION', () => {
  it('is a non-empty string stamp', () => {
    expect(typeof INDEX_OPTIONS_VERSION).toBe('string')
    expect(INDEX_OPTIONS_VERSION.length).toBeGreaterThan(0)
  })
})

describe('type filter', () => {
  it(
    'narrows before the limit ' +
      '(truncated reflects the filtered set)',
    () => {
      const recs = [
        rec('1', 'Alpha Button'),
        rec('2', 'Beta Button'),
        rec('3', 'Gamma Button'),
      ]
      recs[1].type = 'COMPONENT_SET'
      const idx = buildIndex(recs)
      // 2 COMPONENTs match 'button'; limit 1 -> 1 result +
      // truncated
      const onlyComponents = searchIndex(
        idx,
        'button',
        1,
        'COMPONENT',
      )
      expect(onlyComponents.results).toHaveLength(1)
      expect(
        onlyComponents.results.every(
          r => r.type === 'COMPONENT',
        ),
      ).toBe(true)
      expect(onlyComponents.truncated).toBe(true)
      // filter to the single SET -> 1 result, not truncated
      const onlySets = searchIndex(
        idx,
        'button',
        5,
        'COMPONENT_SET',
      )
      expect(onlySets.results.map(r => r.id)).toEqual(['2'])
      expect(onlySets.truncated).toBe(false)
    },
  )
})
