// Where the agent's own writes are known (change-feed.md, Plugin-side
// pipeline §1).
//
// Retention is keyed on the COMMAND, not on the clock. `documentchange`
// delivery is batched and unbounded — the runtime can defer a batch long past
// the exit of the command that caused it — so membership that expired on a
// timer failed OPEN: the deferred event landed after the window shut and the
// agent's own write was reported as the USER's. Every event-causing dispatch
// therefore opens a GENERATION holding its own touched set and reflow
// closure, and the scope keeps the most recent RETAINED_COMMANDS sealed
// generations. Membership is asked at EVENT time and answered from what is
// retained THEN: how long delivery took is not part of the question, only how
// much has happened since.
import {
  COMMANDS,
  isEventCausing,
} from '@figma-agent-bridge/shared/commands'
import {
  MAX_DISPATCH_MS,
  RETAINED_COMMANDS,
  RETENTION_CEILING_MS,
} from '@figma-agent-bridge/shared/change-feed'

const ID_KEYS = new Set([
  'id',
  'ids',
  'nodeId',
  'nodeIds',
  'parentId',
  // set_current_page / duplicate_page name their page here, and the page id
  // must reach `touched` or the agent's own page switch comes back as "the
  // user just switched page". Only `touched` — `reflowClosure` returns EMPTY
  // for a PAGE, so the page's CONTENTS do not ride in with it.
  'pageId',
  'root',
  'componentId',
  'instanceId',
])

/**
 * Every string reachable under an id-ish key, at any depth. Its failure mode is
 * a SMALLER touched set — the agent's own records then survive the filter and
 * surface as user edits: a false nudge, never a lost edit.
 */
export const harvestIds = (value: unknown): string[] => {
  const out: string[] = []
  const walk = (v: unknown, underIdKey: boolean): void => {
    if (typeof v === 'string') {
      if (underIdKey) out.push(v)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, underIdKey)
      return
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        walk(child, ID_KEYS.has(k))
      }
    }
  }
  walk(value, false)
  return out
}

/**
 * An id `resolve` may safely be handed. `harvestIds` scrapes every id-ish key,
 * and those keys carry more than plain scene-node ids:
 *   - a COMPOUND instance-child id ("I<inst>;<child>", e.g. a SLOT inside an
 *     instance) HANGS `getNodeByIdAsync` — live-verified, see
 *     `resolveParentNode` in code.ts — and `parentId` accepts one today, so a
 *     hang here would hang the whole command;
 *   - `update_styles` / `delete_styles` entries carry a style id ("S:…") and
 *     `delete_variables` carries "VariableID:…" / "VariableCollectionId:…",
 *     none of which are node ids at all.
 * Skipping them costs only the reflow CLOSURE — the id still enters `touched`,
 * which is the stronger of the two suppressions.
 */
const PLAIN_NODE_ID = /^\d+:\d+$/

const isAutoLayout = (n: BaseNode): boolean => {
  const m = (n as Partial<FrameNode>).layoutMode
  return m !== undefined && m !== 'NONE'
}

/** An auto-layout frame that can GROW along the axis its child grew on. */
const hugs = (n: BaseNode): boolean => {
  if (!isAutoLayout(n)) return false
  const f = n as Partial<FrameNode>
  // `layoutSizing*` is the shorthand that is applicable across HORIZONTAL,
  // VERTICAL *and* GRID. `primaryAxisSizingMode`/`counterAxisSizingMode` are
  // documented as applicable only when layoutMode is HORIZONTAL or VERTICAL
  // (@figma/plugin-typings, AutoLayoutMixin.layoutMode), so on a GRID frame —
  // which this repo ships (M12) with hug expressed through `layoutSizing*` —
  // they carry no defined meaning. Fall back to them only if the shorthand is
  // missing from the runtime.
  if (
    f.layoutSizingHorizontal !== undefined ||
    f.layoutSizingVertical !== undefined
  ) {
    return (
      f.layoutSizingHorizontal === 'HUG' ||
      f.layoutSizingVertical === 'HUG'
    )
  }
  return (
    f.primaryAxisSizingMode === 'AUTO' ||
    f.counterAxisSizingMode === 'AUTO'
  )
}

/** Bound on one closure walk. A TRUNCATED closure over-reports, never silences.
 *  IMPLEMENTATION GUARD, not spec: change-feed.md's closure definition carries
 *  no bound. Measurement B reports whether any real closure approaches it; if
 *  none does, delete it rather than leaving an unexercised constant behind. */
export const MAX_CLOSURE_NODES = 5000

/**
 * Nodes whose GEOMETRY an agent write can move without naming them:
 *   descendants(id) ∪ { each auto-layout ancestor A, walking UP:
 *                       children(A), plus A itself when A HUGS }
 * The two halves of the ancestor rule are NOT the same predicate:
 *   - ANY auto-layout parent re-flows its children — change one child's height
 *     in a FIXED-height VERTICAL stack and every following sibling's `y` moves
 *     — so `children(A)` always enters the closure;
 *   - only a parent that HUGS changes its OWN geometry, so only then is `A`
 *     itself a closure member and only then can the change propagate further
 *     up. A fixed-size frame absorbs the change: the walk stops there.
 *
 * A PAGE (and the DOCUMENT above it) is EMPTY. The closure's definition is "the
 * set of nodes whose geometry an agent write can move WITHOUT naming them", and
 * a page is not a scene node: it has no size, no position and no layout mode, so
 * appending to it, switching to it or cloning it re-flows nothing it contains.
 * `descendants(page)` taken literally is every node on the page — the same
 * swallow-every-top-level-frame outcome change-feed.md names as the thing the
 * ancestor rule is deliberately narrower than — and because `pageId` is a
 * harvest key, one `set_current_page` / `duplicate_page` / page-root create
 * would then subtract the cascade props off every user drag and resize on that
 * page, for the whole life of the generation. Silence, on the commonest user
 * action; the ancestor half is vacuous here anyway (a page's parent is the
 * DOCUMENT, which is not auto-layout).
 *
 * `expanded`, when supplied, memoises the ancestor half for the lifetime of one
 * GENERATION: an ancestor already enumerated is not enumerated again, which
 * turns an N-node create_tree into an O(N) walk instead of O(N²). The set union
 * is idempotent, so this changes cost, not content. It is per-generation and
 * never global — a memo shared across generations would let generation N skip
 * a walk generation 1 already did, and evicting generation 1 would then drop
 * that closure while the id is still touched.
 */
export const reflowClosure = (
  node: BaseNode,
  expanded?: Set<string>,
): string[] => {
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
    return []
  }
  const out = new Set<string>()
  const full = (): boolean => out.size >= MAX_CLOSURE_NODES
  const stack: BaseNode[] = [node]
  while (stack.length > 0 && !full()) {
    const n = stack.pop() as BaseNode
    const kids = (n as Partial<ChildrenMixin>).children
    if (kids === undefined) continue
    for (const k of kids) {
      if (full()) break
      out.add(k.id)
      stack.push(k)
    }
  }
  let a: BaseNode | null = node.parent
  while (a !== null && isAutoLayout(a) && !full()) {
    // An ancestor expanded earlier in this window was walked upward from at
    // that time too, so everything above it is already in the set.
    if (expanded?.has(a.id) === true) break
    expanded?.add(a.id)
    const hugging = hugs(a)
    if (hugging) out.add(a.id)
    for (const k of (a as unknown as ChildrenMixin)
      .children) {
      if (full()) break
      out.add(k.id)
    }
    if (!hugging) break
    a = a.parent
  }
  return [...out]
}

export type WriteScope = {
  /** Called on entry to every command dispatch, including each nested batch
   *  op. Refcounted; the outermost EVENT-CAUSING entry OPENS a generation and
   *  harvests the command's PARAMS, capturing the reflow closure of every id
   *  they name while those nodes still exist. A read-only command refcounts
   *  and harvests nothing — a pure read emits no event, so it has nothing to
   *  suppress and its reach would be pure over-claim.
   *
   *  Resolves to a ONE-SHOT disposer. Prefer
   *  `const done = await scope.enter(cmd, p); try { … } finally { done(r) }`
   *  over a bare `exit` — a skipped exit holds the generation open until
   *  MAX_DISPATCH_MS force-seals it. */
  enter(
    command: string,
    params: unknown,
  ): Promise<(result?: unknown) => void>
  /** Called ONCE per enter, when that dispatch settles. Harvests the RETURN.
   *  Refcounted; when the count returns to 0 the generation is SEALED — it
   *  stops growing and stays RETAINED. */
  exit(result: unknown): void
  /** True while a dispatch is in flight, and no dispatch counts as in flight
   *  for longer than MAX_DISPATCH_MS. Governs the CONTEXT SLOTS only — node
   *  and style membership is decided by `touched` / `reflow` alone. */
  inFlight(): boolean
  /** Called by every node-CREATING code path at the moment of creation. A
   *  generic param walk cannot recover ids that do not exist when the command
   *  is dispatched. */
  claim(node: BaseNode): void
  /** Ids the agent is known to have touched — the union over the open
   *  generation and every retained one. Monotonic WITHIN a generation, and
   *  shrinking only by eviction. */
  touched(): ReadonlySet<string>
  /** Ids whose GEOMETRY the agent's writes can move without naming them.
   *  Union over the same generations. */
  reflow(): ReadonlySet<string>
}

/** One dispatch's harvest. Sealed at exit, evicted by one of the two bounds. */
type Generation = {
  touched: Set<string>
  reflow: Set<string>
  /** ids whose closure has already been walked FOR THIS GENERATION — NOT the
   *  same as "touched": `exit` adds return-harvested ids with no walk. */
  folded: Set<string>
  /** `reflowClosure`'s ancestor memo, FOR THIS GENERATION. */
  expanded: Set<string>
}

export const createWriteScope = (opts: {
  resolve: (id: string) => Promise<BaseNode | null>
  now?: () => number
  retainedCommands?: number
  retentionCeilingMs?: number
  maxDispatchMs?: number
}): WriteScope => {
  const now = opts.now ?? Date.now
  const retainedCommands =
    opts.retainedCommands ?? RETAINED_COMMANDS
  const retentionCeilingMs =
    opts.retentionCeilingMs ?? RETENTION_CEILING_MS
  const maxDispatchMs =
    opts.maxDispatchMs ?? MAX_DISPATCH_MS

  let depth = 0 // refcount over ALL dispatches, reads included
  // When depth went 0 → 1, i.e. when the current IN-FLIGHT INTERVAL began —
  // which is also when the generation it belongs to opened, and what
  // MAX_DISPATCH_MS is measured from ("MAX_DISPATCH_MS after it opened").
  // Overlapping dispatches SHARE it, so a run that never lets the refcount
  // return to 0 is force-sealed as a whole rather than per dispatch. Only
  // reachable past the server's own 30 s dispatch timeout, by which point the
  // caller has already given up.
  let depthSince = 0
  let lastDispatchAt = 0 // the most recent enter(), ANY command
  let open: Generation | null = null
  const retained: Generation[] = [] // oldest first
  // `admit` asks touched() once per change and a documentchange batch can
  // carry hundreds against up to RETAINED_COMMANDS generations, so the union
  // is memoised: rebuilt lazily, invalidated on every mutation and eviction.
  let cache: {
    touched: Set<string>
    reflow: Set<string>
  } | null = null

  const newGeneration = (): Generation => ({
    touched: new Set(),
    reflow: new Set(),
    folded: new Set(),
    expanded: new Set(),
  })

  const seal = (): void => {
    if (open === null) return
    retained.push(open)
    open = null
    // `cache` is unaffected: the union is over retained + open either way.
  }

  const sealIfSettled = (): void => {
    if (depth === 0) seal()
  }

  /** Opens a generation, first evicting the oldest sealed ones so that
   *  retained + open never exceeds RETAINED_COMMANDS. THE memory bound, and
   *  what covers a deferred event: it advances only when commands are
   *  DISPATCHED, so an event that lands long after its own command still
   *  finds it as long as the agent has not dispatched past it. */
  const openGeneration = (): Generation => {
    while (
      retained.length > 0 &&
      retained.length >= retainedCommands
    ) {
      retained.shift()
    }
    open = newGeneration()
    cache = null
    return open
  }

  /** Every harvest path goes through this, so a `claim` or the late `exit` of
   *  a force-sealed dispatch opens a FRESH generation and folds into it —
   *  retained longer than its own would have been, which is the conservative
   *  side. */
  const ensureOpen = (): Generation =>
    open ?? openGeneration()

  /** Both bounds are evaluated ON READ. An idle plugin dispatches nothing, so
   *  there is nothing to wake up, and `admit` is the only reader. */
  const reap = (t: number): void => {
    // A dispatch that never settles would otherwise leave a generation that
    // is neither counted out nor released, growing without bound as every
    // later command merged into it, with inFlight() true for the rest of the
    // session. Sealing on age degrades that to a leak. FIRST, because it can
    // make the scope idle, which the ceiling below then acts on.
    if (depth > 0 && t - depthSince >= maxDispatchMs) {
      depth = 0
      seal()
    }
    // Keyed on IDLE TIME SINCE THE LAST DISPATCH, never on a generation's own
    // age: while the agent keeps working nothing is released and
    // retainedCommands alone decides; once the agent stops, the whole
    // retained set lets go together. Age-keying would expire generations
    // mid-task and collapse this into a wall-clock window with a bigger
    // constant — the bug this design replaces.
    if (
      depth === 0 &&
      retained.length > 0 &&
      t - lastDispatchAt >= retentionCeilingMs
    ) {
      retained.length = 0
      cache = null
    }
  }

  const rebuild = (): {
    touched: Set<string>
    reflow: Set<string>
  } => {
    const t = new Set<string>()
    const r = new Set<string>()
    const fold = (g: Generation): void => {
      for (const id of g.touched) t.add(id)
      for (const id of g.reflow) r.add(id)
    }
    for (const g of retained) fold(g)
    if (open !== null) fold(open)
    cache = { touched: t, reflow: r }
    return cache
  }

  const union = (): {
    touched: Set<string>
    reflow: Set<string>
  } => {
    reap(now())
    return cache ?? rebuild()
  }

  /** Walk the closure and union it in, never propagating a throw. A node
   *  REMOVED between resolve and the walk throws on `.children` / `.parent`,
   *  and both call sites sit in the COMMAND path: an unguarded throw in
   *  `claim` fails the user's command, and one in `fold` rejects `enter` and
   *  leaves the dispatch with no command-result at all. A partial closure
   *  over-reports (the agent's own records survive as user edits), which is
   *  this module's chosen failure direction throughout. */
  const foldClosure = (
    g: Generation,
    node: BaseNode,
  ): void => {
    try {
      for (const r of reflowClosure(node, g.expanded)) {
        g.reflow.add(r)
      }
    } catch {
      // the closure costs nothing but itself
    }
  }

  // `g` is captured by the CALLER before any await: a force-seal mid-await
  // must not misplace the harvest into whatever is open by then.
  const fold = async (
    g: Generation,
    id: string,
  ): Promise<void> => {
    g.touched.add(id)
    cache = null
    if (g.folded.has(id)) return
    g.folded.add(id)
    if (!PLAIN_NODE_ID.test(id)) return
    let node: BaseNode | null = null
    try {
      // EAGER: a node the command is about to DELETE cannot be resolved
      // afterwards, and deletion inside auto-layout is the largest reflow
      // producer there is.
      node = await opts.resolve(id)
    } catch {
      // A failed resolve costs the closure and nothing else. Capturing the
      // closure must never be able to break the command it is watching.
      return
    }
    if (node === null) return
    foldClosure(g, node)
    cache = null
  }

  const close = (
    harvest: boolean,
    result: unknown,
  ): void => {
    if (harvest) {
      // Return-only ids get no closure: the node may already be gone, and
      // creates claim() their closure at creation instead.
      const ids = harvestIds(result)
      if (ids.length > 0) {
        const g = ensureOpen()
        for (const id of ids) g.touched.add(id)
        cache = null
      }
    }
    // Clamped: a forced seal has already zeroed the refcount, and a late exit
    // driving it negative would break inFlight() for the rest of the session.
    depth = Math.max(0, depth - 1)
    sealIfSettled()
    cache = null
  }

  return {
    async enter(command, params) {
      const t = now()
      reap(t)
      // Refreshed by EVERY enter, reads included: an agent that is reading is
      // still working and has not handed over.
      lastDispatchAt = t
      if (depth === 0) depthSince = t
      depth += 1
      const eventCausing = isEventCausing(command)
      // `batch` OWNS the generation but harvests nothing itself. It
      // re-dispatches each op through the same switch, and each nested
      // `enter` folds that op's params and return under that OP's own
      // classification. The batch's own params are `{ops:[…]}` and its own
      // return is the per-op results — and `harvestIds` walks both at any
      // depth — so folding them here would claim every op's ids under
      // `batch`'s blanket event-causing classification. Redundant for the
      // write ops, and for a READ op it would take exactly the reach the
      // read-only rule refuses.
      const harvest =
        eventCausing && command !== COMMANDS.BATCH
      if (eventCausing) {
        const g = ensureOpen()
        if (harvest) {
          await Promise.all(
            harvestIds(params).map(id => fold(g, id)),
          )
        }
      }
      let disposed = false
      return result => {
        if (disposed) return
        disposed = true
        close(harvest, result)
      }
    },
    // Bare `exit` treats its dispatch as event-causing: it has no command to
    // classify by, and over-claiming reach is the conservative direction.
    exit: result => close(true, result),
    inFlight() {
      reap(now())
      return depth > 0
    },
    claim(node) {
      const g = ensureOpen()
      g.touched.add(node.id)
      g.folded.add(node.id)
      foldClosure(g, node)
      cache = null
      sealIfSettled()
    },
    touched: () => union().touched,
    reflow: () => union().reflow,
  }
}
