// search-candidates.ts — search candidates built from an EXPORT rather than
// from live handles (B48).
//
// `search` scans live nodes. That is right until it reaches a subtree whose
// live addresses were composed from a stale id (see canonical-ids.ts): those
// handles throw on `name`, so the nodes were dropped into `warnings[]` and
// never reached `results` — a whole-document sweep quietly degraded to a
// partial one, and the node above them was reported under its alias id.
//
// The recovery is the same oracle the read face uses: export the node the
// failures were reached THROUGH, and read the candidates out of that JSON. The
// export knows the canonical id of every node in the subtree, so the ids come
// back addressable and nothing is missing.
//
// What an export cannot supply is named here rather than guessed:
//   - `context`         — getSharedPluginData is a live-only read
//   - `styleIds`        — JSON_REST_V1 carries no style reference
// `characters` and `variableIds` DO come through, which is what the
// copy-inventory and design-system sweeps run on.
//
// `componentKey` / `instancesOf` used to be on that list, and their absence WAS
// B56: `search {instancesOf:'State block'}` answered `results: []` against two
// provable slot-nested instances — the repair returned the rows, and the rows
// matched nothing. The export does name each instance's main, by ID
// (`componentId`), and a main component is a plain top-level node whose handle
// answers. So the id is carried out and traded for the name and key through
// `componentRefOf`, once per distinct master.
//
// That gap is why `repairScan` REPLACES as little as it can. A healthy node
// inside a broken subtree read fine and its live id is already canonical, so
// its live candidate is kept exactly as the scan built it, with the four
// export-less fields intact. Only a row the export does not name at all is
// dropped — an id the file does not use is a pre-append id by construction.
// Downgrading a whole subtree because one node in it went stale would make
// `match:{instancesOf}` return FEWER results than before the repair existed,
// which is the same silent under-count B48 is about.

import {
  exportedWithin,
  variableIdsInExport,
  type RawNode,
} from './canonical-ids'

/** The flat shape the server's matcher and projection consume. */
export type Candidate = Record<string, unknown>

/** What the caller asked the scan to collect per candidate (B3/B4 hints). */
export type CandidateHints = {
  characters?: boolean
  variableIds?: boolean
  /** B56 — carry each INSTANCE's main component id out for resolution. */
  componentRef?: boolean
}

/**
 * The key an export row carries its main component's ID on, before the id is
 * traded for the NAME and KEY a matcher runs on (B56).
 *
 * INTERNAL. `repairScan` deletes it from every row it returns, resolved or not:
 * the candidate shape the server matches and projects has no such field, and a
 * raw id leaking into results would be a fifth thing to explain.
 */
const MAIN_COMPONENT_ID = 'mainComponentId'

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

/**
 * `[width, height]` for an exported node.
 *
 * Same preference order the server's reader applies: the plugin-supplied
 * unrotated size when it is there, else the axis-aligned bounding box. An
 * export that carries neither answers `undefined` rather than `[0, 0]` — a
 * fabricated size is worse than an absent one (B26).
 */
const sizeOf = (
  n: RawNode,
): [number, number] | undefined => {
  if (
    typeof n.width === 'number' &&
    typeof n.height === 'number'
  ) {
    return [n.width, n.height]
  }
  const bbox = n.absoluteBoundingBox as
    | { width?: unknown; height?: unknown }
    | null
    | undefined
  if (
    bbox !== null &&
    bbox !== undefined &&
    typeof bbox.width === 'number' &&
    typeof bbox.height === 'number'
  ) {
    return [bbox.width, bbox.height]
  }
  return undefined
}

/** One exported node as a candidate, or undefined when it has no id. */
export const candidateFromExport = (
  n: RawNode,
  hints: CandidateHints = {},
): Candidate | undefined => {
  const id = str(n.id)
  if (id === undefined) return undefined
  const candidate: Candidate = {
    id,
    name: str(n.name) ?? '',
    type: str(n.type) ?? '',
    size: sizeOf(n),
  }
  if (hints.characters === true && 'characters' in n) {
    candidate.characters = n.characters
  }
  if (hints.variableIds === true) {
    const ids = variableIdsInExport(n)
    if (ids.length > 0) {
      candidate.variableIds = ids
    }
  }
  // B56 — the instance's main component, by id. JSON_REST_V1 names it on every
  // INSTANCE (`componentId`), and a main component is a plain, top-level node
  // whose handle answers, so the id is enough to recover the NAME and KEY that
  // `match:{instancesOf}` / `match:{componentKey}` run on. Without this a
  // slot-nested instance came back in `results` but matched nothing.
  if (
    hints.componentRef === true &&
    str(n.type) === 'INSTANCE'
  ) {
    const mainId = str(n.componentId)
    if (mainId !== undefined && mainId !== '') {
      candidate[MAIN_COMPONENT_ID] = mainId
    }
  }
  return candidate
}

/**
 * Every node in an exported subtree as a candidate, root first, bounded by the
 * levels the live scan had left when it reached that root.
 */
export const candidatesFromExport = (
  doc: RawNode,
  depth: number,
  hints: CandidateHints = {},
): Candidate[] => {
  const out: Candidate[] = []
  for (const n of exportedWithin(doc, depth)) {
    const candidate = candidateFromExport(n, hints)
    if (candidate !== undefined) {
      out.push(candidate)
    }
  }
  return out
}

// ─── the repair pass ──────────────────────────────────────────────────────────

/**
 * What the live scan recorded about one node it walked.
 *
 * `subtreeEnd` closes the node's own range in the scan (`[index, subtreeEnd)`),
 * which is what makes "the subtree below this node" a slice rather than a
 * second traversal. `levelsLeft` is how much further the scan was allowed to
 * descend from here, so an export of this node is read to the same bound.
 */
export type ScanEntry = {
  id: string
  levelsLeft: number
  subtreeEnd: number
}

/**
 * One thing the scan could not read.
 *
 * `at` is the index of the node that failed, or -1 when it never got an entry
 * (its id would not even read). `host` is the index of the node it was reached
 * THROUGH — the one whose export can describe it — or -1 for a failure directly
 * under a scan root, which nothing covers.
 */
export type ScanFailure = {
  at: number
  host: number
  message: string
}

export type RepairInput = {
  scanned: ScanEntry[]
  /** One slot per `scanned` entry; undefined where the candidate build threw. */
  candidates: (Candidate | undefined)[]
  failures: ScanFailure[]
  hints?: CandidateHints
  /** The host's exported subtree, or undefined when it cannot describe itself. */
  exportHost: (
    index: number,
  ) => Promise<RawNode | undefined>
  /**
   * A main component's NAME and KEY, by its node id (B56).
   *
   * The export names an instance's main by id only, and `match:{instancesOf}`
   * matches on the name. Omitting the resolver leaves an export-served row
   * unmatched by those keys, exactly as before — and the trade warning then
   * says so.
   */
  componentRefOf?: (
    componentId: string,
  ) => Promise<{ key?: string; name?: string } | undefined>
  /** Cap on how many subtrees may be serialized in one scan (T10). */
  maxRepairs?: number
}

export type RepairOutput = {
  results: Candidate[]
  /** The failures no export covered, and the rows the repair had to trade. */
  warnings: string[]
}

/**
 * The candidate keys only a LIVE read can produce.
 *
 * `characters` and `variableIds` are not here: the export carries both, so a
 * row that comes back from the export can still be matched on them. These four
 * cannot survive the trade, which is why swapping a live row for an export row
 * has to be SAID rather than done quietly.
 */
const LIVE_ONLY_KEYS = [
  'context',
  'styleIds',
  'componentKey',
  'instancesOf',
] as const

/**
 * Which of them this row actually carries — i.e. what dropping it costs.
 *
 * `componentKey` and `instancesOf` stop counting as lost once a component
 * resolver is in hand (B56): the export names the main by id and the resolver
 * turns that into the same name and key the live row held, so calling them lost
 * would send an operator hunting a filter that works.
 */
const liveOnlyKeysOf = (
  c: Candidate,
  refsResolvable: boolean,
): string[] =>
  LIVE_ONLY_KEYS.filter(
    k =>
      c[k] !== undefined &&
      !(
        refsResolvable &&
        (k === 'componentKey' || k === 'instancesOf')
      ),
  )

/**
 * Turn a degraded scan into a complete one, by exporting the subtrees the live
 * walk could not read.
 *
 * Three sets do the work, and keeping them SEPARATE is the point:
 *   - `covered`     — an export now speaks for this index. Stops a nested host
 *                     being exported twice, and silences the failures under it.
 *   - `superseded`  — this live row is dropped. ONLY rows the export does not
 *                     name: a pre-append id, which is the alias the scan used
 *                     to emit. A healthy row keeps its live candidate.
 *   - `rescanned`   — the rows only the export knows about.
 *
 * Hosts are repaired outermost-first (the scan is pre-order, so a smaller index
 * is an ancestor), which lets one export absorb the hosts beneath it.
 *
 * DROPPING A ROW IS A TRADE, AND IT IS DECLARED. The row a repair supersedes is
 * usually the alias ROOT of the slot-created subtree — its own handle read, so
 * the scan had already built it a candidate carrying `context`, `styleIds`,
 * `componentKey` and `instancesOf`. The export row that replaces it is
 * addressable where the alias was not, but it cannot carry those four, so a
 * `match:{instancesOf|componentKey|styleId}` stops finding a node it used to
 * find. That is a real limit, not a bug this pass can fix — but a search that
 * reports clean while quietly returning fewer rows is the exact failure this
 * batch exists to remove, so the trade is named in `warnings`. The warning
 * fires only when something was genuinely lost: a dropped row carrying none of
 * the four costs a filter nothing and says nothing.
 */
export const repairScan = async ({
  scanned,
  candidates,
  failures,
  hints = {},
  exportHost,
  componentRefOf,
  maxRepairs = 50,
}: RepairInput): Promise<RepairOutput> => {
  const refsResolvable = componentRefOf !== undefined
  const covered = new Set<number>()
  const superseded = new Set<number>()
  const rescanned: Candidate[] = []
  const rescannedIds = new Set<string>()
  /** One line per row the repair traded away with keys on it. */
  const traded: string[] = []

  // The ids that still stand for a row in `results`. An export candidate whose
  // id is already here is the twin of a live candidate we are keeping, and the
  // live one wins — it carries context / styleIds / componentKey / instancesOf.
  const liveIds = new Set<string>()
  for (let i = 0; i < scanned.length; i++) {
    if (candidates[i] !== undefined) {
      liveIds.add(scanned[i].id)
    }
  }

  const hostSet = new Set<number>()
  for (const failure of failures) {
    if (failure.host >= 0) {
      hostSet.add(failure.host)
    }
  }
  const hosts = [...hostSet].sort((a, b) => a - b)

  let repairs = 0
  for (const host of hosts) {
    if (covered.has(host)) continue
    if (repairs >= maxRepairs) break
    repairs++
    const doc = await exportHost(host)
    if (doc === undefined) continue

    const entry = scanned[host]
    const fromExport = candidatesFromExport(
      doc,
      entry.levelsLeft,
      hints,
    )
    // An export that describes nothing cannot speak for anything. Superseding
    // on the strength of it would delete the subtree from the results and put
    // nothing back — and silence the failures too, since `covered` is what
    // decides that. Leave the scan exactly as it was.
    if (fromExport.length === 0) continue

    const exportRoot =
      typeof fromExport[0].id === 'string'
        ? fromExport[0].id
        : entry.id
    const exportIds = new Set<string>()
    for (const candidate of fromExport) {
      if (typeof candidate.id === 'string') {
        exportIds.add(candidate.id)
      }
    }

    for (let i = host; i < entry.subtreeEnd; i++) {
      covered.add(i)
      const liveId = scanned[i].id
      const liveRow = candidates[i]
      if (liveRow === undefined) {
        // Nothing was emitted for this node, so nothing stands in the export's
        // way — and its id must stop blocking the export's twin.
        liveIds.delete(liveId)
        continue
      }
      if (!exportIds.has(liveId)) {
        // The file does not use this id. That is the alias case: the export
        // names the same node properly, a few lines down.
        superseded.add(i)
        liveIds.delete(liveId)
        const lost = liveOnlyKeysOf(liveRow, refsResolvable)
        if (lost.length > 0) {
          traded.push(
            'search: repaired the subtree at ' +
              exportRoot +
              ' — the row for ' +
              liveId +
              ' now comes from the export and cannot carry ' +
              lost.join(', ') +
              '; a match on those keys will not find this node',
          )
        }
      }
      // Otherwise the live id IS canonical — a healthy node inside a broken
      // subtree. Keep its row exactly as the scan built it.
    }

    for (const candidate of fromExport) {
      const id = candidate.id
      if (typeof id === 'string') {
        if (liveIds.has(id) || rescannedIds.has(id)) {
          continue
        }
        rescannedIds.add(id)
      }
      rescanned.push(candidate)
    }
  }

  // B56 — trade each export row's main component ID for the NAME and KEY the
  // matcher runs on. Resolved ONCE per distinct component: a repaired card
  // holds many instances of few masters. The marker is deleted either way, so
  // no row ever leaves carrying it.
  const resolved = new Map<
    string,
    { key?: string; name?: string } | undefined
  >()
  for (const candidate of rescanned) {
    const mainId = candidate[MAIN_COMPONENT_ID]
    if (typeof mainId !== 'string') continue
    delete candidate[MAIN_COMPONENT_ID]
    if (componentRefOf === undefined) continue
    if (!resolved.has(mainId)) {
      resolved.set(
        mainId,
        // A main that refuses to resolve costs this row its two ref keys and
        // nothing else — the row itself is still returned.
        await componentRefOf(mainId).catch(() => undefined),
      )
    }
    const ref = resolved.get(mainId)
    if (ref?.name !== undefined) {
      candidate.instancesOf = ref.name
    }
    if (ref?.key !== undefined) {
      candidate.componentKey = ref.key
    }
  }

  const results: Candidate[] = []
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (candidate !== undefined && !superseded.has(i)) {
      results.push(candidate)
    }
  }
  for (const candidate of rescanned) {
    results.push(candidate)
  }

  // A failure an export covered is no longer a loss, so it is no longer a
  // warning; one it did not reach still is. Judged on the node that FAILED
  // where the scan got far enough to index it — a host's export bounds the
  // subtree it was read at, and a failure outside that slice is not covered by
  // it however close the two look.
  const warnings: string[] = []
  for (const failure of failures) {
    const isCovered =
      failure.at >= 0
        ? covered.has(failure.at)
        : failure.host >= 0 && covered.has(failure.host)
    if (!isCovered) {
      warnings.push(failure.message)
    }
  }
  // …and what the repair itself cost, after what it could not repair.
  for (const message of traded) {
    warnings.push(message)
  }
  return { results, warnings }
}
