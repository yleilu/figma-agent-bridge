// search-scan.ts — the SEARCH walk, and WHO speaks for a subtree it cannot
// enter (B62).
//
// The walk itself is a depth-bounded DFS over live handles. Every read inside
// it is guarded, because a document-wide scan crosses nodes whose addresses
// Figma composed from a stale id (see canonical-ids.ts) and those handles
// refuse. The guard was never the defect. WHO THE FAILURE NAMES AS ITS HOST
// was.
//
// A node written into a component SLOT keeps its pre-append id — live
// `487:9419` where the export says `I487:9331;487:8143;487:9497`. Figma still
// composes that node's children off the id the handle answers, so a child comes
// back addressed `I487:9419;487:8704` while the file calls it
// `I487:9331;487:8143;487:9497;487:8704`. The fabricated address names no node.
//
// What makes it hard to see is HOW MUCH of such a handle still answers. It
// answers `id`, `name`, `type` and its size — enough to build a complete-looking
// candidate — and refuses exactly one read: `get_children`. So the scan emitted
// a row under an id that no read can resolve, lost the whole subtree under it,
// and reported the loss as a warning.
//
// The warning then never cleared, because the failure named THAT NODE as the
// host whose export could describe it. A node that refuses `get_children`
// refuses `exportAsync` too — it is the same non-existent address — so the
// repair asked the one party guaranteed not to answer. 89 warnings on the QA
// artifact, every one of them permanent.
//
// A subtree's host is therefore the node it was reached THROUGH, never the node
// that failed. That ancestor read fine (the walk got its children from it), it
// is the alias root itself, and its export names every node beneath it
// canonically — which supersedes the fabricated row and puts the real subtree
// back.
//
// Structural on both sides (`Record<string, unknown>`), so the walk is testable
// without a Figma runtime — which is the point, since `code.ts` cannot be
// imported outside Figma.

import { type ScanFailure } from './search-candidates'

/**
 * One node the walk visited, in DFS order.
 *
 * `subtreeEnd` closes the node's own range in the scan (`[index, subtreeEnd)`),
 * which is what makes "everything under this node" a slice rather than a second
 * traversal. `parentIndex` is the node this one was reached THROUGH, or -1 for
 * a start node — the only ancestor a failure can name.
 */
export type ScannedNode<N> = {
  node: N
  id: string
  levelsLeft: number
  parentIndex: number
  subtreeEnd: number
  /**
   * The scan START this node descends from, by index — itself for a start.
   *
   * A document scan starts once per top-level node of every page, and the
   * repair budget is spent in scan order, so the pages scanned FIRST spend it
   * all. Live 2026-09-01: a document scan returned 1477 rows where the same
   * four pages returned 1646 one page at a time, and all 195 lost rows sat on
   * the LAST TWO pages (Payments 44, Counterparties 151) with none on the
   * first two — the signature of an in-order budget, not of a scan defect.
   * The root is what lets the budget be spent per subtree and what lets a cut
   * NAME where it happened (B72).
   */
  root: number
}

export type ScanOutput<N> = {
  scanned: ScannedNode<N>[]
  failures: ScanFailure[]
}

/** What a warning calls a node whose own id would not read. */
export const UNREADABLE_NODE = '(unreadable node)'

/** A throw, as the one line a warning can carry. */
export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/**
 * Walk `starts` and everything under them, `depth` levels deep.
 *
 * `depth` counts levels BELOW each start: `0` is the start nodes alone, `N`
 * descends N levels, and a negative value is unbounded — the same vocabulary
 * the search tool's `depth` uses.
 *
 * A node reachable two ways (overlapping selection roots) is listed ONCE but
 * still descended from the deeper request. Only the FIRST visit owns a range:
 * a second, deeper visit appends its finds after it, and widening the range to
 * swallow them would let one host supersede nodes that are not under it.
 *
 * TWO DIFFERENT HANDLES ANSWERING ONE ID is a different thing, and it is a
 * loss: the second row never reaches `results`. It is named as a failure so
 * the repair can put it back from the host's export. Object identity is what
 * separates the two cases — the same handle twice is the paragraph above.
 */
export const scanFrom = <N extends object>(
  starts: Iterable<N>,
  depth: number,
): ScanOutput<N> => {
  const scanned: ScannedNode<N>[] = []
  const failures: ScanFailure[] = []
  /** id → its entry in `scanned`, which is also the dedup set. */
  const seen = new Map<string, number>()

  const collect = (
    node: N,
    levelsLeft: number,
    parentIndex: number,
  ): void => {
    // Structural, so the walk runs against a Figma `SceneNode` and against a
    // fake alike. Every access below is a getter call on a live handle, which
    // is exactly what can throw.
    const handle = node as {
      id: string
      children?: ArrayLike<N>
    }
    // `node.id` is the FIRST touch of the node, so it is inside the guard like
    // every other read — a throw here would lose the whole scan, and a node
    // that cannot even be identified cannot be deduped, addressed or returned.
    let id: string
    try {
      id = handle.id
    } catch (err) {
      failures.push({
        at: -1,
        host: parentIndex,
        message:
          'search: skipped ' +
          UNREADABLE_NODE +
          ': ' +
          messageOf(err),
      })
      return
    }
    const already = seen.get(id)
    const fresh = already === undefined
    const index = fresh ? scanned.length : already
    if (fresh) {
      seen.set(id, index)
      scanned.push({
        node,
        id,
        levelsLeft,
        parentIndex,
        subtreeEnd: index + 1,
        // A start owns itself; everything else inherits the start it was
        // reached through. `parentIndex` is always an EARLIER entry, so the
        // chain is already resolved by the time this reads it.
        root:
          parentIndex === -1
            ? index
            : scanned[parentIndex].root,
      })
    } else if (scanned[already].node !== node) {
      // TWO DIFFERENT HANDLES, ONE ID. The dedup above keeps the first and
      // drops the second, and it dropped it in silence: the row never reached
      // `results` and no failure named it. A repeat visit of the SAME handle
      // is the documented overlapping-roots case and is not a loss, so object
      // identity is the discriminator.
      //
      // NOT the mechanism behind the 2026-09-01 loss — that artifact carried
      // 1646 rows under 1646 distinct ids, so nothing collided (see the root
      // field above). This closes the hole rather than reporting a finding:
      // named as a failure with the ancestor as host, the repair exports that
      // ancestor and the export names both nodes canonically, which puts the
      // dropped one back.
      failures.push({
        at: -1,
        host: parentIndex,
        message:
          'search: two nodes answered the id ' +
          id +
          '; only the first is in these results',
      })
    }
    if (levelsLeft !== 0) {
      let children: N[] = []
      let refusal: unknown
      let refused = false
      try {
        if ('children' in node) {
          children = Array.from(
            handle.children as ArrayLike<N>,
          )
        }
      } catch (err) {
        refusal = err
        refused = true
        children = []
      }
      if (refused) {
        failures.push({
          at: index,
          // B62 — the ancestor, NEVER this node. A handle that refuses
          // `get_children` is a fabricated address, and a fabricated address
          // refuses `exportAsync` just as flatly; naming it as its own host
          // asked the one party guaranteed not to answer, so the warning could
          // never clear and the subtree stayed lost. The node we were reached
          // THROUGH read fine — its export names this whole subtree.
          host: parentIndex,
          message:
            'search: skipped the children of ' +
            id +
            ': ' +
            messageOf(refusal),
        })
      }
      for (const child of children) {
        collect(child, levelsLeft - 1, index)
      }
    }
    if (fresh) {
      scanned[index].subtreeEnd = scanned.length
    }
  }

  for (const start of starts) {
    collect(start, depth, -1)
  }
  return { scanned, failures }
}
