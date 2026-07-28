// Where each session's own writes are known (change-feed.md, Plugin-side
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
//
// Each generation is tagged with its WRITER, because one plugin serves every
// session on the file. Generations INTERLEAVE rather than nest — a peer's
// dispatch can open, seal and be evicted inside the lifetime of this one's —
// so the refcount, the idle ceiling and the eviction ring are all scoped to
// the writer. A SHARED ring would hand one session control of another's
// correctness: a peer's burst would evict a quieter session's generations
// after a handful of commands it did not issue, and that session's own
// deferred events would return to it as foreign at a rate its peer sets. The
// memory bound is the product RETAINED_COMMANDS x RETAINED_WRITERS, which is
// what makes per-writer scoping affordable.
import {
  COMMANDS,
  isEventCausing,
} from '@figma-agent-bridge/shared/commands'
import {
  MAX_DISPATCH_MS,
  RETAINED_COMMANDS,
  RETAINED_WRITERS,
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

/**
 * The writer of a dispatch that carries no `meta.sessionId` — the identity
 * hook absent. A reserved literal, and the SAME one the server's count mirror
 * keys its sentinel file on, so the degraded route keeps exactly the
 * single-agent behaviour: that server subtracts this writer.
 *
 * It is resolved ONCE, where the message arrives, and threaded from there.
 * There is deliberately no default on `enter` / `exit` / `claim`: a creating
 * path that forgot to thread the writer must be a COMPILE ERROR, because a
 * runtime fallback would restore exactly the silence this design refuses — a
 * node claimed under whichever session happened to dispatch in the meantime.
 */
export { UNATTRIBUTED } from '@figma-agent-bridge/shared/change-feed'

export type WriteScope = {
  /** Called on entry to every command dispatch, including each nested batch
   *  op, with the WRITER it belongs to. Refcounted PER WRITER; that writer's
   *  outermost EVENT-CAUSING entry OPENS a generation tagged with it and
   *  harvests the command's PARAMS, capturing the reflow closure of every id
   *  they name while those nodes still exist. A read-only command refcounts
   *  and harvests nothing — a pure read emits no event, so it has nothing to
   *  suppress and its reach would be pure over-claim.
   *
   *  Resolves to a ONE-SHOT disposer that remembers its writer. Prefer
   *  `const done = await scope.enter(w, cmd, p); try { … } finally { done(r) }`
   *  over a bare `exit` — a skipped exit holds the generation open until
   *  MAX_DISPATCH_MS force-seals it. */
  enter(
    writer: string,
    command: string,
    params: unknown,
  ): Promise<(result?: unknown) => void>
  /** Called ONCE per enter, when that dispatch settles. Harvests the RETURN
   *  into that WRITER's open generation. Refcounted; when that writer's count
   *  returns to 0 its generation is SEALED — it stops growing and stays
   *  RETAINED. */
  exit(writer: string, result: unknown): void
  /** True while ANY writer has a dispatch in flight, and no dispatch counts
   *  as in flight for longer than MAX_DISPATCH_MS. Governs the CONTEXT SLOTS
   *  only — node and style membership is decided by the masks alone. */
  inFlight(): boolean
  /** Called by every node-CREATING code path at the moment of creation, with
   *  the DISPATCH's writer. A generic param walk cannot recover ids that do
   *  not exist when the command is dispatched.
   *
   *  The writer is a PARAMETER, never inferred from whatever is open:
   *  dispatches suspend at every await, so a node created after a font load
   *  would be claimed under whichever session dispatched in the meantime —
   *  and that misattribution lands on the SILENCE side. */
  claim(writer: string, node: BaseNode): void
  /** The writers known to have touched this id — read over every writer's
   *  open generation and every retained one. Monotonic WITHIN a generation,
   *  and shrinking only by eviction. */
  writersOf(id: string): ReadonlySet<string>
  /** The writers whose writes can move this id's GEOMETRY without naming it.
   *  Read over the same generations. */
  reflowWritersOf(id: string): ReadonlySet<string>
}

/** One dispatch's harvest, tagged with the session that caused it. Sealed at
 *  that writer's exit, evicted by one of the three bounds. */
type Generation = {
  writer: string
  touched: Set<string>
  reflow: Set<string>
  /** ids whose closure has already been walked FOR THIS GENERATION — NOT the
   *  same as "touched": `exit` adds return-harvested ids with no walk. */
  folded: Set<string>
  /** `reflowClosure`'s ancestor memo, FOR THIS GENERATION. */
  expanded: Set<string>
}

/**
 * One writer's whole standing in the scope: its refcount, its idle clock and
 * its own ordered ring. Holding the ring per writer is what makes the three
 * bounds writer-scoped — RETAINED_COMMANDS evicts THAT writer's oldest sealed
 * generation, RETENTION_CEILING_MS releases THAT writer's whole set, and only
 * RETAINED_WRITERS crosses writers, and then only wholesale.
 */
type WriterState = {
  writer: string
  /** refcount over that writer's dispatches, reads included */
  depth: number
  /** when its depth went 0 → 1, i.e. when its current IN-FLIGHT INTERVAL
   *  began — which is also when the generation it belongs to opened, and what
   *  MAX_DISPATCH_MS is measured from. Its own overlapping dispatches SHARE
   *  it, so a run that never lets its refcount return to 0 is force-sealed as
   *  a whole rather than per dispatch. Only reachable past the server's own
   *  30 s dispatch timeout, by which point the caller has already given up. */
  depthSince: number
  /** its most recent enter(), ANY command */
  lastDispatchAt: number
  open: Generation | null
  /** oldest first */
  retained: Generation[]
}

/**
 * The membership index, rebuilt lazily: `admit` asks once per change and a
 * documentchange batch can carry hundreds against every retained generation,
 * so the walk is memoised and invalidated on every mutation and eviction.
 *
 * Keyed by WRITER, not by id. Inverting it — one set of writers per touched id
 * — would answer in O(1) but allocate a Set per id on every rebuild, and a
 * single create_tree puts thousands of ids in one generation. Keyed this way
 * the structure is exactly today's (one union set per writer, one writer in
 * the ordinary case) and a lookup costs one `has` per writer, of which there
 * are at most RETAINED_WRITERS.
 */
type Index = {
  /** writer → every id that writer touched, across its generations */
  touched: Map<string, Set<string>>
  /** writer → every id in that writer's reflow closures */
  reflow: Map<string, Set<string>>
  /** memoised answers: there are only as many distinct ones as there are
   *  writer subsets in play, and in the ordinary case exactly one. */
  answers: Map<string, ReadonlySet<string>>
}

const EMPTY: ReadonlySet<string> = new Set()

/** Writer names are opaque, so the memo key is separator-joined and the
 *  separator is one no platform session id carries — the same argument
 *  `writerKeyOf` makes in shared. */
const ANSWER_SEP = '\0'

export const createWriteScope = (opts: {
  resolve: (id: string) => Promise<BaseNode | null>
  now?: () => number
  retainedCommands?: number
  retentionCeilingMs?: number
  maxDispatchMs?: number
  retainedWriters?: number
}): WriteScope => {
  const now = opts.now ?? Date.now
  const retainedCommands =
    opts.retainedCommands ?? RETAINED_COMMANDS
  const retentionCeilingMs =
    opts.retentionCeilingMs ?? RETENTION_CEILING_MS
  const maxDispatchMs =
    opts.maxDispatchMs ?? MAX_DISPATCH_MS
  const retainedWriters =
    opts.retainedWriters ?? RETAINED_WRITERS

  const states = new Map<string, WriterState>()
  let cache: Index | null = null

  const stateFor = (writer: string): WriterState => {
    const held = states.get(writer)
    if (held !== undefined) return held
    const st: WriterState = {
      writer,
      depth: 0,
      depthSince: 0,
      lastDispatchAt: 0,
      open: null,
      retained: [],
    }
    states.set(writer, st)
    return st
  }

  const newGeneration = (writer: string): Generation => ({
    writer,
    touched: new Set(),
    reflow: new Set(),
    folded: new Set(),
    expanded: new Set(),
  })

  const seal = (st: WriterState): void => {
    if (st.open === null) return
    st.retained.push(st.open)
    st.open = null
    // `cache` is unaffected: the index is over retained + open either way.
  }

  const sealIfSettled = (st: WriterState): void => {
    if (st.depth === 0) seal(st)
  }

  /** A writer that holds nothing and is dispatching nothing is not a writer
   *  the scope has to remember — and leaving it in would spend a
   *  RETAINED_WRITERS slot on a session that has already let go. */
  const isSpent = (st: WriterState): boolean =>
    st.depth === 0 &&
    st.open === null &&
    st.retained.length === 0

  /** Evicts the WHOLE set of the writer that has been idle longest, never
   *  part of one: half-evicting a writer's ring would silently shorten its
   *  reach on somebody else's activity, which is the coupling per-writer
   *  scoping exists to remove. A writer with a dispatch IN FLIGHT is not
   *  idle, so it is chosen last. */
  const evictIdlestWriter = (keep: string): void => {
    const idle = (st: WriterState): boolean =>
      st.depth === 0
    let victim: WriterState | null = null
    for (const st of states.values()) {
      if (st.writer === keep) continue
      if (victim === null) {
        victim = st
        continue
      }
      const better =
        idle(st) === idle(victim)
          ? st.lastDispatchAt < victim.lastDispatchAt
          : idle(st)
      if (better) victim = st
    }
    if (victim === null) return
    states.delete(victim.writer)
    cache = null
  }

  /** Opens a generation for `st`, first evicting THAT writer's oldest sealed
   *  ones so that its retained + open never exceeds RETAINED_COMMANDS. THE
   *  memory bound, and what covers a deferred event: it advances only when
   *  THAT WRITER dispatches, so an event that lands long after its own
   *  command still finds it as long as its own session has not dispatched
   *  past it — and a peer's dispatch rate cannot spend it. */
  const openGeneration = (st: WriterState): Generation => {
    while (
      st.retained.length > 0 &&
      st.retained.length >= retainedCommands
    ) {
      st.retained.shift()
    }
    st.open = newGeneration(st.writer)
    cache = null
    if (states.size > retainedWriters) {
      evictIdlestWriter(st.writer)
    }
    return st.open
  }

  /** Every harvest path goes through this, so a `claim` or the late `exit` of
   *  a force-sealed dispatch opens a FRESH generation and folds into it —
   *  retained longer than its own would have been, which is the conservative
   *  side. */
  const ensureOpen = (st: WriterState): Generation =>
    st.open ?? openGeneration(st)

  /** All three bounds are evaluated ON READ. An idle plugin dispatches
   *  nothing, so there is nothing to wake up, and `admit` is the only
   *  reader. */
  const reap = (t: number): void => {
    for (const st of states.values()) {
      // A dispatch that never settles would otherwise leave a generation that
      // is neither counted out nor released, growing without bound as every
      // later command by that writer merged into it, with inFlight() true for
      // the rest of the session. Sealing on age degrades that to a leak.
      // FIRST, because it can make that writer idle, which the ceiling below
      // then acts on. It clears THAT writer's refcount only.
      if (
        st.depth > 0 &&
        t - st.depthSince >= maxDispatchMs
      ) {
        st.depth = 0
        seal(st)
      }
      // Keyed on THAT WRITER's idle time since its last dispatch, never on a
      // generation's own age: while a session keeps working none of its
      // generations is released and retainedCommands alone decides; once it
      // stops, its whole retained set lets go together. Age-keying would
      // expire generations mid-task and collapse this into a wall-clock
      // window with a bigger constant — the bug this design replaces. A peer
      // working does NOT hold an idle session's claims open.
      if (
        st.depth === 0 &&
        st.retained.length > 0 &&
        t - st.lastDispatchAt >= retentionCeilingMs
      ) {
        st.retained.length = 0
        cache = null
      }
      if (isSpent(st)) states.delete(st.writer)
    }
  }

  const rebuild = (): Index => {
    const touched = new Map<string, Set<string>>()
    const reflow = new Map<string, Set<string>>()
    for (const st of states.values()) {
      const t = new Set<string>()
      const r = new Set<string>()
      const fold = (g: Generation): void => {
        for (const id of g.touched) t.add(id)
        for (const id of g.reflow) r.add(id)
      }
      for (const g of st.retained) fold(g)
      if (st.open !== null) fold(st.open)
      touched.set(st.writer, t)
      reflow.set(st.writer, r)
    }
    cache = { touched, reflow, answers: new Map() }
    return cache
  }

  const index = (): Index => {
    reap(now())
    return cache ?? rebuild()
  }

  /** The writers whose set in `m` holds `id`. Map iteration is insertion-
   *  ordered and the index is rebuilt whole, so the answer — and therefore
   *  its memo key — is deterministic within one index. */
  const membersOf = (
    i: Index,
    m: Map<string, Set<string>>,
    kind: string,
    id: string,
  ): ReadonlySet<string> => {
    const names: string[] = []
    for (const [writer, ids] of m) {
      if (ids.has(id)) names.push(writer)
    }
    if (names.length === 0) return EMPTY
    const key = kind + ANSWER_SEP + names.join(ANSWER_SEP)
    const held = i.answers.get(key)
    if (held !== undefined) return held
    const answer: ReadonlySet<string> = new Set(names)
    i.answers.set(key, answer)
    return answer
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
    st: WriterState,
  ): void => {
    if (harvest) {
      // Return-only ids get no closure: the node may already be gone, and
      // creates claim() their closure at creation instead.
      const ids = harvestIds(result)
      if (ids.length > 0) {
        const g = ensureOpen(st)
        for (const id of ids) g.touched.add(id)
        cache = null
      }
    }
    // Clamped: a forced seal has already zeroed the refcount, and a late exit
    // driving it negative would break inFlight() for the rest of the session.
    st.depth = Math.max(0, st.depth - 1)
    sealIfSettled(st)
    cache = null
  }

  return {
    async enter(writer, command, params) {
      const t = now()
      reap(t)
      const st = stateFor(writer)
      // Refreshed by EVERY enter of THIS writer, reads included: a session
      // that is reading is still working and has not handed over. A peer's
      // enter does not refresh it — hand-over is session-scoped.
      st.lastDispatchAt = t
      if (st.depth === 0) st.depthSince = t
      st.depth += 1
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
        const g = ensureOpen(st)
        if (harvest) {
          await Promise.all(
            harvestIds(params).map(id => fold(g, id)),
          )
        }
      }
      let disposed = false
      // The disposer remembers ITS OWN writer: by the time a dispatch
      // settles, any number of other sessions may have dispatched.
      return result => {
        if (disposed) return
        disposed = true
        close(harvest, result, st)
      }
    },
    // Bare `exit` treats its dispatch as event-causing: it has no command to
    // classify by, and over-claiming reach is the conservative direction.
    exit: (writer, result) =>
      close(true, result, stateFor(writer)),
    inFlight() {
      reap(now())
      for (const st of states.values()) {
        if (st.depth > 0) return true
      }
      return false
    },
    claim(writer, node) {
      const st = stateFor(writer)
      const g = ensureOpen(st)
      g.touched.add(node.id)
      g.folded.add(node.id)
      foldClosure(g, node)
      cache = null
      sealIfSettled(st)
    },
    writersOf(id) {
      const i = index()
      return membersOf(i, i.touched, 't', id)
    },
    reflowWritersOf(id) {
      const i = index()
      return membersOf(i, i.reflow, 'r', id)
    },
  }
}
