// search-page-scope.ts — what `search({scope:'page'})` means when it names no
// page (I65).
//
// It used to mean `Page not found: undefined` — the id was forwarded as it
// arrived, `getNodeByIdAsync(undefined)` found nothing, and the error printed
// the missing value as if the caller had typed it. Four recordings.
//
// The neighbouring reader already answers this question: `inspect({pageId?})`
// omits the id to mean the CURRENT page (tool-surface.md). Two sibling reads
// with two different meanings for "this page" is the T1 failure, so `search`
// now answers it the same way — and SAYS SO, because a scope the caller did
// not state is a choice the tool made, and a silent choice is the shape this
// batch exists to remove.
//
// Structural, so the decision is testable without a Figma runtime.

/** The current page, as much of one as this decision reads. */
export type PageLike = { id: string; name: string }

export type PageScope = {
  /** The page to scan, or undefined when there is none to fall back to. */
  pageId?: string
  /** What the reply says when the tool chose the page (omitted otherwise). */
  note?: string
}

/**
 * Which page a `scope:'page'` search scans.
 *
 * An empty string counts as absent: it names no page any more than `undefined`
 * does, and forwarding it reproduces the original error with a blank in it.
 */
export const resolvePageScope = (
  pageId: string | undefined,
  currentPage: PageLike | undefined,
): PageScope => {
  if (pageId !== undefined && pageId !== '') {
    return { pageId }
  }
  if (currentPage === undefined) {
    return {}
  }
  return {
    pageId: currentPage.id,
    note:
      'search: scope "page" named no pageId, so the CURRENT page "' +
      currentPage.name +
      '" (' +
      currentPage.id +
      ') was scanned. Pass pageId to scan a different page, or ' +
      'scope:"document" to scan them all.',
  }
}
