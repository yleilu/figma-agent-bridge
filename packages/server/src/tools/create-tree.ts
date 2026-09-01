// tools/create-tree.ts — the M3 recursive create (REBUILD, replaces the legacy
// handleCreateTree in tools/create.ts).
//
// Consumes a TreeNodeSpec (a NodeSpec with recursive `children`, a ref-pool
// reference `{ ref }`, or a clone-by-id `{ id }`) plus an optional `refs`
// ref-pool. Converts every plain NodeSpec node on the grammar WRITE FACE via
// specToFigmaForCreate (atom leaves parsed; name ?? type fallback), recursing
// into children. `{ ref }` and `{ id }` nodes pass through as bare markers the
// plugin resolves (ref → re-convert refs[key]; id → clone the existing node).
//
// The CONVERTED tree is forwarded to COMMANDS.CREATE_TREE with { tree, parentId?,
// refs? } where `refs` is the converted ref-pool. The plugin walks the nested
// tree: creates each node by type, appendChild, then applyPostAppendProperties
// (FILL/ABSOLUTE) per level, loadFontAsync before text. Reports through
// formatMutationResult so a plugin {error} surfaces as an error.
//
// REF-POOL + ORDERING:
//   - `{ ref: key }`  → the plugin re-builds refs[key] (a fresh subtree each
//     reuse) — kept as a marker so a ref used N times yields N independent
//     subtrees, not N shared references to one node.
//   - `{ id: x }`     → the plugin clones the existing node x (COMPONENT →
//     INSTANCE, else .clone()).
//   - append-before-FILL ordering is NOT re-implemented here: the converter
//     produces the partitioned payload the plugin's three-phase apply already
//     honors (common props → appendChild → applyPostAppendProperties for
//     sizing FILL / layoutPositioning ABSOLUTE), and loadFontAsync runs before
//     any text write, exactly as create_node does — per level, depth-first.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type {
  TreeNodeSpec,
  RefPool,
  NodeSpec,
} from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import {
  specToFigmaForCreate,
  type FigmaWritePayload,
} from '../serialize/node-spec-writer'
import { CREATABLE_TYPES } from './create-node'
import { assertContextWithinCap } from '../serialize/context-cap'
import { sendConvertedWrite } from '../serialize/style-refs'
import {
  type ToolResult,
  formatMutationResult,
  isErrorResult,
  toolError,
  textResult,
} from './shared'

/** A `{ ref }` pool reference (re-built fresh on each reuse). */
const isRefNode = (
  spec: TreeNodeSpec,
): spec is { ref: string } & Record<string, unknown> =>
  'ref' in spec && typeof spec.ref === 'string'

/** A `{ id }` clone-by-id reference. */
const isCloneNode = (
  spec: TreeNodeSpec,
): spec is { id: string } & Record<string, unknown> =>
  'id' in spec &&
  typeof spec.id === 'string' &&
  !('type' in spec)

/**
 * What a caller wrote BESIDE a `{ ref }` or `{ id }` — the override half (B83).
 *
 * Only the fields the caller actually sent, so a bare marker answers `[]` and
 * takes every path it always took.
 */
const siblingKeysOf = (
  spec: Record<string, unknown>,
  marker: 'ref' | 'id',
): string[] => Object.keys(spec).filter(k => k !== marker)

/**
 * What a `{ id }` clone is told when it carries fields it cannot apply (B83).
 *
 * The `{ ref }` half of this defect is repaired by merging, because the server
 * holds the pooled spec and can. A clone's source is a node in the DOCUMENT and
 * the plugin's clone path applies no spec to it, so there is nothing here to
 * merge onto — and stripping the keys silently is exactly what cost twelve
 * icons their geometry. So it refuses, and names the two calls that work.
 */
export const cloneOverrideRejection = (
  id: string,
  keys: readonly string[],
): string =>
  'create_tree: {id:"' +
  id +
  '"} clones an existing node and applies no fields to it, so ' +
  keys.join(', ') +
  ' would be dropped. Clone it here, then set those fields with update_node ' +
  'on the returned id — or state the node in full instead of cloning it.'

/**
 * Recursively convert a TreeNodeSpec to a converted FigmaWritePayload tree.
 *
 * - `{ ref }` / `{ id }` markers pass through unchanged (the plugin resolves
 *   them at build time — ref re-builds refs[key], id clones node x).
 * - a plain node is converted via specToFigmaForCreate, then its `children`
 *   are recursively converted and re-attached.
 *
 * `warnings` is an optional sink: lossy conversions anywhere in the tree (e.g.
 * a `var()` wrapper the surface cannot bind) push onto it so the handler can
 * surface them.
 */
export const convertTree = (
  spec: TreeNodeSpec,
  warnings?: string[],
  refs?: RefPool,
): FigmaWritePayload => {
  if (isRefNode(spec)) {
    // B83 — the fields written beside the ref are the caller's overrides, and
    // they used to be stripped at the schema boundary: twelve icons came back
    // as a clean success with no geometry at all. The pooled spec is here, so
    // the merge happens here — the result is a plain node, which is what a ref
    // resolves to anyway, and it keeps the one-fresh-subtree-per-use rule
    // because each use converts its own copy.
    const overrides = siblingKeysOf(spec, 'ref')
    const pooled = refs?.[spec.ref]
    if (overrides.length === 0 || pooled === undefined) {
      // A bare ref, or a ref this call cannot resolve — the plugin owns the
      // "no such ref" error, and inventing a second one here would hide it.
      return { ref: spec.ref }
    }
    const merged: Record<string, unknown> = {
      ...(pooled as Record<string, unknown>),
      ...spec,
    }
    delete merged.ref
    return convertTree(
      merged as TreeNodeSpec,
      warnings,
      refs,
    )
  }
  if (isCloneNode(spec)) {
    const overrides = siblingKeysOf(spec, 'id')
    if (overrides.length > 0) {
      throw new Error(
        cloneOverrideRejection(spec.id, overrides),
      )
    }
    return { id: spec.id }
  }

  // A plain node: validate its type against the SAME CREATABLE_TYPES list
  // create_node uses (single source of truth — issue #2) so both create APIs
  // accept exactly the same node types. This rejects the unspecced
  // composite-via-children family (BOOLEAN_OPERATION, GROUP, TRANSFORM_GROUP)
  // with one clear error. `{ ref }` / `{ id }` nodes returned ABOVE this guard:
  // they reference/clone existing nodes (not new types) and pass through.
  const node = spec as NodeSpec & {
    children?: TreeNodeSpec[]
  }
  assertContextWithinCap(node)
  if (
    !(CREATABLE_TYPES as readonly string[]).includes(
      node.type,
    )
  ) {
    throw new Error(
      `Unsupported node type "${node.type}" in create_tree. ` +
        `Valid types: ${CREATABLE_TYPES.join(', ')}. ` +
        `(Booleans: create the shapes then use boolean_op.)`,
    )
  }
  const { children, ...flat } = node
  const converted = specToFigmaForCreate(flat, warnings)
  if (children !== undefined && children.length > 0) {
    converted.children = children.map(child =>
      convertTree(child, warnings, refs),
    )
  }
  return converted
}

// ─── I69 — no nested masters ─────────────────────────────────────────────────

/**
 * Refuse a COMPONENT nested inside another COMPONENT (I69).
 *
 * Figma has one master per component and no master inside a master. A tree that
 * states one cannot be built, and the question is only WHERE the caller learns
 * that. It is answered HERE, on the write face, because the answer is a
 * property of the SUBMITTED TREE alone: no read of the document can change it,
 * the walk costs no round trip, and a tree refused before its first node is a
 * tree that never half-built. The plugin's append refusal stays as the backstop
 * for the case this cannot see — a tree rooted at `parentId` that is itself
 * already inside a master.
 *
 * A COMPONENT is legal ANYWHERE ELSE in the tree, at any depth. Masters live
 * inside frames and sections all the time — that is how a library page is
 * organised — so the rule is about the ancestor CHAIN, not about the root.
 *
 * `{ ref }` is followed into the pool, because where a ref is USED is what
 * decides its legality: one pool entry may be a sibling of a master in one
 * place and a child of one in another. `refStack` stops a cyclic pool; the
 * cycle itself is the plugin's error to report, and this guard must only decline
 * to hang before the walk gets there.
 *
 * `{ id }` is exempt. A clone-by-id of a COMPONENT creates an INSTANCE (the
 * plugin's clone path), which is legal inside a master, and the type of an id
 * this face has never seen is not knowable here anyway.
 */
export const assertNoNestedComponent = (
  spec: TreeNodeSpec,
  refs?: RefPool,
  // The enclosing master's name, or undefined while outside one.
  enclosing?: string,
  refStack: readonly string[] = [],
): void => {
  if (isCloneNode(spec)) {
    return
  }
  if (isRefNode(spec)) {
    const target = refs?.[spec.ref]
    if (
      target === undefined ||
      refStack.includes(spec.ref)
    ) {
      return
    }
    assertNoNestedComponent(target, refs, enclosing, [
      ...refStack,
      spec.ref,
    ])
    return
  }
  const node = spec as NodeSpec & {
    children?: TreeNodeSpec[]
  }
  const label = node.name ?? node.type
  if (
    node.type === 'COMPONENT' &&
    enclosing !== undefined
  ) {
    throw new Error(
      `Cannot create the COMPONENT "${label}" inside the COMPONENT ` +
        `"${enclosing}": Figma has no nested masters. Build "${label}" as its ` +
        'own master — a sibling in this tree, or its own create_tree call — ' +
        'and place it here as an INSTANCE of it ' +
        "(`{type:'INSTANCE', component:{id:'<the master's id>'}}`, or the " +
        '`{id}` clone marker, which also creates an instance). To leave a ' +
        'fillable hole in this master instead, add a slot with ' +
        'update_component({slots}).',
    )
  }
  const inside =
    node.type === 'COMPONENT' ? label : enclosing
  for (const child of node.children ?? []) {
    assertNoNestedComponent(child, refs, inside, refStack)
  }
}

/** Convert every entry of the ref-pool to its converted payload form. */
const convertRefs = (
  refs: RefPool,
  warnings?: string[],
): Record<string, FigmaWritePayload> => {
  const out: Record<string, FigmaWritePayload> = {}
  for (const [key, value] of Object.entries(refs)) {
    out[key] = convertTree(value, warnings)
  }
  return out
}

/**
 * The tool-surface reply: `{root, ids[]}` (tool-surface.md). The plugin builds
 * N nodes and answers in the create_node family (`{id,name,type}`) plus the
 * `ids[]` it collected as it built; the tool surface is where that becomes the
 * declared shape, so the two cannot disagree about it in two places.
 *
 * `ids[]` is EVERY node this call created — the root first, then depth-first in
 * creation order — which is the whole point: a tree's non-root nodes are
 * otherwise unaddressable without a follow-up read.
 *
 * A plugin that reports no `ids` gets the root alone AND a warning (T7): the
 * agent is told its harvest is incomplete rather than being handed a short list
 * that looks complete.
 */
const shapeReply = (
  result: {
    error?: string
    id?: string
    name?: string
    type?: string
    ids?: string[]
    warnings?: string[]
  } | null,
  warnings: string[],
):
  | (Record<string, unknown> & { error?: string })
  | null => {
  if (
    result === null ||
    result.error !== undefined ||
    result.id === undefined
  ) {
    return result
  }
  // `warnings` is pulled out here and put back by the CALLER, which owns the
  // merged list. It must not be spread from `rest` as well, or every degrade
  // would be reported twice.
  const {
    id,
    name,
    type,
    ids,
    warnings: pluginWarnings,
    ...rest
  } = result
  void pluginWarnings
  if (!Array.isArray(ids)) {
    warnings.push(
      'the plugin reported no created ids — only the root is addressable from this reply; re-read the subtree to address its children',
    )
  }
  return {
    ...rest,
    root: { id, name, type },
    ids: Array.isArray(ids) ? ids : [id],
  }
}

export const handleCreateTree = async (
  {
    tree,
    parentId,
    refs,
  }: {
    tree: TreeNodeSpec
    parentId?: string
    refs?: RefPool
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const warnings: string[] = []
    // Before the first conversion: a nested master is a whole-tree property,
    // and a refusal that arrives after half the payload is built has already
    // cost the caller the round trip it was meant to save (I69).
    assertNoNestedComponent(tree, refs)
    const convertedTree = convertTree(tree, warnings, refs)
    const convertedRefs =
      refs !== undefined
        ? convertRefs(refs, warnings)
        : undefined
    // sendConvertedWrite walks the WHOLE payload — every node of the tree and
    // every ref-pool entry — against one style read, so a reference that
    // resolves to nothing stops the write before the first node is created,
    // not after forty of them.
    const result = (await sendConvertedWrite(
      client,
      COMMANDS.CREATE_TREE,
      {
        tree: convertedTree,
        parentId,
        refs: convertedRefs,
      },
      { warnings },
    )) as {
      error?: string
      id?: string
      name?: string
      type?: string
      ids?: string[]
      warnings?: string[]
    } | null

    // Plugin-side degrades (T7) join the server's own lossy-conversion notes in
    // ONE list. The plugin can only degrade at write time — a `sizing:['FILL',…]`
    // Figma refuses on a child of a SLOT, an x/y the auto-layout parent
    // overwrites, a stated size auto-layout hugged away (B61) — and the caller
    // sees a single reply for the whole subtree, so if these are not merged
    // here they are lost. The plugin's come FIRST, as they do on update_node:
    // they describe what happened to the document, the server's describe what
    // was wrong with the request.
    const fromPlugin = Array.isArray(result?.warnings)
      ? result.warnings
      : []

    // shapeReply may add one of its own (a plugin that reported no ids).
    const shaped = shapeReply(result, warnings)
    const allWarnings = [...fromPlugin, ...warnings]
    const mutation = formatMutationResult(
      shaped,
      'Failed to create tree.',
    )
    // (On error, formatMutationResult already returned the error envelope —
    // leave it clean.)
    if (
      allWarnings.length === 0 ||
      isErrorResult(mutation)
    ) {
      return mutation
    }
    // The degrades go in the reply's STRUCTURED `warnings[]`, the way
    // update_node has always put them — one concept, one surface. They used to
    // be appended as loose `Warning:` prose after the JSON, and B61's live gate
    // is what that cost: the plugin reported the discarded size, the JSON body
    // said nothing, and a caller reading the reply as data saw a clean build.
    // create_tree is the path that builds whole screens, so it is the worst
    // one to have had a second, weaker channel.
    return textResult(
      JSON.stringify(
        {
          ...(shaped as Record<string, unknown>),
          warnings: allWarnings,
        },
        null,
        2,
      ),
    )
  } catch (err) {
    return toolError(err)
  }
}
