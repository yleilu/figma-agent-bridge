// rollback.ts — undo a multi-node create that threw partway through.
//
// overview.md: "Every single-target tool either fully succeeds or returns one
// error envelope — it never partially succeeds." A create_tree that dies on
// its second child breaks that twice over: the caller gets an error with no
// id, AND the document keeps the nodes the call did manage to build. It cannot
// clean up debris it was never told exists (B14), so the debris has to go.
//
// The sweep is BY IDENTITY. The ledger is the accumulator the builder filled
// as it went, so only nodes THIS call created are ever at risk — never a
// name match, never "everything on the page", never the node a `{ id }` child
// was cloned FROM. That distinction is the whole safety argument: a rollback
// that guessed would delete another session's work.
//
// Deepest-first, because removing an ancestor takes its descendants with it;
// the ids underneath it then resolve to nothing, which is a success, not a
// failure. The two are told apart by asking, not by assuming.

// What removal needs from a node. Figma's BaseNode satisfies it structurally,
// which is what keeps this module testable without a Figma runtime.
export type RemovableNode = {
  readonly removed: boolean
  remove: () => void
}

export const rollbackCreated = async (
  ids: string[],
  getNodeById: (
    id: string,
  ) => Promise<RemovableNode | null>,
): Promise<string[]> => {
  // The ids still standing when the sweep is done. A rollback that only half
  // worked must say so — an error envelope that implies a clean document when
  // it is not one is worse than the original failure, because the caller stops
  // looking.
  const stranded: string[] = []
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i] as string
    try {
      const node = await getNodeById(id)
      // Already gone: an ancestor removed earlier in this loop took it, or
      // the builder removed it on its own way out. Both are done, not failed.
      if (node !== null && !node.removed) {
        node.remove()
      }
    } catch {
      // One node refusing to go does not excuse the rest — keep sweeping and
      // report what stayed.
      stranded.push(id)
    }
  }
  return stranded
}
