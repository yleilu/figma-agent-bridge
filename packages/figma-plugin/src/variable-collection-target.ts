// variable-collection-target.ts — which collection a `create_variables` call
// means, and what it says when the answer is not one collection (I63).
//
// `create_variables` called `createVariableCollection(name)` unconditionally.
// A second call with the same name therefore made a SECOND collection, and
// nothing said so. That is the most-recorded item in the backlog (25
// recordings across four eras): a design system whose aliases must sit beside
// the raw tokens is literally unbuildable in one pass, because an alias needs
// a target id that does not exist until the first call returns — and the
// second call forks instead of appending.
//
// The rule this module encodes:
//
//   collectionId given  — that collection, exactly. An id that names nothing
//                         is a miss, never a fall-back to the name: a caller
//                         who addressed a collection by id did not ask for
//                         "something with a similar name".
//   name matches one    — EXTEND it, and say so. Extending is what the caller
//                         asked for on every recorded occasion.
//   name matches none   — create it. The original path, unchanged.
//   name matches many   — REFUSE. The file already carries forks of this name
//                         and picking the first is a coin toss the caller does
//                         not control — the same reasoning B66 applies to a
//                         shadowed variable name.
//
// Structural on both sides, so the decision is testable without a Figma
// runtime (`code.ts` cannot be imported outside Figma).

/** A local variable collection, as much of one as this decision reads. */
export type CollectionLike = {
  id: string
  name: string
}

/** How a call addressed its collection. */
export type CollectionAddress = {
  collectionId?: string
  collection?: string
}

/** What the call means, once the file has been consulted. */
export type CollectionTarget =
  /** Nothing carries this name — make it. */
  | { kind: 'create'; name: string }
  /** Add to this collection. */
  | { kind: 'extend'; id: string; name: string }
  /** The id names no collection in this file. */
  | { kind: 'missing'; id: string }
  /** The name names more than one, so it names none of them. */
  | { kind: 'ambiguous'; name: string; ids: string[] }
  /** Neither an id nor a name was given. */
  | { kind: 'unaddressed' }

/**
 * Resolve the collection a `create_variables` call targets.
 *
 * `collectionId` wins over `collection` when both are given: an id is exact
 * and a name is a lookup, so honouring the name over the id would silently
 * demote the stronger address.
 */
export const resolveCollectionTarget = (
  address: CollectionAddress,
  collections: readonly CollectionLike[],
): CollectionTarget => {
  const { collectionId, collection } = address
  if (collectionId !== undefined) {
    const found = collections.find(
      c => c.id === collectionId,
    )
    return found === undefined
      ? { kind: 'missing', id: collectionId }
      : {
          kind: 'extend',
          id: found.id,
          name: found.name,
        }
  }
  if (collection === undefined) {
    return { kind: 'unaddressed' }
  }
  const matches = collections.filter(
    c => c.name === collection,
  )
  if (matches.length === 0) {
    return { kind: 'create', name: collection }
  }
  if (matches.length === 1) {
    return {
      kind: 'extend',
      id: matches[0].id,
      name: matches[0].name,
    }
  }
  return {
    kind: 'ambiguous',
    name: collection,
    ids: matches.map(c => c.id),
  }
}

/**
 * What an EXTEND says.
 *
 * The call still reads like a create, so the reply must say which of the two
 * things it did. It also names the escape: a caller who genuinely wants a
 * separate collection gives it a separate name, and a caller facing forks that
 * already exist addresses one by id.
 */
export const extendedCollectionWarning = (
  name: string,
  id: string,
): string =>
  'create_variables added these variables to the existing collection "' +
  name +
  '" (' +
  id +
  ') instead of creating a second one with the same name. Pass ' +
  'collectionId to target a collection exactly, or a different `collection` ' +
  'name to start a new one.'

/**
 * What a name already inside the TARGET collection says.
 *
 * This is the fork one level down: a second `brand/primary` in one collection
 * makes the name ambiguous inside the very scope Figma says a name is unique
 * in. `create_variables` creates; changing a value is `update_variables`, and
 * naming it here is the difference between a dead end and a next call.
 */
export const duplicateVariableWarning = (
  name: string,
  collectionName: string,
): string =>
  'variable "' +
  name +
  '" already exists in "' +
  collectionName +
  '" and was NOT created again — a second variable of the same name in one ' +
  'collection makes the name ambiguous. Change its value with ' +
  'update_variables, or create it under a different name.'

/** What an ambiguous collection NAME says, listing every id it could mean. */
export const ambiguousCollectionError = (
  name: string,
  ids: readonly string[],
): string =>
  'more than one variable collection is named "' +
  name +
  '" in this file (' +
  ids.join(', ') +
  '), so the name addresses none of them. Pass collectionId to say which one ' +
  'to extend, or delete_variables the forks first.'
