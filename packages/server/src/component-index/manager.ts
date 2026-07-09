import type MiniSearch from 'minisearch'
import {
  buildIndex,
  searchIndex,
  serializeIndex,
  loadIndex,
  INDEX_OPTIONS_VERSION,
} from './search-index'
import {
  recordsFromGetComponents,
  membershipFingerprint,
  type ComponentIndexRecord,
} from './record'
import { saveIndex, loadCachedIndex } from './store'

export type IndexState =
  | 'warm'
  | 'stale'
  | 'building'
  | 'cold'

/**
 * A function that fetches the raw get_components
 * reply for a file.
 */
export type GetComponents = () => Promise<{
  local?: unknown
  remote?: unknown
}>

type Entry = {
  index: MiniSearch<ComponentIndexRecord>
  membership: string
  state: IndexState
}

export type SearchOutput = {
  results: ComponentIndexRecord[]
  indexState: IndexState
  truncated: boolean
}

export class IndexManager {
  private readonly files = new Map<string, Entry>()

  /**
   * Build (or rebuild) the index for a file from a
   * fresh get_components reply.
   */
  async buildFor(
    fileKey: string,
    getComponents: GetComponents,
  ): Promise<number> {
    const prior = this.files.get(fileKey)
    if (prior) {
      prior.state = 'building'
    }
    const reply = await getComponents()
    const records = recordsFromGetComponents(reply, fileKey)
    const index = buildIndex(records)
    this.files.set(fileKey, {
      index,
      membership: membershipFingerprint(records),
      state: 'warm',
    })
    await saveIndex(fileKey, {
      version: INDEX_OPTIONS_VERSION,
      serialized: serializeIndex(index),
    })
    return records.length
  }

  /**
   * Search a file, building on cold/stale
   * (rehydrating from disk if possible).
   * Optional `type` filters before slicing so
   * results and truncated reflect the filtered set.
   */
  async search(
    fileKey: string,
    query: string,
    limit: number,
    getComponents: GetComponents,
    type?: 'COMPONENT' | 'COMPONENT_SET',
  ): Promise<SearchOutput> {
    let entry = this.files.get(fileKey)
    if (!entry) {
      const cached = await loadCachedIndex(
        fileKey,
        INDEX_OPTIONS_VERSION,
      )
      if (cached) {
        entry = {
          index: loadIndex(cached),
          membership: '',
          state: 'warm',
        }
        this.files.set(fileKey, entry)
      }
    }
    if (
      !entry ||
      entry.state === 'cold' ||
      entry.state === 'stale'
    ) {
      await this.buildFor(fileKey, getComponents)
      entry = this.files.get(fileKey)!
    }
    const { results, truncated } = searchIndex(
      entry.index,
      query,
      limit,
      type,
    )
    return { results, indexState: entry.state, truncated }
  }

  async reindex(
    fileKey: string,
    getComponents: GetComponents,
  ): Promise<{ indexState: IndexState; count: number }> {
    const count = await this.buildFor(
      fileKey,
      getComponents,
    )
    return { indexState: 'warm', count }
  }

  /**
   * Mark a file's index stale (rebuilt on next
   * search).
   */
  markStale(fileKey: string): void {
    const entry = this.files.get(fileKey)
    if (entry) {
      entry.state = 'stale'
    }
  }
}
