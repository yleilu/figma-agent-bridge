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
 * Project a MiniSearch hit back to the stored record.
 * A raw hit also carries the engine's own scoring fields
 * (score / terms / queryTerms / match) — internals the
 * agent must never see, so every hit is rebuilt from the
 * stored fields alone.
 */
const toRecord = (
  hit: ComponentIndexRecord,
): ComponentIndexRecord => {
  const rec: ComponentIndexRecord = {
    id: hit.id,
    key: hit.key,
    name: hit.name,
    type: hit.type,
    page: hit.page,
    source: hit.source,
    fileKey: hit.fileKey,
    signature: hit.signature,
  }
  if (hit.description !== undefined) {
    rec.description = hit.description
  }
  if (hit.variantAxes !== undefined) {
    rec.variantAxes = hit.variantAxes
  }
  return rec
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
    results: hits.slice(0, limit).map(toRecord),
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
