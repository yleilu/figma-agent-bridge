// The agent's own-write window (change-feed.md, Plugin-side pipeline §1).
// Anchored at command EXIT (a command that awaits a font load mutates seconds
// after entry), refcounted so a nested `batch` never closes mid-run.

const ID_KEYS = new Set([
  'id',
  'ids',
  'nodeId',
  'nodeIds',
  'parentId',
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
 * `expanded`, when supplied, memoises the ancestor half for the lifetime of one
 * write window: an ancestor already enumerated is not enumerated again, which
 * turns an N-node create_tree into an O(N) walk instead of O(N²). The set union
 * is idempotent, so this changes cost, not content.
 */
export const reflowClosure = (
  node: BaseNode,
  expanded?: Set<string>,
): string[] => {
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

/** Ceiling on how long `depth > 0` alone may hold the window open. A command
 *  that enters and never exits — a `batch` op that throws inside code.ts's
 *  per-entry try/catch, say — would otherwise wedge the window OPEN forever,
 *  and a permanently-open window silently eats every later user edit to any
 *  node in the sets. The ceiling makes that self-healing: the window reverts to
 *  closed (fail-OPEN, the recoverable direction) and the next `enter` resets.
 *  Well above the slowest legitimate command; see Measurement A. */
export const MAX_OPEN_MS = 60_000

export type WriteScope = {
  /** Resolves to a ONE-SHOT disposer. Prefer
   *  `const done = await scope.enter(p); try { … } finally { done(result) }`
   *  over a bare `exit` — a skipped `exit` wedges the window. */
  enter(
    params: unknown,
  ): Promise<(result?: unknown) => void>
  exit(result: unknown): void
  isOpen(): boolean
  claim(node: BaseNode): void
  touched(): ReadonlySet<string>
  reflow(): ReadonlySet<string>
}

export const createWriteScope = (opts: {
  settleMs: number
  resolve: (id: string) => Promise<BaseNode | null>
  now?: () => number
  maxOpenMs?: number
}): WriteScope => {
  const now = opts.now ?? Date.now
  const maxOpenMs = opts.maxOpenMs ?? MAX_OPEN_MS
  let depth = 0
  let enteredAt = 0
  let closesAt = 0
  let touchedSet = new Set<string>()
  let reflowSet = new Set<string>()
  // "a closure has been computed for this id" — NOT the same as "touched".
  // `exit` adds return-harvested ids to `touched` with no closure walk, and
  // without this a later `enter` naming one of them would skip its closure.
  let foldedSet = new Set<string>()
  let expanded = new Set<string>()

  const isOpen = (): boolean =>
    (depth > 0 && now() - enteredAt < maxOpenMs) ||
    now() < closesAt

  const fold = async (id: string): Promise<void> => {
    touchedSet.add(id)
    if (foldedSet.has(id)) return
    foldedSet.add(id)
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
    for (const r of reflowClosure(node, expanded)) {
      reflowSet.add(r)
    }
  }

  const close = (result: unknown): void => {
    // Return-only ids get no closure: the node may already be gone, and
    // creates claim() their closure at creation instead.
    for (const id of harvestIds(result)) {
      touchedSet.add(id)
    }
    depth -= 1
    if (depth <= 0) {
      depth = 0
      closesAt = now() + opts.settleMs
    }
  }

  return {
    async enter(params) {
      if (!isOpen()) {
        depth = 0
        touchedSet = new Set()
        reflowSet = new Set()
        foldedSet = new Set()
        expanded = new Set()
      }
      depth += 1
      enteredAt = now()
      await Promise.all(harvestIds(params).map(fold))
      let disposed = false
      return result => {
        if (disposed) return
        disposed = true
        close(result)
      }
    },
    exit: close,
    isOpen,
    claim(node) {
      touchedSet.add(node.id)
      foldedSet.add(node.id)
      for (const r of reflowClosure(node, expanded)) {
        reflowSet.add(r)
      }
    },
    touched: () => touchedSet,
    reflow: () => reflowSet,
  }
}
