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
// `componentKey` / `instancesOf` used to be on that list, and B56 is what their
// absence cost: an export-served row came back in `results` and matched
// nothing. The export DOES name each instance's main — the node carries
// `componentId`, and the `components` map beside `document` says what that id
// is called (`{key, name, componentSetId}`), with `componentSets` naming the
// family one hop further. Those maps are the source; a live `componentRefOf`
// covers a runtime whose subtree export omits them.
//
// The FAMILY name matters as much as the component's own (B56, live root
// cause). A variant is named `State=Error`; the set is named `State block`,
// and the set's name is the only one a human ever sees. So a row carries both,
// and the server's matcher tests both.
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
  /** B85 — carry the export's own per-node style references out. */
  styleIds?: boolean
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
 * Fold one export's `components` / `componentSets` maps into the shared
 * componentId → ref lookup (B56).
 *
 * REST names a component by id in `components`, and names the SET that
 * component belongs to one hop further, through `componentSetId`. Both hops
 * are optional at every step — a stand-alone component has no set, and a
 * runtime may omit the maps entirely — so each is read defensively and a
 * missing half simply leaves that field unset.
 *
 * The lookup accumulates ACROSS hosts: two repaired subtrees may reference the
 * same master, and one export naming it is enough for both.
 */
const foldExportRefs = (
  exported: ExportedHost,
  into: Map<string, ComponentRef>,
): void => {
  const { components, componentSets } = exported
  if (
    components === null ||
    components === undefined ||
    typeof components !== 'object'
  ) {
    return
  }
  for (const [id, entry] of Object.entries(components)) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const setId = str(entry.componentSetId)
    const ref: ComponentRef = {}
    const key = str(entry.key)
    const name = str(entry.name)
    if (key !== undefined) {
      ref.key = key
    }
    if (name !== undefined) {
      ref.name = name
    }
    const setName =
      setId === undefined
        ? undefined
        : str(componentSets?.[setId]?.name)
    if (setName !== undefined) {
      ref.setName = setName
    }
    // A later export must not overwrite a fuller earlier answer with a thinner
    // one — the first export that NAMES a component wins.
    const held = into.get(id)
    if (held === undefined || held.name === undefined) {
      into.set(id, ref)
    }
  }
}

/** As much of a main COMPONENT as the family-name read touches. */
export type MainComponent = {
  name?: unknown
  parent?: unknown
}

/**
 * The name of the COMPONENT_SET a main component belongs to, or undefined for
 * a stand-alone component (B56).
 *
 * A variant's own name is `State=Error`. The FAMILY is named on the set —
 * `State block` — and that is the only name a human ever sees: the components
 * panel shows it, the design doc says it, the acceptance gate is written
 * against it. `search {instancesOf:'State block'}` returned nothing while two
 * instances of that family sat in the file.
 *
 * Guarded: reading `.parent` is a read of a live node and a live node can
 * refuse. A candidate must not be lost over a family name it may not have.
 */
export const componentSetOf = (
  main: MainComponent,
): string | undefined => {
  try {
    const parent = main.parent as
      | { type?: unknown; name?: unknown }
      | null
      | undefined
    if (
      parent !== null &&
      parent !== undefined &&
      str(parent.type) === 'COMPONENT_SET'
    ) {
      return str(parent.name)
    }
  } catch {
    // No family name for this candidate; every other key still stands.
  }
  return undefined
}

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

/**
 * Every style reference an EXPORTED node carries, deduped (B85).
 *
 * JSON_REST_V1 puts them on the node as `styles: {fill, stroke, effect, grid,
 * text}`. The field names are Figma's, not ours, so this reads whatever the
 * map holds rather than naming five keys — a runtime that adds a sixth role
 * still answers a census on it.
 *
 * Only strings. A `styles` entry that is not one describes nothing a matcher
 * can test, and a fabricated reference is worse than an absent one (B26).
 */
export const styleIdsInExport = (n: RawNode): string[] => {
  const styles = n.styles
  if (
    styles === null ||
    styles === undefined ||
    typeof styles !== 'object'
  ) {
    return []
  }
  const ids = new Set<string>()
  for (const value of Object.values(
    styles as Record<string, unknown>,
  )) {
    if (typeof value === 'string' && value !== '') {
      ids.add(value)
    }
  }
  return [...ids]
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
  // B85 — the node's own style references, off the export. JSON_REST_V1 names
  // them per node under `styles` (`{fill, stroke, effect, grid, text}` → a
  // style reference), which is the one live-only key of the four that the
  // export can in fact answer. Without it a style census taken from `search`
  // read `results: 1` where three nodes carried `Glow/Accent` and `results: 0`
  // on a page whose designated carrier renders it — every miss a node served
  // from a repaired subtree.
  if (hints.styleIds === true) {
    const ids = styleIdsInExport(n)
    if (ids.length > 0) {
      candidate.styleIds = ids
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
  /**
   * The scan START this entry descends from, by index (search-scan.ts).
   *
   * Optional so a fixture describing ONE subtree can leave it out; absent
   * means "one root", which is what a node- or page-scoped scan is.
   */
  root?: number
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

/**
 * What a main component is called, from whichever side answered (B56).
 *
 * `setName` is the COMPONENT_SET's name when the main is a variant — the name
 * `match:{instancesOf}` is usually written against, since it is the only one a
 * human ever sees.
 */
export type ComponentRef = {
  key?: string
  name?: string
  setName?: string
}

/**
 * One `exportAsync({format:'JSON_REST_V1'})` result, as much of it as the
 * repair reads.
 *
 * The export is `{document, components, componentSets, …}`, and this pass used
 * to keep only `document`. That is what left an export-served INSTANCE unable
 * to name its main: the node carries `componentId`, and the NAME that id
 * stands for is in the `components` map beside it — `{key, name,
 * componentSetId}`. `componentSets` closes the same gap one level up, for the
 * family name.
 */
export type ExportedHost = {
  document: RawNode
  /** componentId → {key, name, componentSetId}, as REST spells it. */
  components?: Record<
    string,
    {
      key?: unknown
      name?: unknown
      componentSetId?: unknown
    }
  >
  /** componentSetId → {name}. */
  componentSets?: Record<string, { name?: unknown }>
}

export type RepairInput = {
  scanned: ScanEntry[]
  /** One slot per `scanned` entry; undefined where the candidate build threw. */
  candidates: (Candidate | undefined)[]
  failures: ScanFailure[]
  hints?: CandidateHints
  /** The host's export, or undefined when it cannot describe itself. */
  exportHost: (
    index: number,
  ) => Promise<ExportedHost | undefined>
  /**
   * A main component's names and key, by its node id — the FALLBACK for when
   * the export's own `components` map does not name it (B56).
   *
   * The map is preferred: it arrives with an export that already had to be
   * paid for, it needs no live handle, and a degraded handle cannot defeat it.
   * This resolver covers a runtime whose subtree export omits the maps.
   * Omitting BOTH leaves an export-served row unmatched by those keys, exactly
   * as before — and the trade warning then says so.
   */
  componentRefOf?: (
    componentId: string,
  ) => Promise<ComponentRef | undefined>
  /**
   * Cap on how many subtrees may be serialized PER SCAN ROOT (T10).
   *
   * Per root, not per scan. A document scan starts once per top-level node of
   * every page, and a single shared cap is spent in scan order — so the pages
   * that happen to be scanned first take all of it and the pages after them
   * come back short. That is not a hypothesis: on the 2026-09-01 artifact the
   * document scan returned 1477 rows against 1646 from the same four pages
   * scanned one at a time, and every one of the 195 missing rows sat on the
   * last two pages, under 8 subtree roots, while the first two pages lost
   * nothing. The four pages needed 33 / 12 / 17 / 13 repairs against a shared
   * cap of 50: the first two pages spent 45 of it.
   *
   * The cap still bounds the work per subtree, which is what T10 is for. What
   * it no longer does is let one subtree's damage decide another's fidelity.
   */
  maxRepairs?: number
}

export type RepairOutput = {
  results: Candidate[]
  /** The failures no export covered, and the rows the repair had to trade. */
  warnings: string[]
  /**
   * Whether this result set is SHORT — a subtree the scan could not enter and
   * the repair could not recover (B72).
   *
   * A count taken off an incomplete set is a LOWER BOUND, and the caller has to
   * be able to test that without parsing warning prose. The 2026-08-30 document
   * scan lost 8% of instances, 13% of nodes and 17% of text while answering
   * `truncated:false`, and two rubric categories were driven to a false FAIL on
   * it — one of them a gate condition. Warnings alone were not enough: 192 of
   * them named 13 parents, and none of the 91 dropped TEXT nodes descended from
   * any of the 13.
   *
   * A TRADED row does not count. That row is present, only thinner, and it says
   * so on its own line.
   */
  incomplete: boolean
  /**
   * How many rows are PRESENT but thinner than they look (B85).
   *
   * `incomplete` says the set is short. This says the set is complete and some
   * of its rows cannot answer `match:{styleId|context|componentKey|
   * instancesOf}` — which reads, from `results` alone, exactly like a node that
   * does not carry the style. An effect-style census answered `results: 1`
   * where three nodes carried the style and the two missing ones were plainly
   * glowing in the export, and the reply said so only in prose. A count is
   * testable; prose is not.
   *
   * Zero once every trade carries its keys over, which is the common case now.
   */
  degraded: number
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
  stylesResolvable: boolean,
): string[] =>
  LIVE_ONLY_KEYS.filter(
    k =>
      c[k] !== undefined &&
      !(
        refsResolvable &&
        (k === 'componentKey' || k === 'instancesOf')
      ) &&
      // B85 — `styleIds` stops counting as lost once the export names style
      // references in this subtree: the row's export twin carries its own, so
      // `match:{styleId}` finds the node under the id the file uses. An export
      // that names none anywhere cannot answer for the key, and then the count
      // must keep saying so.
      !(stylesResolvable && k === 'styleIds'),
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
  /** componentId → its names and key, from every export folded so far (B56). */
  const exportRefs = new Map<string, ComponentRef>()
  /**
   * Whether a component reference can be recovered for an export-served row —
   * from the export's own maps, or from the live resolver. It decides only
   * whether the trade warning still calls those keys LOST. Read at the point of
   * use, because the maps fill in as hosts are exported.
   */
  const refsResolvable = (): boolean =>
    componentRefOf !== undefined || exportRefs.size > 0
  /**
   * Whether an export-served row in this repair can answer
   * `match:{styleId}` (B85) — i.e. some host's export actually named a style
   * reference. Read at the point of use, like `refsResolvable`: it becomes
   * true as hosts are exported.
   */
  let exportNamedStyles = false
  const covered = new Set<number>()
  const superseded = new Set<number>()
  /** Rows whose live-only keys rode over to their export twin (B85). */
  const carried = new Set<number>()
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

  /** How many repairs each scan ROOT has spent, and what it could not reach. */
  const spent = new Map<number, number>()
  /** root index → hosts the budget refused, so the cut can be ITEMISED. */
  const cutBy = new Map<number, number>()
  const rootOf = (host: number): number =>
    scanned[host]?.root ?? 0
  for (const host of hosts) {
    if (covered.has(host)) continue
    const root = rootOf(host)
    const used = spent.get(root) ?? 0
    if (used >= maxRepairs) {
      // This root is out of budget. Its remaining hosts are counted rather
      // than abandoned quietly, and the SCAN CONTINUES: the next root has its
      // own allowance, and stopping here is precisely what cost the last two
      // pages of the 2026-09-01 artifact 195 rows.
      cutBy.set(root, (cutBy.get(root) ?? 0) + 1)
      continue
    }
    spent.set(root, used + 1)
    const exported = await exportHost(host)
    if (exported === undefined) continue
    // Every ref the maps of THIS export can name, folded into the shared
    // lookup before the rows below are read. One export can name a component
    // another export cannot, so the lookup accumulates across hosts.
    foldExportRefs(exported, exportRefs)

    const entry = scanned[host]
    const fromExport = candidatesFromExport(
      exported.document,
      entry.levelsLeft,
      hints,
    )
    // An export that describes nothing cannot speak for anything. Superseding
    // on the strength of it would delete the subtree from the results and put
    // nothing back — and silence the failures too, since `covered` is what
    // decides that. Leave the scan exactly as it was.
    if (fromExport.length === 0) continue
    if (fromExport.some(c => c.styleIds !== undefined)) {
      exportNamedStyles = true
    }

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

    // B85 — the HOST's own live row donates the four keys an export cannot
    // carry. `fromExport[0]` IS this host, named the way the file names it, so
    // the two rows are the same node under two spellings and the pairing needs
    // no guessing. It is the row the trade actually cost: an effect-style
    // census read `results: 1` where three nodes carried the style, because the
    // two carriers inside repaired subtrees came back from the export with no
    // `styleIds` for `match:{styleId}` to test. Only the host — a deeper alias
    // row has no export twin this pass can identify, and guessing one would put
    // a node's styles on a different node.
    const hostRow = candidates[host]
    if (hostRow !== undefined && !exportIds.has(entry.id)) {
      for (const key of LIVE_ONLY_KEYS) {
        if (
          hostRow[key] !== undefined &&
          fromExport[0][key] === undefined
        ) {
          fromExport[0][key] = hostRow[key]
        }
      }
      carried.add(host)
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
        const lost = carried.has(i)
          ? []
          : liveOnlyKeysOf(
              liveRow,
              refsResolvable(),
              exportNamedStyles,
            )
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

  // B56 — trade each export row's main component ID for the names and key the
  // matcher runs on. The export's OWN maps answer first (`exportRefs`, folded
  // above); the live resolver is asked only for an id no export named, and
  // only ONCE per distinct component — a repaired card holds many instances of
  // few masters. The marker is deleted either way, so no row ever leaves
  // carrying it.
  const asked = new Map<string, ComponentRef | undefined>()
  for (const candidate of rescanned) {
    const mainId = candidate[MAIN_COMPONENT_ID]
    if (typeof mainId !== 'string') continue
    delete candidate[MAIN_COMPONENT_ID]
    let ref = exportRefs.get(mainId)
    if (
      ref?.name === undefined &&
      componentRefOf !== undefined
    ) {
      if (!asked.has(mainId)) {
        asked.set(
          mainId,
          // A main that refuses to resolve costs this row its ref keys and
          // nothing else — the row itself is still returned.
          await componentRefOf(mainId).catch(
            () => undefined,
          ),
        )
      }
      ref = asked.get(mainId) ?? ref
    }
    if (ref?.name !== undefined) {
      candidate.instancesOf = ref.name
    }
    if (ref?.key !== undefined) {
      candidate.componentKey = ref.key
    }
    // The family name, so `match:{instancesOf:'State block'}` reaches a
    // variant whose own name is `State=Error`.
    if (ref?.setName !== undefined) {
      candidate.instancesOfSet = ref.setName
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
  let incomplete = cutBy.size > 0
  for (const failure of failures) {
    const isCovered =
      failure.at >= 0
        ? covered.has(failure.at)
        : failure.host >= 0 && covered.has(failure.host)
    if (!isCovered) {
      warnings.push(failure.message)
      // B72 — the set is SHORT, and that is a fact about the numbers, not a
      // line of prose. Warnings under-named the loss by construction: a node
      // whose parent refused `get_children` never got an entry, so nothing
      // could name it.
      incomplete = true
    }
  }
  // The cut is ITEMISED, one line per scan root that hit the cap (B72). A
  // single "the budget stopped me" line said the set was short and left the
  // caller no way to find out where: 195 rows went missing under 8 subtrees on
  // two named pages, and the reply named none of them. Each line carries the
  // root's own id, so `scope:'node'` on it recovers exactly what was lost.
  for (const [root, unreached] of cutBy) {
    warnings.push(
      'search: stopped repairing under ' +
        (scanned[root]?.id ?? '(unknown root)') +
        ' after ' +
        maxRepairs +
        ' subtrees (the per-root budget) — ' +
        unreached +
        ' more degraded subtree(s) there are MISSING from these results. ' +
        'Re-scan that subtree on its own (scope:"node", nodeId:"' +
        (scanned[root]?.id ?? '…') +
        '") to see the rest.',
    )
  }
  // …and what the repair itself cost, after what it could not repair.
  for (const message of traded) {
    warnings.push(message)
  }
  // B85 — one line per thinned row is already in `warnings`; this is the same
  // fact as a number, so a completeness check can test it the way it tests
  // `truncated`.
  return {
    results,
    warnings,
    incomplete,
    degraded: traded.length,
  }
}
