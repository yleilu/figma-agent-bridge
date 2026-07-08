import { createHash } from 'node:crypto'

/** A single indexed local component. */
export type ComponentIndexRecord = {
  id: string
  key: string
  name: string
  type: 'COMPONENT' | 'COMPONENT_SET'
  page: string
  source: 'local'
  fileKey: string
  description?: string
  variantAxes?: Record<string, string[]>
  /**
   * content digest of the projected definitions
   * — see computeSignature
   */
  signature: string
  context?: unknown
}

const sha1 = (s: string): string =>
  createHash('sha1').update(s).digest('hex')

type ProjectedProperty = {
  id?: string
  name?: string
  type?: string
  defaultValue?: unknown
  variantOptions?: string[]
}

/**
 * The fields of a get_components `local[]` entry
 * we consume.
 */
export type GetComponentsEntry = {
  id?: string
  key?: string
  name?: string
  type?: string
  page?: string | null
  description?: string
  properties?: ProjectedProperty[]
  variantAxes?: Record<string, string[]>
}

/**
 * Per-record content digest: a canonical hash of
 * the fields whose change must churn the search
 * index (name, type, page, description, property
 * definitions, variant axes). Computed as a
 * byproduct of projection — never on its own to
 * gate re-projection (that is
 * `membershipFingerprint`'s job).
 */
export const computeSignature = (
  e: GetComponentsEntry,
): string => {
  const canonical = JSON.stringify({
    n: e.name ?? '',
    t: e.type ?? '',
    p: e.page ?? '',
    d: e.description ?? '',
    props: (e.properties ?? [])
      .map(p => ({
        i: p.id ?? p.name,
        t: p.type,
        dv: p.defaultValue,
      }))
      .sort((a, b) =>
        String(a.i).localeCompare(String(b.i)),
      ),
    axes: e.variantAxes ?? {},
  })
  return sha1(canonical)
}

/**
 * Cheap add/remove/rename gate: a hash of the
 * ordered {id,name,key} set. Built from a bare
 * enumerate — does NOT touch property definitions.
 */
export const membershipFingerprint = (
  records: Pick<
    ComponentIndexRecord,
    'id' | 'name' | 'key'
  >[],
): string => {
  const ordered = records
    .map(r => `${r.id} ${r.name} ${r.key}`)
    .sort()
    .join('')
  return sha1(ordered)
}

/**
 * Map a get_components reply to local index records
 * (remote entries ignored).
 */
export const recordsFromGetComponents = (
  reply: { local?: unknown; remote?: unknown },
  fileKey: string,
): ComponentIndexRecord[] => {
  const local = Array.isArray(reply.local)
    ? (reply.local as GetComponentsEntry[])
    : []
  return local.map(e => {
    const rec: ComponentIndexRecord = {
      id: String(e.id ?? ''),
      key: String(e.key ?? ''),
      name: String(e.name ?? ''),
      type:
        e.type === 'COMPONENT_SET'
          ? 'COMPONENT_SET'
          : 'COMPONENT',
      page:
        e.page === null || e.page === undefined
          ? ''
          : String(e.page),
      source: 'local',
      fileKey,
      signature: computeSignature(e),
    }
    if (
      e.description !== null &&
      e.description !== undefined
    ) {
      rec.description = String(e.description)
    }
    if (
      e.variantAxes !== null &&
      e.variantAxes !== undefined
    ) {
      rec.variantAxes = e.variantAxes
    }
    return rec
  })
}
