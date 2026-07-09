import MiniSearch from 'minisearch'
import type { ComponentIndexRecord } from './record'

/**
 * Bumped whenever the MiniSearch config OR the record
 * shape changes, so a stale on-disk cache (built with
 * different options) is never loaded (loadJSON requires
 * identical options).
 */
export const INDEX_OPTIONS_VERSION = 'v1'

const OPTIONS = {
  idField: 'id' as const,
  fields: ['name', 'description'],
  storeFields: [
    'id',
    'key',
    'name',
    'type',
    'page',
    'source',
    'fileKey',
    'description',
    'variantAxes',
    'signature',
  ],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

export const buildIndex = (
  records: ComponentIndexRecord[],
): MiniSearch<ComponentIndexRecord> => {
  const idx = new MiniSearch<ComponentIndexRecord>(OPTIONS)
  idx.addAll(records)
  return idx
}

export type SearchResult = {
  results: ComponentIndexRecord[]
  truncated: boolean
}

/**
 * Run a query, bounded to top-N.
 * `truncated` = more matched than `limit`.
 * Optional `type` filters results before slicing so
 * truncated reflects the type-constrained set.
 */
export const searchIndex = (
  idx: MiniSearch<ComponentIndexRecord>,
  query: string,
  limit: number,
  type?: 'COMPONENT' | 'COMPONENT_SET',
): SearchResult => {
  const filter = type
    ? (r: ComponentIndexRecord) => r.type === type
    : undefined
  const hits = idx.search(query, {
    filter: filter as
      | ((result: unknown) => boolean)
      | undefined,
  }) as unknown as ComponentIndexRecord[]
  return {
    results: hits.slice(0, limit),
    truncated: hits.length > limit,
  }
}

export const serializeIndex = (
  idx: MiniSearch<ComponentIndexRecord>,
): string => JSON.stringify(idx)

export const loadIndex = (
  json: string,
): MiniSearch<ComponentIndexRecord> =>
  MiniSearch.loadJSON<ComponentIndexRecord>(json, OPTIONS)
